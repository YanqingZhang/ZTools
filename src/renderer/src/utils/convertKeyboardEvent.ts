/**
 * 当前按下的修饰键类型。
 */
export type CommonKeyboardModifier = 'shift' | 'ctrl' | 'alt' | 'meta'

/**
 * 支持转发给插件的导航按键动作类型。
 */
export type NavDirectionKey = 'left' | 'right' | 'up' | 'down' | 'enter' | 'tab'

/**
 * 将原生 KeyboardEvent 中的修饰键提取为 Electron 所需的修饰键数组。
 * @param event 键盘事件对象。
 * @returns 修饰键名称数组（'shift' | 'ctrl' | 'alt' | 'meta'）。
 */
export function readModifiers(event: KeyboardEvent): CommonKeyboardModifier[] {
  const modifiers: CommonKeyboardModifier[] = []

  if (event.shiftKey) {
    modifiers.push('shift')
  }

  if (event.ctrlKey) {
    modifiers.push('ctrl')
  }

  if (event.altKey) {
    modifiers.push('alt')
  }

  if (event.metaKey) {
    modifiers.push('meta')
  }

  return modifiers
}

/**
 * 将按键动作转换为 Electron KeyboardInputEvent 格式。
 * @param direction 按键动作名称（方向键、回车键或 Tab 键）。
 * @param type 按键事件类型（keyDown 或 keyUp）。
 * @param modifiers 修饰键列表。
 * @returns 构造的 Electron KeyboardInputEvent 数据。
 */
export function convertToElectronKeyboardEvent(
  direction: NavDirectionKey,
  type: 'keyDown' | 'keyUp' = 'keyDown',
  modifiers: CommonKeyboardModifier[] = []
): {
  type: 'keyDown' | 'keyUp'
  keyCode: string
  modifiers: CommonKeyboardModifier[]
} {
  // 映射方向键、回车键和 Tab 键的 keyCode
  const keyCodeMap: Record<NavDirectionKey, string> = {
    left: 'Left',
    right: 'Right',
    up: 'Up',
    down: 'Down',
    enter: 'Return',
    tab: 'Tab'
  }

  return {
    type,
    keyCode: keyCodeMap[direction],
    modifiers
  }
}
