import { shell } from 'electron'
import type { Dirent } from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { extractAcronym } from '../../utils/common'
import { getWindowsRootScanPaths, getWindowsScanPaths } from '../../utils/systemPaths'
import { MuiResolver } from '../native/index'
import { Command } from './types'

// ========== 配置 ==========

// 要跳过的文件夹名称
export const SKIP_FOLDERS = [
  'sdk',
  'doc',
  'docs',
  'samples',
  'sample',
  'examples',
  'example',
  'demos',
  'demo',
  'documentation'
]

// 要跳过的快捷方式名称关键词（不区分大小写）
// 仅按名称过滤，不按目标类型/路径/扩展名过滤
// 因为扫描范围仅限开始菜单和桌面，这些位置的快捷方式都是有意放置的
export const SKIP_NAME_PATTERN =
  /^uninstall|^卸载|卸载$|website|网站|帮助|help|readme|read me|文档|manual|license|documentation/i

// ========== 辅助函数 ==========

// 检查是否应该跳过该快捷方式（仅按名称过滤）
export function shouldSkipShortcut(name: string): boolean {
  return SKIP_NAME_PATTERN.test(name)
}

/**
 * 解析 desktop.ini 中的 [LocalizedFileNames] 段。
 * desktop.ini 通常是 UTF-16LE 编码（带 BOM），部分为 UTF-8。
 * 返回 { fileName → value } 的映射，value 可能是纯文本或 MUI 引用（@dll,-id）。
 */
async function parseDesktopIni(dirPath: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>()
  const iniPath = path.join(dirPath, 'desktop.ini')

  try {
    const buf = await fsPromises.readFile(iniPath)
    // 检测 BOM 来判断编码：FF FE = UTF-16LE，否则 UTF-8
    const content =
      buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
        ? buf.toString('utf16le')
        : buf.toString('utf8')

    let inSection = false
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim()
      if (t === '[LocalizedFileNames]') {
        inSection = true
        continue
      }
      if (t.startsWith('[')) {
        inSection = false
        continue
      }
      if (inSection && t.includes('=')) {
        const eqIdx = t.indexOf('=')
        const fileName = t.slice(0, eqIdx)
        const value = t.slice(eqIdx + 1)
        if (fileName && value) {
          entries.set(fileName, value)
        }
      }
    }
  } catch {
    // 文件不存在或无法读取，正常忽略
  }

  return entries
}

/**
 * 批量解析 MUI 资源字符串（如 @%SystemRoot%\system32\shell32.dll,-22067）。
 * 通过原生模块调用 Win32 API 实现。
 */
function resolveMuiStrings(muiRefs: string[]): Map<string, string> {
  if (muiRefs.length === 0) return new Map()
  return MuiResolver.resolve(muiRefs)
}

/**
 * 获取文件的本地化显示名称（Windows 特有）。
 * Windows 系统快捷方式的磁盘文件名通常是英文（如 File Explorer.lnk），
 * 但通过 desktop.ini + MUI 资源显示为本地化名称（如"文件资源管理器"）。
 *
 * 分两步：
 * 1. Node.js 直接读取 desktop.ini（纯文件 I/O + 解析）
 * 2. 遇到 MUI 引用（@dll,-id）时，批量交给原生模块解析（Win32 API）
 */
async function getLocalizedDisplayNames(dirPaths: string[]): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>()

  if (process.platform !== 'win32') return nameMap

  try {
    // 第 1 步：用 Node.js 递归读取所有 desktop.ini，收集本地化条目
    const pendingMui = new Map<string, string[]>() // muiRef → [fullPath, ...]

    async function scanDir(dirPath: string): Promise<void> {
      const iniEntries = await parseDesktopIni(dirPath)

      for (const [fileName, value] of iniEntries) {
        const fullPath = path.join(dirPath, fileName)
        if (value.startsWith('@')) {
          // MUI 引用，稍后批量解析
          const arr = pendingMui.get(value) || []
          arr.push(fullPath)
          pendingMui.set(value, arr)
        } else {
          // 纯文本，直接使用
          nameMap.set(fullPath.toLowerCase(), value)
        }
      }

      // 递归子目录
      try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            await scanDir(path.join(dirPath, entry.name))
          }
        }
      } catch {
        // 目录不可读，忽略
      }
    }

    for (const dirPath of dirPaths) {
      await scanDir(dirPath)
    }

    // 第 2 步：批量解析 MUI 引用（通过原生模块调用 Win32 API）
    if (pendingMui.size > 0) {
      const muiRefs = Array.from(pendingMui.keys())
      const resolved = resolveMuiStrings(muiRefs)

      for (const [ref, localizedName] of resolved) {
        const filePaths = pendingMui.get(ref) || []
        for (const fp of filePaths) {
          nameMap.set(fp.toLowerCase(), localizedName)
        }
      }
    }

    console.log(`[Scanner] 获取到 ${nameMap.size} 个本地化文件名映射`)
  } catch (error) {
    // 失败不影响扫描，降级使用磁盘文件名
    console.error('[Scanner] 获取本地化显示名称失败（将使用文件名）:', error)
  }

  return nameMap
}

