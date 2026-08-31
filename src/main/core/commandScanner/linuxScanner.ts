import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { pinyin as getPinyin } from 'pinyin-pro'
import { extractAcronym } from '../../utils/common'
import { getLinuxApplicationPaths } from '../../utils/systemPaths'
import { Command } from './types'
import { pLimit } from './utils'

// ============================================================
// XDG .desktop 文件解析器
// ============================================================

export interface DesktopEntry {
  Name?: string
  GenericName?: string
  Comment?: string
  Keywords?: string
  Exec?: string
  Icon?: string
  NoDisplay?: string
  Hidden?: string
  Type?: string
  'X-Ubuntu-Gettext-Domain'?: string
  // 本地化字段
  [key: string]: string | undefined
}

/**
 * 解析 .desktop 文件，返回 [Desktop Entry] 部分的键值对
 *
 * @param content .desktop 文件文本内容
 * @returns 包含键值对的 DesktopEntry 对象
 */
export function parseDesktopFile(content: string): DesktopEntry {
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

// ============================================================
// GNU Gettext .mo 本地化解析支持
// ============================================================

/**
 * 解析 GNU gettext 二进制 .mo 文件数据
 *
 * @param buffer .mo 文件内容的 Buffer
 * @returns 包含原始字符串与翻译映射关系的 Map
 */
export function parseMoBuffer(buffer: Buffer): Map<string, string> {
  const translations = new Map<string, string>()

  // 基础长度校验（至少包含魔数、版本与关键偏移量共 20 字节）
  if (buffer.length < 20) {
    return translations
  }

  // 校验魔数判断字节序（小端或大端）
  const magic = buffer.readUInt32LE(0)
  let isLE = true
  if (magic === 0x950412de) {
    isLE = true
  } else if (magic === 0xde120495) {
    isLE = false
  } else {
    return translations
  }

  // 读取字符串总数以及原串/译文表偏移量
  const numStrings = isLE ? buffer.readUInt32LE(8) : buffer.readUInt32BE(8)
  const origTableOffset = isLE ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12)
  const transTableOffset = isLE ? buffer.readUInt32LE(16) : buffer.readUInt32BE(16)

  // 边界保护：防止偏移越界
  if (
    origTableOffset + numStrings * 8 > buffer.length ||
    transTableOffset + numStrings * 8 > buffer.length
  ) {
    return translations
  }

  // 遍历字符串表提取条目
  for (let i = 0; i < numStrings; i++) {
    const origLen = isLE
      ? buffer.readUInt32LE(origTableOffset + i * 8)
      : buffer.readUInt32BE(origTableOffset + i * 8)
    const origOffset = isLE
      ? buffer.readUInt32LE(origTableOffset + i * 8 + 4)
      : buffer.readUInt32BE(origTableOffset + i * 8 + 4)
    const transLen = isLE
      ? buffer.readUInt32LE(transTableOffset + i * 8)
      : buffer.readUInt32BE(transTableOffset + i * 8)
    const transOffset = isLE
      ? buffer.readUInt32LE(transTableOffset + i * 8 + 4)
      : buffer.readUInt32BE(transTableOffset + i * 8 + 4)

    // 读取并存入字典映射
    if (origOffset + origLen <= buffer.length && transOffset + transLen <= buffer.length) {
      const origStr = buffer.toString('utf8', origOffset, origOffset + origLen)
      const transStr = buffer.toString('utf8', transOffset, transOffset + transLen)
      translations.set(origStr, transStr)
    }
  }

  return translations
}

// 内存中缓存已解析的 .mo 字典
const moCache = new Map<string, Map<string, string>>()

/**
 * 获取当前系统的候选语言代码列表
 *
 * @returns 语言代码列表（例如 ['zh_CN', 'zh', 'en_US', 'en']）
 */
export function getLocaleCandidates(): string[] {
  const envLang = [
    process.env.LANGUAGE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG
  ].filter(Boolean)

  const candidates: string[] = []

  // 提取语言和地区代码
  for (const raw of envLang) {
    if (!raw) continue
    for (const segment of raw.split(':')) {
      const code = segment.split('.')[0].trim()
      if (!code) continue
      if (!candidates.includes(code)) {
        candidates.push(code)
      }
      const parts = code.split('_')
      if (parts[0] && !candidates.includes(parts[0])) {
        candidates.push(parts[0])
      }
    }
  }

  // 默认兜底保障包含中文与英文候选
  if (!candidates.includes('zh_CN')) candidates.push('zh_CN')
  if (!candidates.includes('zh')) candidates.push('zh')
  if (!candidates.includes('en_US')) candidates.push('en_US')
  if (!candidates.includes('en')) candidates.push('en')

  return candidates
}

