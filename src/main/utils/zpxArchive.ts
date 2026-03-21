/**
 * ZPX 归档工具模块
 *
 * ZPX 格式：compressed( asar archive )
 * 打包流程：目录 → asar.createPackage() → brotli 压缩 → .zpx 文件
 * 解压流程：.zpx 文件 → gzip/brotli 自动解压 → asar.extractAll() → 目标目录
 * 预览流程：.zpx 文件 → 自动解压到临时 .asar → asar.extractFile() 读取指定文件 → 清理临时文件
 */

import * as asar from '@electron/asar'
import {
  constants as zlibConstants,
  createBrotliCompress,
  createBrotliDecompress,
  createGunzip
} from 'zlib'
import { createReadStream, createWriteStream } from 'fs'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { pipeline } from 'stream/promises'

/** gzip 文件的 magic bytes：0x1f 0x8b */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])
/** zip 文件的 magic bytes：0x50 0x4b 0x03 0x04 */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/**
 * 生成唯一的临时文件路径（基于时间戳和随机数）
 * @param ext 文件扩展名
 * @returns 临时文件的绝对路径
 */
function getTempPath(ext: string): string {
  const name = `zpx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  return path.join(os.tmpdir(), name)
}

/**
 * 将 .zpx 文件通过指定算法解压到临时 .asar 文件
 * @param zpxPath .zpx 文件路径
 * @returns 临时 .asar 文件路径（调用者负责清理）
 */
async function decompressToTemp(
  zpxPath: string,
  decompressorFactory: () => NodeJS.ReadWriteStream
): Promise<string> {
  const tempAsarPath = getTempPath('.asar')

  // 临时禁用 Electron 的 asar 路径拦截，防止 fs 操作被 Electron 特殊处理
  const prevNoAsar = process.noAsar
  process.noAsar = true

  try {
    await pipeline(
      createReadStream(zpxPath),
      decompressorFactory(),
      createWriteStream(tempAsarPath)
    )
    return tempAsarPath
  } catch (error) {
    // 解压失败时清理临时文件
    try {
      await fs.unlink(tempAsarPath)
    } catch {
      // 忽略清理失败
    }
    throw error
  } finally {
    process.noAsar = prevNoAsar
  }
}

/**
 * 自动解压 .zpx 到临时 .asar（优先兼容历史 gzip，再尝试 brotli）
 * @param zpxPath .zpx 文件路径
 * @returns 临时 .asar 文件路径（调用者负责清理）
 */
async function decompressZpxToTemp(zpxPath: string): Promise<string> {
  try {
    return await decompressToTemp(zpxPath, () => createGunzip())
  } catch {
    return await decompressToTemp(zpxPath, () => createBrotliDecompress())
  }
}

/**
 * 清理临时 .asar 文件
 * @param tempAsarPath 临时文件路径
 */
async function cleanupTemp(tempAsarPath: string): Promise<void> {
  const prevNoAsar = process.noAsar
  process.noAsar = true
  try {
    await fs.unlink(tempAsarPath)
  } catch {
    // 忽略清理失败
  } finally {
    process.noAsar = prevNoAsar
  }
}

/**
 * 打包目录为 .zpx 文件
 * 流程：目录 → asar.createPackage() → brotli 压缩 → .zpx 文件
 *
 * @param sourceDir 源目录路径
 * @param outputPath 输出的 .zpx 文件路径
 */
export async function packZpx(sourceDir: string, outputPath: string): Promise<void> {
  // 先打包为临时 asar 文件
  const tempAsarPath = getTempPath('.asar')

  const prevNoAsar = process.noAsar
  process.noAsar = true

  try {
    console.log('[ZPX] 打包目录:', sourceDir, '→', outputPath)

    // 目录 → asar 归档
    await asar.createPackage(sourceDir, tempAsarPath)

    // asar → brotli → .zpx
    await pipeline(
      createReadStream(tempAsarPath),
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 5
        }
      }),
      createWriteStream(outputPath)
    )

    console.log('[ZPX] 打包完成:', outputPath)
  } finally {
    // 清理临时 asar 文件
    try {
      await fs.unlink(tempAsarPath)
    } catch {
      // 忽略清理失败
    }
    process.noAsar = prevNoAsar
  }
}

/**
 * 解压 .zpx 文件到目标目录
 * 流程：.zpx → 自动解压 → 临时 .asar → asar.extractAll() → 目标目录
 *
 * @param zpxPath .zpx 文件路径
 * @param targetDir 目标目录路径（如不存在会自动创建）
 */
export async function extractZpx(zpxPath: string, targetDir: string): Promise<void> {
  console.log('[ZPX] 解压:', zpxPath, '→', targetDir)

  // .zpx → 自动解压 → 临时 .asar
  const tempAsarPath = await decompressZpxToTemp(zpxPath)

  const prevNoAsar = process.noAsar
  process.noAsar = true

  try {
    // 确保目标目录存在
    await fs.mkdir(targetDir, { recursive: true })

    // asar → 解压到目标目录（同步操作）
    asar.extractAll(tempAsarPath, targetDir)

    console.log('[ZPX] 解压完成:', targetDir)
  } finally {
    process.noAsar = prevNoAsar
    await cleanupTemp(tempAsarPath)
  }
}

/**
 * 从 .zpx 文件中读取指定文件内容
 * 流程：自动解压到临时 .asar → asar.extractFile() 读取目标文件 → 清理临时文件
 *
 * @param zpxPath .zpx 文件路径
 * @param filePath 归档内的文件相对路径（如 'plugin.json'）
 * @returns 文件内容的 Buffer
 */
export async function readFileFromZpx(zpxPath: string, filePath: string): Promise<Buffer> {
  const tempAsarPath = await decompressZpxToTemp(zpxPath)

  const prevNoAsar = process.noAsar
  process.noAsar = true

  try {
    // 从临时 asar 中提取指定文件（同步操作，返回 Buffer）
    return asar.extractFile(tempAsarPath, filePath)
  } finally {
    process.noAsar = prevNoAsar
    await cleanupTemp(tempAsarPath)
  }
}

/**
 * 从 .zpx 文件中读取指定文件为 UTF-8 文本
 * 流程：同 readFileFromZpx，结果转为 utf-8 字符串
 *
 * @param zpxPath .zpx 文件路径
 * @param filePath 归档内的文件相对路径
 * @returns 文件内容的 UTF-8 字符串
 */
export async function readTextFromZpx(zpxPath: string, filePath: string): Promise<string> {
  const buffer = await readFileFromZpx(zpxPath, filePath)
  return buffer.toString('utf-8')
}

/**
 * 检查 .zpx 文件中是否存在指定文件
 * 流程：自动解压到临时 .asar → asar.listPackage() 检查 → 清理临时文件
 *
 * @param zpxPath .zpx 文件路径
 * @param filePath 归档内的文件相对路径
 * @returns 文件是否存在
 */
export async function existsInZpx(zpxPath: string, filePath: string): Promise<boolean> {
  const tempAsarPath = await decompressZpxToTemp(zpxPath)

  const prevNoAsar = process.noAsar
  process.noAsar = true

  try {
    // 列出 asar 归档中的所有文件路径
    const files = asar.listPackage(tempAsarPath, { isPack: false })
    // 规范化路径分隔符后比较
    const normalized = filePath.replace(/\\/g, '/')
    return files.some(
      (f) => f.replace(/\\/g, '/') === `/${normalized}` || f.replace(/\\/g, '/') === normalized
    )
  } finally {
    process.noAsar = prevNoAsar
    await cleanupTemp(tempAsarPath)
  }
}

/**
 * 验证文件是否为有效的 ZPX 格式（兼容 gzip + brotli）
 * 优先通过 magic bytes 快速识别 gzip/zip，再尝试解压验证 asar 结构
 *
 * @param filePath 文件路径
 * @returns 是否为有效的 ZPX 格式
 */
export async function isValidZpx(filePath: string): Promise<boolean> {
  let tempAsarPath = ''
  try {
    // 读取文件前 4 字节：兼容 gzip/zip 的快速判断
    const fd = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(4)
      await fd.read(buf, 0, 4, 0)

      const isGzip = buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]
      if (isGzip) {
        return true
      }

      const isZip =
        buf[0] === ZIP_MAGIC[0] &&
        buf[1] === ZIP_MAGIC[1] &&
        buf[2] === ZIP_MAGIC[2] &&
        buf[3] === ZIP_MAGIC[3]
      if (isZip) {
        return false
      }
    } finally {
      await fd.close()
    }

    // brotli 等非 gzip 情况：尝试解压并验证 asar 结构
    tempAsarPath = await decompressZpxToTemp(filePath)
    const prevNoAsar = process.noAsar
    process.noAsar = true
    try {
      asar.listPackage(tempAsarPath, { isPack: false })
      return true
    } finally {
      process.noAsar = prevNoAsar
    }
  } catch {
    return false
  } finally {
    if (tempAsarPath) {
      await cleanupTemp(tempAsarPath)
    }
  }
}
