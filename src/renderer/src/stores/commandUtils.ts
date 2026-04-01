/**
 * 指令相关纯函数工具
 * 提取自 commandDataStore.ts，便于单元测试
 */

import { getCommandId as _getCommandId, type CommandIdLike } from '@shared/commandShared'

interface MatchInfo {
  indices: Array<[number, number]>
  value: string
  key: string
}

interface CommandLike extends CommandIdLike {
  path: string
  pluginSource?: 'installed' | 'development'
  devBadge?: 'DEV'
  subType?: string
  [key: string]: any
}

/**
 * 生成指令唯一标识（与设置插件保持一致）
 * 格式: pluginName:featureCode:cmdName:cmdType
 */
export function getCommandId(cmd: CommandIdLike): string {
  return _getCommandId(cmd)
}

/**
 * 应用特殊指令配置
 * @param command 原始指令
 * @param specialCommands 特殊指令配置表
 * @returns 应用了特殊配置的指令
 */
export function applySpecialConfig<T extends CommandLike>(
  command: T,
  specialCommands: Record<string, Partial<T>>
): T {
  // 1. 优先通过 path 精确匹配
  const pathConfig = specialCommands[command.path]
  if (pathConfig) {
    return { ...command, ...pathConfig }
  }

  // 2. 通过 subType 匹配
  if (command.subType) {
    const subTypeKey = `subType:${command.subType}`
    const subTypeConfig = specialCommands[subTypeKey]
    if (subTypeConfig) {
      return { ...command, ...subTypeConfig }
    }
  }

  return command
}

/**
 * 计算搜索匹配分数
 * @param text 被搜索的文本
 * @param query 搜索关键词
 * @param matches 匹配信息
 * @param command 指令对象（可选，用于类型加权）
 * @returns 分数（越高越好）
 */
export function calculateMatchScore(
  text: string,
  query: string,
  matches?: MatchInfo[],
  command?: CommandLike
): number {
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()

  // 1. 完全匹配（最高优先级，不区分类型）
  if (lowerText === lowerQuery) {
    return 10000
  }

  // 如果没有匹配信息，返回 0
  if (!matches || matches.length === 0) {
    return 0
  }

  let score = 0

  // 2. 前缀匹配（次高优先级）
  if (lowerText.startsWith(lowerQuery)) {
    score += 5000
  }

  // 3. 连续匹配检测
  const consecutiveMatch = lowerText.includes(lowerQuery)
  if (consecutiveMatch) {
    score += 2000
    // 连续匹配位置越靠前，分数越高
    const position = lowerText.indexOf(lowerQuery)
    score += Math.max(0, 500 - position * 10)
  }

  // 4. 匹配长度占比（匹配越多，分数越高）
  const matchRatio = query.length / text.length
  score += matchRatio * 100

  // 5. 匹配位置（越靠前越好）
  if (matches.length > 0 && matches[0].indices && matches[0].indices.length > 0) {
    const firstMatchPosition = matches[0].indices[0][0]
    score += Math.max(0, 100 - firstMatchPosition)
  }

  // 6. 类型权重：系统应用权重略高于其他类型（仅在非完全匹配时生效）
  if (command && command.type === 'direct' && command.subType === 'app') {
    score += 300
  }

  return score
}