/**
 * 获取 gettext 本地化搜索目录
 *
 * @returns 目录绝对路径数组
 */
function getLocaleSearchDirs(): string[] {
  const home = os.homedir()
  return [
    '/usr/share/locale-langpack',
    '/usr/share/locale',
    '/usr/local/share/locale',
    path.join(home, '.local/share/locale')
  ]
}

/**
 * 根据 domain 和原文读取所有可能的目标语言翻译（支持多路径多语言包收集）
 *
 * @param domain gettext 域名称（如 aisleriot）
 * @param msgid 待翻译的原文字符串
 * @returns 查找到的所有非空译文数组（去重）
 */
export async function getGettextTranslations(domain: string, msgid: string): Promise<string[]> {
  if (!domain || !msgid) return []

  const translations = new Set<string>()
  const localeDirs = getLocaleSearchDirs()
  const langCandidates = getLocaleCandidates()

  // 遍历语言和目录查找 .mo 文件
  for (const lang of langCandidates) {
    for (const dir of localeDirs) {
      const moPath = path.join(dir, lang, 'LC_MESSAGES', `${domain}.mo`)
      let catalog = moCache.get(moPath)

      if (!catalog) {
        try {
          const buf = await fs.readFile(moPath)
          catalog = parseMoBuffer(buf)
          moCache.set(moPath, catalog)
        } catch {
          // 标记为空字典，避免重复 I/O 尝试不存在的文件
          catalog = new Map()
          moCache.set(moPath, catalog)
        }
      }

      const val = catalog.get(msgid)
      if (val && val.trim() && val.trim() !== msgid) {
        translations.add(val.trim())
      }
    }
  }

  return Array.from(translations)
}

/**
 * 解析 DesktopEntry 字段的本地化首选值及所有备选译文
 *
 * @param entry DesktopEntry 对象
 * @param field 字段名称（如 'Name', 'GenericName', 'Comment', 'Keywords'）
 * @returns 本地化首选字符串及所有备选译文
 */
export async function resolveLocalizedField(
  entry: DesktopEntry,
  field: string
): Promise<{ primary: string; allTranslations: string[] }> {
  const rawDefault = entry[field]?.trim() || ''
  const langCandidates = getLocaleCandidates()
  const translations = new Set<string>()

  // 1. 优先从 .desktop 本地化属性读取（如 Name[zh_CN]、Name[zh]）
  for (const lang of langCandidates) {
    const val = entry[`${field}[${lang}]`]?.trim()
    if (val) {
      translations.add(val)
    }
  }

  // 2. 若存在 X-Ubuntu-Gettext-Domain，尝试从系统的 .mo 文件查询
  const gettextDomain = entry['X-Ubuntu-Gettext-Domain']?.trim()
  if (gettextDomain && rawDefault) {
    const moTranslations = await getGettextTranslations(gettextDomain, rawDefault)
    for (const t of moTranslations) {
      translations.add(t)
    }
  }

  const allTranslations = Array.from(translations)
  const primary = allTranslations[0] || rawDefault

  return { primary, allTranslations }
}

/**
 * 清理 Exec 字段中的 % 参数占位符（如 %f, %u, %F, %U ...）
 * 并提取实际可执行文件路径
 *
 * @param exec 原始 Exec 命令行
 * @returns 清理后的可执行命令路径
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
    path.join(home, '.local/share/flatpak/exports/share/icons'),
    '/var/lib/flatpak/exports/share/icons',
    '/var/lib/snapd/desktop/icons',
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
 *
 * @param iconName 图标名称或绝对路径
 * @returns 图标绝对路径或 null
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
 *
 * @param name 中文或中英混合文本
 * @returns 小写拼音缩写字符串
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
 *
 * @param str 待检测字符串
 * @returns 包含中文返回 true，否则 false
 */
