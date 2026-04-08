import type { ConfirmDialogOptions } from './types'
import { launchApp as macLaunch } from './macLauncher'
import { launchApp as winLaunch } from './windowsLauncher'
import { launchApp as linuxLaunch } from './linuxLauncher'

// 重新导出类型
export type { ConfirmDialogOptions } from './types'

// 平台检测并导出对应的启动函数
export async function launchApp(
  appPath: string,
  confirmDialog?: ConfirmDialogOptions
): Promise<void> {
  const platform = process.platform

  if (platform === 'darwin') {
    // macOS
    return macLaunch(appPath, confirmDialog)
  } else if (platform === 'win32') {
    // Windows
    return winLaunch(appPath, confirmDialog)
  } else if (platform === 'linux') {
    // Linux
    return linuxLaunch(appPath, confirmDialog)
  } else {
    console.warn(`[Launcher] 不支持的平台: ${platform}`)
    throw new Error(`Unsupported platform: ${platform}`)
  }
}
