import databaseAPI from '../api/shared/database'
import { WindowManager as NativeWindowManager, type ActiveWindowResult } from './native/index.js'

const WINDOWS_DESKTOP_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd'
])

/**
 * 判断 Windows 前台窗口是否为桌面 Shell 窗口。
 * @param win 前台窗口信息
 * @returns 窗口属于桌面、任务栏或桌面壁纸承载窗口时返回 true
 */
export function isWindowsDesktopWindow(win: ActiveWindowResult): boolean {
  // 类名是 Windows Shell 的稳定标识，优先于进程名，避免误伤 Explorer 文件夹窗口。
  return typeof win.className === 'string' && WINDOWS_DESKTOP_CLASSES.has(win.className)
}

/**
 * 判断前台窗口是否处于全屏状态。
 * macOS 和 Windows 都只使用 native 返回的全屏状态。
 * @param win 前台窗口信息
 * @param platformForTest 测试注入的平台；生产环境不传
 * @returns 窗口处于全屏状态时返回 true
 */
export function isFullscreenWindow(
  win: ActiveWindowResult,
  platformForTest: NodeJS.Platform = process.platform
): boolean {
  // 排除 ZTools 自身窗口，避免面板已显示时误判为需要屏蔽。
  if (win.pid === process.pid) return false

  // 桌面 Shell 永远不应拦截热键，同时防御旧版 native 或异常返回值。
  if (platformForTest === 'win32' && isWindowsDesktopWindow(win)) return false

  // 两个平台都信任 native 的系统级判定；字段缺失时按非全屏处理，避免误伤热键。
  if (platformForTest === 'darwin' || platformForTest === 'win32') {
    return win.isFullscreen === true
  }

  return false
}

class DndManager {
  manualEnabled = false
  ignoreOnFullscreen = false

  /**
   * 从持久化设置加载游戏模式与全屏热键屏蔽配置。
   * @returns 无返回值
   */
  loadConfig(): void {
    // 一次读取两个相关配置，确保运行时状态来自同一份设置快照。
    const data = databaseAPI.dbGet('settings-general')
    this.manualEnabled = data?.gameModeEnabled ?? false
    this.ignoreOnFullscreen = data?.ignoreHotkeysOnFullscreen ?? false
  }

  /**
   * 切换手动游戏模式并同步持久化设置。
   * @returns 无返回值
   */
  toggleManual(): void {
    // 先切换内存状态，使当前进程立即应用新的屏蔽策略。
    this.manualEnabled = !this.manualEnabled

    // 合并写回设置，避免覆盖其他通用配置。
    const data = databaseAPI.dbGet('settings-general') || {}
    databaseAPI.dbPut('settings-general', { ...data, gameModeEnabled: this.manualEnabled })
  }

  /**
   * 更新全屏时忽略热键的运行时开关。
   * @param v 是否启用全屏热键屏蔽
   * @returns 无返回值
   */
  setIgnoreOnFullscreen(v: boolean): void {
    this.ignoreOnFullscreen = v
  }

  /**
   * 判断当前热键触发是否应被游戏模式或前台全屏窗口拦截。
   * @returns 应忽略当前热键时返回 true
   */
  shouldIgnoreHotkeys(): boolean {
    // 手动游戏模式具有最高优先级，不依赖前台窗口查询。
    if (this.manualEnabled) return true
    if (!this.ignoreOnFullscreen) return false

    // 实时获取前台窗口状态，不用缓存，避免应用进入全屏后仍读取旧窗口信息。
    const win = NativeWindowManager.getActiveWindow()
    return !!win && isFullscreenWindow(win)
  }
}

export default new DndManager()
