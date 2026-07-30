import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { pinyin as getPinyin } from 'pinyin-pro'
import { extractAcronym } from '../../utils/common'
import { Command } from './types'
import { pLimit } from './utils'

// ============================================================
// XDG .desktop 文件解析器
// ============================================================

interface DesktopEntry {
  Name?: string
  GenericName?: string
  Exec?: string
  Icon?: string
  NoDisplay?: string
  Hidden?: string
  Type?: string
  // 本地化字段
  [key: string]: string | undefined
}

/**
 * 解析 .desktop 文件，返回 [Desktop Entry] 部分的键值对
 */
function parseDesktopFile(content: string): DesktopEntry {
  const result: DesktopEntry = {}
  let inDesktopEntry = false

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()

    if (line === '[Desktop Entry]') {
      inDesktopEntry = true
      continue
    }

    // 遇到下一个 section 停止解析
    if (line.startsWith('[') && line.endsWith(']') && inDesktopEntry) {
      break
    }

    if (!inDesktopEntry || !line || line.startsWith('#')) continue

    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue

    const key = line.slice(0, eqIdx).trim()
    const value = line.slice(eqIdx + 1).trim()
    result[key] = value
  }

  return result
}

/**
 * 获取本地化的应用名称
 * 优先级：Name[zh_CN] > Name[zh] > Name[en_US] > Name
 */
function getLocalizedName(entry: DesktopEntry): string {
  // 获取系统语言代码（如 "zh_CN"、"en_US"）
  const lang = process.env.LANG || process.env.LANGUAGE || ''
  const langCode = lang.split('.')[0] // 去掉编码部分 (UTF-8)
  const parts = langCode.split('_')
  const langBase = parts[0] // 只取语言部分 (zh)

  // 按优先级尝试本地化名称
  const candidates: string[] = []
  if (langCode) {
    candidates.push(`Name[${langCode}]`)
  }
  if (parts.length > 1 && parts[1]) {
    candidates.push(`Name[${langBase}_${parts[1]}]`) // 防御性写法
  }
  if (langBase) {
    candidates.push(`Name[${langBase}]`) // Name[zh]
  }
  candidates.push('Name') // 兜底

  for (const key of candidates) {
    const value = entry[key]
    if (value && value.trim()) {
      return value.trim()
    }
  }

  return entry['Name']?.trim() || ''
}

/**
 * 清理 Exec 字段中的 % 参数占位符（如 %f, %u, %F, %U ...）
 * 并提取实际可执行文件路径
 */
function cleanExecCommand(exec: string): string {
  return exec
    .replace(/%[a-zA-Z]/g, '') // 移除 %f %u %F %U 等占位符
    .replace(/\s+/g, ' ') // 合并多余空格
    .trim()
}

// ============================================================
// 图标解析
// ============================================================

// XDG 图标主题搜索路径（按优先级排列）
function getIconSearchPaths(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.local/share/icons'),
    '/usr/share/icons',
    '/usr/share/pixmaps',
    path.join(home, '.icons'),
    '/usr/local/share/icons',
    '/usr/local/share/pixmaps'
  ]
}

const ICON_EXTENSIONS = ['.png', '.svg', '.xpm']
const ICON_PREFERRED_SIZES = ['256x256', '128x128', '64x64', '48x48', '32x32', 'scalable']

/**
 * 在 XDG 图标主题中查找图标文件路径
 * 如果找不到则返回 null
 */
async function findIconPath(iconName: string): Promise<string | null> {
  // 如果是绝对路径且存在，直接返回
  if (iconName.startsWith('/')) {
    try {
      await fs.access(iconName)
      return iconName
    } catch {
      // 忽略
    }
  }

  // 去除扩展名（.desktop 文件中有时会带扩展名）
  const baseName = iconName.replace(/\.(png|svg|xpm)$/, '')

  const searchPaths = getIconSearchPaths()

  for (const searchPath of searchPaths) {
    // 先检查各个主题目录下的常用尺寸
    try {
      const entries = await fs.readdir(searchPath, { withFileTypes: true })
      const themes = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      for (const theme of ['hicolor', ...themes]) {
        for (const size of ICON_PREFERRED_SIZES) {
          for (const category of ['apps', 'applications']) {
            for (const ext of ICON_EXTENSIONS) {
              const iconPath = path.join(searchPath, theme, size, category, baseName + ext)
              try {
                await fs.access(iconPath)
                return iconPath
              } catch {
                // 忽略
              }
            }
          }
        }
      }
    } catch {
      // 目录不存在，跳过
    }

    // pixmaps 目录直接查找
    for (const ext of ICON_EXTENSIONS) {
      const iconPath = path.join(searchPath, baseName + ext)
      try {
        await fs.access(iconPath)
        return iconPath
      } catch {
        // 忽略
      }
    }
  }

  return null
}

// ============================================================
// 拼音首字母支持
// ============================================================

/**
 * 提取中文字符串的拼音首字母
 * 例如：「微信」→「wx」，「谷歌浏览器」→「gglq」
 */
