import { protocol } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { IconExtractor } from './native/index'

/** 图标内存缓存（LRU 淘汰，Map 按插入顺序迭代） */
const iconMemoryCache = new Map<string, Buffer>()
const MAX_ICON_CACHE = 128

/**
 * 写入图标缓存（LRU 淘汰）
 * 命中时先 delete 再 set，保证该 key 移到 Map 末尾（最近使用）
 */
function setIconCache(key: string, buffer: Buffer): void {
  // 已存在则先删除，重新插入以刷新顺序
  if (iconMemoryCache.has(key)) {
    iconMemoryCache.delete(key)
  } else if (iconMemoryCache.size >= MAX_ICON_CACHE) {
    // 淘汰最早插入（最久未使用）的条目
    const oldest = iconMemoryCache.keys().next().value
    if (oldest !== undefined) {
      iconMemoryCache.delete(oldest)
    }
  }
  iconMemoryCache.set(key, buffer)
}

/**
 * 判断文件内容是否具有 PNG 文件签名。
 *
 * @param buffer 待校验的文件内容。
 * @returns 是否为 PNG 图片数据。
 */
function isPngBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
}

/**
 * 根据图标源类型读取原图或提取系统图标，并统一返回 PNG Buffer。
 *
 * @param iconPath 图片、快捷方式或可执行文件路径。
 * @returns PNG 格式的图标内容。
 * @throws 图片读取及原生图标提取都失败时抛出。
 */
async function extractIcon(iconPath: string): Promise<Buffer> {
  if (path.extname(iconPath).toLowerCase() === '.png') {
    try {
      // UWP 的 manifest 图标是图片本身，直接读取可避免得到“PNG 文件类型”通用图标。
      const imageBuffer = await fs.readFile(iconPath)
      if (isPngBuffer(imageBuffer)) {
        return imageBuffer
      }
    } catch {
      // 文件不可读时继续尝试 Shell 图标提取，保留现有容错行为。
    }
  }

  // 可执行文件、快捷方式和非 PNG 文件继续交给平台原生图标提取器。
  const iconBuffer = await IconExtractor.getFileIcon(iconPath)
  if (!iconBuffer) {
    throw new Error('Failed to extract icon')
  }
  return iconBuffer
}

/**
 * 串行图标提取队列
 * macOS AppKit 图标 API 在高并发下可能返回 null，使用 promise 链确保每次只有一个提取任务在执行
 */
let extractionQueue: Promise<void> = Promise.resolve()

/**
 * 通过串行队列提取图标，确保原生调用不并发执行
 */
function extractIconQueued(iconPath: string): Promise<Buffer> {
  const task = extractionQueue.then(() => extractIcon(iconPath))
  // 更新队列尾部，忽略错误不阻塞后续任务
  extractionQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

/**
 * 创建图标 Response
 */
function createIconResponse(buffer: Buffer): Response {
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': buffer.length.toString(),
      'access-control-allow-origin': '*'
    }
  })
}

/**
 * 注册 ztools-icon:// 为特权协议
 * 必须在 app.ready 之前调用
 */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'ztools-icon',
      privileges: {
        bypassCSP: true,
        secure: true,
        standard: false,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: false
      }
    }
  ])
}

/**
 * 获取文件图标的 base64 Data URL（异步）
 * 支持文件路径或文件扩展名（如 ".txt"）
 */
export async function getFileIconAsBase64(filePath: string): Promise<string> {
  // 命中内存缓存（刷新 LRU 顺序）
  const cached = iconMemoryCache.get(filePath)
  if (cached) {
    setIconCache(filePath, cached)
    return `data:image/png;base64,${cached.toString('base64')}`
  }

  const buffer = await extractIconQueued(filePath)

  // 写入内存缓存
  setIconCache(filePath, buffer)

  return `data:image/png;base64,${buffer.toString('base64')}`
}

/**
 * 在指定 session 中注册 ztools-icon:// 协议 handler
 * 供内置插件使用（外部插件不需要访问应用图标）
 */
export function registerIconProtocolForSession(targetSession: Electron.Session): void {
  if (targetSession.protocol.isProtocolHandled('ztools-icon')) {
    return
  }

  targetSession.protocol.handle('ztools-icon', async (request) => {
    try {
      const urlPath = request.url.replace('ztools-icon://', '')
      const iconPath = decodeURIComponent(urlPath)

      // 命中内存缓存：刷新 LRU 并返回
      const cached = iconMemoryCache.get(iconPath)
      if (cached) {
        setIconCache(iconPath, cached)
        return createIconResponse(cached)
      }

      // 未命中：通过串行队列提取图标
      const buffer = await extractIconQueued(iconPath)

      // 写入内存缓存
      setIconCache(iconPath, buffer)

      return createIconResponse(buffer)
    } catch (error) {
      console.error('[Main] 图标提取失败:', error)
      return new Response('Icon Error', { status: 404 })
    }
  })
}
