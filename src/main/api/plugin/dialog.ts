import { ipcMain, dialog, app } from 'electron'
import detachedWindowManager from '../../core/detachedWindowManager'
import windowManager from '../../managers/windowManager'

/**
 * 对话框API - 插件专用
 */
export class PluginDialogAPI {
  private mainWindow: Electron.BrowserWindow | null = null

  public init(mainWindow: Electron.BrowserWindow): void {
    this.mainWindow = mainWindow
    this.setupIPC()
  }

  private setupIPC(): void {
    // 获取系统路径
    ipcMain.on('get-path', (event, name: string) => {
      try {
        let result = ''
        switch (name) {
          case 'home':
            result = app.getPath('home')
            break
          case 'appData':
            result = app.getPath('appData')
            break
          case 'userData':
            result = app.getPath('userData')
            break
          case 'temp':
            result = app.getPath('temp')
            break
          case 'exe':
            result = app.getPath('exe')
            break
          case 'desktop':
            result = app.getPath('desktop')
            break
          case 'documents':
            result = app.getPath('documents')
            break
          case 'downloads':
            result = app.getPath('downloads')
            break
          case 'music':
            result = app.getPath('music')
            break
          case 'pictures':
            result = app.getPath('pictures')
            break
          case 'videos':
            result = app.getPath('videos')
            break
          case 'logs':
            result = app.getPath('logs')
            break
          default:
            result = ''
        }
        event.returnValue = result
      } catch (error) {
        console.error('[PluginDialog] 获取系统路径失败:', name, error)
        event.returnValue = ''
      }
    })

    // 显示文件保存对话框
    ipcMain.on('show-save-dialog', (event, options: any) => {
      try {
        // 判断插件是在主窗口还是分离窗口
        const targetWindow =
          detachedWindowManager.getWindowByPluginWebContents(event.sender.id) || this.mainWindow

        if (!targetWindow) {
          event.returnValue = undefined
          return
        }
        windowManager
          .withBlurHideSuppressed(() => dialog.showSaveDialog(targetWindow, options))
          .then((data: Electron.SaveDialogReturnValue) => {
            event.returnValue = data.canceled ? undefined : data.filePath
          })
          .catch((error: Error) => {
            console.error('[PluginDialog] 显示文件保存对话框失败:', error)
            event.returnValue = undefined
          })
      } catch (error) {
        console.error('[PluginDialog] 显示文件保存对话框失败:', error)
        event.returnValue = undefined
      }
    })

    // 显示文件打开对话框
    ipcMain.on('show-open-dialog', (event, options: Electron.OpenDialogSyncOptions) => {
      try {
        // 判断插件是在主窗口还是分离窗口
        const targetWindow =
          detachedWindowManager.getWindowByPluginWebContents(event.sender.id) || this.mainWindow

        if (!targetWindow) {
          event.returnValue = []
          return
        }
        windowManager
          .withBlurHideSuppressed(() => dialog.showOpenDialog(targetWindow, options))
          .then((data: Electron.OpenDialogReturnValue) => {
            event.returnValue = data.canceled ? [] : data.filePaths
          })
          .catch((error: Error) => {
            console.error('[PluginDialog] 显示文件打开对话框失败:', error)
            event.returnValue = []
          })
      } catch (error) {
        console.error('[PluginDialog] 显示文件打开对话框失败:', error)
        event.returnValue = []
      }
    })
  }
}

export default new PluginDialogAPI()