function extractPinyinAcronym(name: string): string {
  let result = ''
  for (const char of name) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      try {
        result += getPinyin(char, { pattern: 'first', toneType: 'none' })
      } catch {
        // 忽略
      }
    } else if (/[a-zA-Z]/.test(char)) {
      result += char.toLowerCase()
    }
  }
  return result
}

/**
 * 判断字符串是否包含中文字符
 */
function hasChinese(str: string): boolean {
  return /[\u4e00-\u9fa5]/.test(str)
}

// ============================================================
// 应用扫描入口
// ============================================================

/**
 * 获取 Linux 上所有 .desktop 文件的搜索路径（XDG 规范）
 */
function getLinuxDesktopPaths(): string[] {
  const home = os.homedir()
  const xdgDataDirs = process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'
  const baseDirs = xdgDataDirs.split(':').filter(Boolean)

  const paths = [
    path.join(home, '.local/share/applications'), // 用户级
    ...baseDirs.map((dir) => path.join(dir, 'applications')) // 系统级
  ]

  return [...new Set(paths)] // 去重
}

/**
 * 扫描单个目录下的所有 .desktop 文件
 */
async function scanDesktopDir(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.desktop'))
      .map((e) => path.join(dirPath, e.name))
  } catch {
    return []
  }
}

/**
 * 将单个 .desktop 文件转换为 Command 对象
 * 如果应用不应显示（NoDisplay=true 等），返回 null
 */
async function parseDesktopFileToCommand(desktopPath: string): Promise<Command | null> {
  try {
    const content = await fs.readFile(desktopPath, 'utf-8')
    const entry = parseDesktopFile(content)

    // 过滤不应显示的条目
    if (
      entry.Type !== 'Application' ||
      entry.NoDisplay === 'true' ||
      entry.Hidden === 'true' ||
      !entry.Exec
    ) {
      return null
    }

    const name = getLocalizedName(entry)
    if (!name) return null

    const exec = cleanExecCommand(entry.Exec)
    if (!exec) return null

    // 查找图标
    let iconUrl: string | undefined
    if (entry.Icon) {
      const iconPath = await findIconPath(entry.Icon)
      if (iconPath) {
        iconUrl = `file://${iconPath}`
      }
    }

    // 生成搜索别名（英文名 + 拼音首字母）
    const aliases: string[] = []

    // 如果有英文原名（Name 字段与本地化名称不同），添加为搜索别名
    const rawEnglishName = entry['Name']?.trim()
    if (rawEnglishName && rawEnglishName !== name) {
      aliases.push(rawEnglishName)
    }

    // 生成缩写：英文首字母缩写
    const acronym = extractAcronym(name) || (rawEnglishName ? extractAcronym(rawEnglishName) : '')

    // 如果名称包含中文，生成拼音首字母并加入 aliases
    if (hasChinese(name)) {
      const pinyinAcronym = extractPinyinAcronym(name)
      if (pinyinAcronym && pinyinAcronym !== acronym) {
        aliases.push(pinyinAcronym)
      }
    }

    return {
      name,
      path: exec,
      icon: iconUrl,
      aliases: aliases.length > 0 ? aliases : undefined,
      acronym: acronym || undefined
    }
  } catch {
    return null
  }
}

/**
 * 扫描 Linux 系统上安装的所有应用程序
 */
export async function scanApplications(): Promise<Command[]> {
  try {
    console.time('[LinuxScanner] 扫描应用')

    const searchPaths = getLinuxDesktopPaths()
    const desktopFileMap = new Map<string, string>() // desktopId -> absolutePath

    // 收集所有 .desktop 文件路径，并按优先级去重（Desktop ID）
    // searchPaths 已经按优先级排列（用户级 > 系统级）
    for (const dirPath of searchPaths) {
      const files = await scanDesktopDir(dirPath)
      for (const filePath of files) {
        const desktopId = path.basename(filePath)
        if (!desktopFileMap.has(desktopId)) {
          desktopFileMap.set(desktopId, filePath)
        }
      }
    }

    const uniqueFiles = Array.from(desktopFileMap.values())

    console.log(`[LinuxScanner] 找到 ${uniqueFiles.length} 个唯一 .desktop 文件`)

    // 并发解析（限制并发数）
    const tasks = uniqueFiles.map((filePath) => () => parseDesktopFileToCommand(filePath))
    const results = await pLimit(tasks, 30)

    // 过滤掉解析失败或不应显示的项
    const apps = results.filter((cmd): cmd is Command => cmd !== null)

    // 二次去重：如果 Exec 路径和图标都相同，认为是重复应用
    // 这可以处理不同文件名的 .desktop 指向同一个应用的情况
    const finalApps: Command[] = []
    const seenApps = new Set<string>()

    for (const app of apps) {
      const key = `${app.path}|${app.icon || ''}`
      if (!seenApps.has(key)) {
        seenApps.add(key)
        finalApps.push(app)
      }
    }

    console.timeEnd('[LinuxScanner] 扫描应用')
    console.log(
      `[LinuxScanner] 成功加载 ${finalApps.length} 个应用 (从 ${apps.length} 个候选应用中去重)`
    )

    return finalApps
  } catch (error) {
    console.error('[LinuxScanner] 扫描应用失败:', error)
    return []
  }
}
