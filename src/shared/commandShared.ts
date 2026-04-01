/**
 * 可参与 commandId 计算的最小指令字段集合
 */
export interface CommandIdLike {
  name: string
  pluginName?: string
  featureCode?: string
  cmdType?: string
}

/**
 * 单条指令别名配置
 * icon 用于在别名命中时覆盖结果图标，未提供时回退到原指令图标
 */
export type CommandAliasEntry = {
  alias: string
  icon?: string
}

/**
 * 指令别名存储结构
 * key 为 getCommandId 生成的 commandId，value 为该指令下的别名列表
 */
export type CommandAliasStore = Record<string, CommandAliasEntry[]>

/**
 * 指令别名在主程序数据库中的存储 key
 * 设置插件和主窗口渲染进程都会通过该 key 读取同一份映射
 */
export const COMMAND_ALIASES_KEY = 'command-aliases'

/**
 * 生成指令唯一标识
 * 格式: pluginName:featureCode:name:cmdType
 * cmdType 默认回退为 text，保证功能指令、别名映射和设置页目标选择使用同一主键规则
 */
export function getCommandId(cmd: CommandIdLike): string {
  const cmdType = cmd.cmdType || 'text'
  return `${cmd.pluginName || ''}:${cmd.featureCode || ''}:${cmd.name}:${cmdType}`
}

/**
 * 归一化指令别名存储，兼容旧版 string[] 结构
 * 规则：
 * 1. 同时兼容 string[] 与 { alias, icon }[] 两种输入
 * 2. 去除 alias 首尾空白并过滤空值
 * 3. 按 alias 文本去重，重复项以后写为准并保留 icon
 * 4. 移除归一化后为空的 commandId bucket
 */
export function normalizeCommandAliases(
  store: CommandAliasStore | null | undefined
): CommandAliasStore {
  const normalized: CommandAliasStore = {}

  for (const [commandId, aliases] of Object.entries(store || {})) {
    const nextAliases = Array.from(
      new Map(
        ((aliases || []) as Array<string | CommandAliasEntry>)
          .map((aliasEntry) => {
            if (typeof aliasEntry === 'string') {
              return { alias: aliasEntry.trim(), icon: undefined }
            }

            return {
              alias: (aliasEntry?.alias || '').trim(),
              icon: aliasEntry?.icon || undefined
            }
          })
          .filter((aliasEntry) => Boolean(aliasEntry.alias))
          .map((aliasEntry) => [aliasEntry.alias, aliasEntry] as const)
      ).values()
    )

    if (nextAliases.length > 0) {
      normalized[commandId] = nextAliases
    }
  }

  return normalized
}