function hasChinese(str: string): boolean {
  return /[\u4e00-\u9fa5]/.test(str)
}

// ============================================================
// 应用扫描入口
// ============================================================

/**
 * 扫描单个目录下的所有 .desktop 文件（支持常规文件与符号链接）
 *
 * @param dirPath 待扫描目录路径
 * @returns 文件完整路径列表
 */
async function scanDesktopDir(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.desktop'))
      .map((e) => path.join(dirPath, e.name))
  } catch {
    return []
  }
}

/**
 * 将单个 .desktop 文件转换为 Command 对象
 * 如果应用不应显示（NoDisplay=true 等），返回 null
 *
 * @param desktopPath .desktop 文件绝对路径
 * @returns Command 对象或 null
 */
export async function parseDesktopFileToCommand(desktopPath: string): Promise<Command | null> {
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

    // 获取本地化应用名与所有可用译文
    const { primary: name, allTranslations: nameTranslations } = await resolveLocalizedField(
      entry,
      'Name'
    )
    if (!name) return null

    const exec = cleanExecCommand(entry.Exec)
    if (!exec) return null

    // 查找应用图标
    let iconUrl: string | undefined
    if (entry.Icon) {
      const iconPath = await findIconPath(entry.Icon)
      if (iconPath) {
        iconUrl = `file://${iconPath}`
      }
    }

    // 汇总所有别名与搜索关键词
    const aliasSet = new Set<string>()

    // 1. 添加所有其他名称译文
    for (const trans of nameTranslations) {
      if (trans && trans !== name) {
        aliasSet.add(trans)
      }
    }

    // 2. 添加英文原名
    const rawEnglishName = entry['Name']?.trim()
    if (rawEnglishName && rawEnglishName !== name) {
      aliasSet.add(rawEnglishName)
    }

    // 3. 解析 GenericName 及其翻译
    const { primary: genericName, allTranslations: genericTranslations } =
      await resolveLocalizedField(entry, 'GenericName')
    if (genericName && genericName !== name) {
      aliasSet.add(genericName)
    }
    for (const trans of genericTranslations) {
      if (trans && trans !== name) {
        aliasSet.add(trans)
      }
    }

    // 4. 解析 Keywords 及其翻译（分号分隔列表）
    const { primary: rawKeywords, allTranslations: keywordTranslations } =
      await resolveLocalizedField(entry, 'Keywords')
    const allKeywordTexts = [rawKeywords, ...keywordTranslations]
    for (const kwText of allKeywordTexts) {
      if (!kwText) continue
      const splitKeywords = kwText
        .split(';')
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
      for (const kw of splitKeywords) {
        if (kw !== name) {
          aliasSet.add(kw)
        }
      }
    }

    // 5. 从 Desktop ID (如 com.nomachine.nxplayer.desktop) 提取包名关键词
    const desktopId = path.basename(desktopPath, '.desktop')
    const idParts = desktopId
      .split('.')
      .filter(
        (part) =>
          !['com', 'org', 'io', 'net', 'cn', 'de', 'fr', 'desktop', 'app'].includes(
            part.toLowerCase()
          )
      )
    for (const part of idParts) {
      if (part.length > 2 && !name.toLowerCase().includes(part.toLowerCase())) {
        aliasSet.add(part)
      }
    }

    // 6. 生成缩写：英文首字母缩写
    const acronym = extractAcronym(name) || (rawEnglishName ? extractAcronym(rawEnglishName) : '')

    // 7. 对名称和所有中文别名提取拼音缩写，并注入别名列表
    const wordsForPinyin = [name, ...Array.from(aliasSet)]
    for (const word of wordsForPinyin) {
      if (hasChinese(word)) {
        const pinyinAcronym = extractPinyinAcronym(word)
        if (pinyinAcronym && pinyinAcronym !== acronym) {
          aliasSet.add(pinyinAcronym)
        }
      }
    }

    // 移除与主名称完全一致的条目
    aliasSet.delete(name)
    const aliases = Array.from(aliasSet)

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
 *
 * @returns 扫描并去重后的应用程序指令列表
 */
export async function scanApplications(): Promise<Command[]> {
  try {
    console.time('[LinuxScanner] 扫描应用')

    const searchPaths = getLinuxApplicationPaths()
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