// 生成图标 URL
export function getIconUrl(appPath: string): string {
  // 将绝对路径编码为 URL
  return `ztools-icon://${encodeURIComponent(appPath)}`
}

// 解析 .url 文件，提取 URL 和 IconFile 字段
export interface UrlFileInfo {
  url: string
  iconFile: string
}

export async function parseUrlFile(filePath: string): Promise<UrlFileInfo | null> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8')
    let url = ''
    let iconFile = ''

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('URL=')) {
        url = trimmed.slice(4)
      } else if (trimmed.startsWith('IconFile=')) {
        iconFile = trimmed.slice(9)
      }
    }

    if (!url) return null

    // 跳过普通网页链接（http/https），保留其他应用协议（如 steam://）
    const lowerUrl = url.toLowerCase()
    if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) {
      return null
    }

    return { url, iconFile }
  } catch {
    return null
  }
}

/**
 * 处理单个快捷方式 entry（.url / .lnk）：解析、过滤、入列。
 * 递归与扁平扫描共用，仅处理文件 entry；目录的下钻 / 跳过由调用方决定。
 */
async function processShortcutEntry(
  dirPath: string,
  entry: Dirent,
  apps: Command[],
  displayNameMap: Map<string, string>
): Promise<void> {
  const fullPath = path.join(dirPath, entry.name)
  const ext = path.extname(entry.name).toLowerCase()

  // 处理 .url 快捷方式（应用协议链接，如 steam://）
  if (ext === '.url') {
    const urlInfo = await parseUrlFile(fullPath)
    if (!urlInfo) return

    // 优先使用本地化显示名称，降级为磁盘文件名
    const appName = displayNameMap.get(fullPath.toLowerCase()) || path.basename(entry.name, '.url')

    // 过滤检查
    if (SKIP_NAME_PATTERN.test(appName)) return

    // 图标：优先使用 .url 文件中的 IconFile，否则使用 .url 文件本身
    const iconPath = urlInfo.iconFile || fullPath
    const icon = getIconUrl(iconPath)

    apps.push({
      name: appName,
      path: urlInfo.url, // 使用协议链接作为启动路径
      icon,
      acronym: extractAcronym(appName)
    })
    return
  }

  // 处理 .lnk 快捷方式
  if (ext !== '.lnk') return

  // 优先使用本地化显示名称，降级为磁盘文件名
  // 解决 Windows 系统快捷方式文件名为英文（如 File Explorer.lnk）但显示名为中文的问题
  const appName = displayNameMap.get(fullPath.toLowerCase()) || path.basename(entry.name, '.lnk')

  // 尝试解析快捷方式目标（必须先解析才能获取真实路径）
  let shortcutDetails: Electron.ShortcutDetails | null = null
  try {
    shortcutDetails = shell.readShortcutLink(fullPath)
  } catch {
    // 解析失败，使用快捷方式本身
  }

  // 获取目标路径和应用路径
  const targetPath = shortcutDetails?.target?.trim() || ''

  // 如果 .lnk 指向 .url 文件，解析 .url 内容判断是否为应用协议
  if (targetPath.toLowerCase().endsWith('.url')) {
    const urlInfo = await parseUrlFile(targetPath)
    if (!urlInfo) return // http/https 或解析失败，跳过

    if (SKIP_NAME_PATTERN.test(appName)) return

    const iconPath = urlInfo.iconFile || fullPath
    const icon = getIconUrl(iconPath)

    apps.push({
      name: appName,
      path: urlInfo.url,
      icon,
      acronym: extractAcronym(appName)
    })
    return
  }

  // 过滤检查：仅按名称过滤（不按目标类型/路径过滤）
  if (shouldSkipShortcut(appName)) {
    return
  }

  // 始终使用 .lnk 快捷方式路径作为启动路径
  // Windows Shell API (shell.openPath) 能正确处理 .lnk 文件的启动（包括参数、工作目录等）
  // 图标使用 .lnk 路径即可，SHGetFileInfoW 能正确解析快捷方式的图标（包括自定义图标）
  const icon = getIconUrl(fullPath)

  // 创建应用对象
  // _dedupeTarget 用于去重：同名且指向同一目标的快捷方式只保留一个
  // （用户开始菜单和系统开始菜单可能有同名同目标的 .lnk，路径不同但应合并）
  const app: Command & { _dedupeTarget?: string } = {
    name: appName,
    path: fullPath,
    icon,
    acronym: extractAcronym(appName),
    _dedupeTarget: targetPath || undefined
  }

  apps.push(app)
}

