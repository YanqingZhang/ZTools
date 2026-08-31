import { onBeforeUnmount, type Ref } from 'vue'

export type EscapeHandler = (event: KeyboardEvent) => boolean

export interface EscapeHandlerOptions {
  enabled?: boolean | Ref<boolean> | (() => boolean)
  priority?: number
}

interface EscapeEntry {
  handler: EscapeHandler
  enabled: () => boolean
  priority: number
  order: number
}

const entries: EscapeEntry[] = []
let listenerAttached = false
let nextOrder = 0

/**
 * 读取 ESC 处理器当前是否启用。
 * @param enabled 处理器启用状态、响应式状态或状态读取函数
 * @returns 处理器当前是否启用
 */
function resolveEnabled(enabled: EscapeHandlerOptions['enabled']): boolean {
  if (typeof enabled === 'function') return enabled()
  if (typeof enabled === 'boolean') return enabled
  if (enabled) return enabled.value
  return true
}

/**
 * 消费设置插件内的 ESC，并将事件交给当前优先级最高的处理器。
 * @param event 浏览器键盘事件
 * @returns 无返回值
 */
function handleEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return

  const activeEntries = entries
    .filter((entry) => entry.enabled())
    .sort((left, right) => right.priority - left.priority || right.order - left.order)

  const activeEntry = activeEntries[0]
  if (!activeEntry || !activeEntry.handler(event)) return

  // 处理器确认接管后阻止宿主 preload 的冒泡监听，避免设置插件被关闭。
  event.preventDefault()
  event.stopImmediatePropagation()
}

/**
 * 注册设置插件内的 ESC 处理器，并在组件卸载时自动移除。
 * @param handler 当前层级的 ESC 处理函数，返回 true 表示消费事件
 * @param options 处理器启用状态与优先级配置
 * @returns 移除当前处理器的清理函数
 */
export function useEscapeHandler(
  handler: EscapeHandler,
  options: EscapeHandlerOptions = {}
): () => void {
  const entry: EscapeEntry = {
    handler,
    enabled: () => resolveEnabled(options.enabled),
    priority: options.priority ?? 0,
    order: nextOrder++
  }

  entries.push(entry)
  if (!listenerAttached) {
    // 使用捕获阶段抢在插件 preload 的 window 冒泡监听之前完成页面内返回。
    window.addEventListener('keydown', handleEscape, true)
    listenerAttached = true
  }

  let removed = false
  const cleanup = (): void => {
    if (removed) return
    removed = true
    const index = entries.indexOf(entry)
    if (index >= 0) entries.splice(index, 1)
    if (entries.length === 0 && listenerAttached) {
      window.removeEventListener('keydown', handleEscape, true)
      listenerAttached = false
    }
  }

  onBeforeUnmount(cleanup)
  return cleanup
}