// 递归扫描目录中的快捷方式（Programs 子树 / 桌面）
async function scanDirectory(
  dirPath: string,
  apps: Command[],
  displayNameMap: Map<string, string>
): Promise<void> {
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      // 处理子目录：跳过开发相关文件夹，其余递归下钻
      if (entry.isDirectory()) {
        // 跳过 SDK、示例、文档等开发相关文件夹
        if (SKIP_FOLDERS.includes(entry.name.toLowerCase())) {
          continue
        }
        // 递归扫描子目录
        await scanDirectory(path.join(dirPath, entry.name), apps, displayNameMap)
        continue
      }

      try {
        await processShortcutEntry(dirPath, entry, apps, displayNameMap)
      } catch (error) {
        // 单个文件失败不影响目录内其余扫描
        console.error(`[Scanner] 处理快捷方式失败 ${path.join(dirPath, entry.name)}:`, error)
      }
    }
  } catch (error) {
    console.error(`[Scanner] 扫描目录失败 ${dirPath}:`, error)
  }
}

/**
 * 扁平扫描（Start Menu 根专用）
 * 仅处理本层文件，不下钻 Programs 子目录，避免重复索引
 */
export async function scanDirectoryFlat(
  dirPath: string,
  apps: Command[],
  displayNameMap: Map<string, string>
): Promise<void> {
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) continue

      try {
        await processShortcutEntry(dirPath, entry, apps, displayNameMap)
      } catch (error) {
        // 单个文件失败不影响目录内其余扫描
        console.error(`[Scanner] 处理快捷方式失败 ${path.join(dirPath, entry.name)}:`, error)
      }
    }
  } catch (error) {
    console.error(`[Scanner] 扫描目录失败 ${dirPath}:`, error)
  }
}

/**
 * 去重：按名称+目标路径的组合去重（允许不同名但同目标的应用共存）
 * 对于 .lnk 快捷方式，使用 _dedupeTarget（目标路径）而非 .lnk 路径去重
 * 这样同名同目标但位于不同目录（用户/系统开始菜单）的快捷方式只保留一个
 */
export function deduplicateCommands(apps: (Command & { _dedupeTarget?: string })[]): Command[] {
  const uniqueApps = new Map<string, Command>()
  apps.forEach((app) => {
    // 优先使用 _dedupeTarget（快捷方式的目标路径）去重，降级为 path
    const dedupeTarget = app._dedupeTarget || app.path
    const dedupeKey = `${app.name.toLowerCase()}|${dedupeTarget.toLowerCase()}`
    if (!uniqueApps.has(dedupeKey)) {
      // 清除内部去重字段，不泄漏到外部
      const { _dedupeTarget, ...cleanApp } = app
      uniqueApps.set(dedupeKey, cleanApp)
    }
  })
  return Array.from(uniqueApps.values())
}

export async function scanApplications(): Promise<Command[]> {
  try {
    const startTime = performance.now()

    const apps: Command[] = []

    // 获取 Windows 扫描路径（开始菜单 + 桌面）
    const scanPaths = getWindowsScanPaths()
    // 获取 Start Menu 根路径
    const rootScanPaths = getWindowsRootScanPaths()

    // 获取本地化显示名称（解决 Windows 系统快捷方式文件名为英文的问题）
    const displayNameMap = await getLocalizedDisplayNames(scanPaths)

    // 递归扫描 Programs + 桌面
    for (const menuPath of scanPaths) {
      await scanDirectory(menuPath, apps, displayNameMap)
    }
    // 扁平扫描 Start Menu 根
    for (const rootPath of rootScanPaths) {
      await scanDirectoryFlat(rootPath, apps, displayNameMap)
    }

    const deduplicatedApps = deduplicateCommands(apps)

    const endTime = performance.now()
    console.log(
      `[Scanner] 扫描完成: ${apps.length} 个应用 -> 去重后 ${deduplicatedApps.length} 个, 耗时 ${(endTime - startTime).toFixed(0)}ms`
    )

    return deduplicatedApps
  } catch (error) {
    console.error('[Scanner] 扫描应用失败:', error)
    return []
  }
}
