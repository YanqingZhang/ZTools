import { exec } from 'child_process'
import type { PluginManager } from '../../managers/pluginManager'
import { BrowserWindow, clipboard, Notification, shell } from 'electron'
import { promisify } from 'util'
import { GLOBAL_SCROLLBAR_CSS } from '../../core/globalStyles'
import windowManager from '../../managers/windowManager'
import webSearchAPI from './webSearch'
import databaseAPI from '../shared/database'
import { ColorPicker } from '../../core/native/index.js'

interface SystemCommandContext {
  mainWindow: Electron.BrowserWindow | null
  pluginManager: PluginManager | null
}

/**
 * 执行系统内置指令
 */
export async function executeSystemCommand(
  command: string,
  ctx: SystemCommandContext,
  param?: any
): Promise<any> {
  const execAsync = promisify(exec)

  const platform = process.platform

  let cmd = ''

  switch (command) {
    case 'clear':
      return handleClear(ctx)

    case 'clear-history':
      return handleClearHistory(ctx)

    case 'reboot':
      if (platform === 'darwin') {
        cmd = 'osascript -e "tell application \\"System Events\\" to restart"'
      } else if (platform === 'win32') {
        cmd = 'shutdown /r /t 0'
      }
      break

    case 'shutdown':
      if (platform === 'darwin') {
        cmd = 'osascript -e "tell application \\"System Events\\" to shut down"'
      } else if (platform === 'win32') {
        cmd = 'shutdown /s /t 0'
      }
      break

    case 'logoff':
      if (platform === 'darwin') {
        cmd = 'osascript -e "tell application \\"System Events\\" to log out"'
      } else if (platform === 'win32') {
        cmd = 'shutdown /l'
      }
      break

    case 'sleep':
      if (platform === 'darwin') {
        cmd = 'osascript -e "tell application \\"System Events\\" to sleep"'
      } else if (platform === 'win32') {
        cmd = 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0'
      }
      break

    // 锁定屏幕：macOS 使用 AppleScript 模拟 Ctrl+Cmd+Q，Windows 调用 user32.dll LockWorkStation
    case 'lock-screen':
      if (platform === 'darwin') {
        cmd =
          'osascript -e "tell application \\"System Events\\" to keystroke \\"q\\" using {control down, command down}"'
      } else if (platform === 'win32') {
        cmd = 'rundll32.exe user32.dll,LockWorkStation'
      }
      break

    case 'search':
    case 'bing-search':
      // 旧的硬编码搜索已迁移到网页快开，保留向后兼容
      if (command === 'search') {
        return handleWebSearch(ctx, param, 'https://www.baidu.com/s?wd={q}', '百度搜索')
      }
      return handleWebSearch(ctx, param, 'https://www.bing.com/search?q={q}', '必应搜索')

    case 'open-url':
      return handleOpenUrl(ctx, param)

    case 'window-info':
      return handleWindowInfo(ctx)

    case 'copy-path':
      return handleCopyPath(ctx, execAsync)

    case 'open-terminal':
      return handleOpenTerminal(ctx, execAsync)

    case 'color-picker':
      return handleColorPicker(ctx)

    default:
      // 处理网页快开搜索引擎 (web-search-{id})
      if (command.startsWith('web-search-')) {
        return handleDynamicWebSearch(ctx, param, command)
      }
      return { success: false, error: `Unknown system command: ${command}` }
  }

  if (!cmd) {
    return { success: false, error: `Unsupported platform: ${platform}` }
  }

  console.log('[SystemCmd] 执行系统命令:', cmd)

  try {
    const { stdout, stderr } = await execAsync(cmd)
    if (stderr) console.error('[SystemCmd] 系统命令错误输出:', stderr)
    if (stdout) console.log('[SystemCmd] 系统命令输出:', stdout)

    ctx.mainWindow?.webContents.send('app-launched')
    ctx.mainWindow?.hide()

    return { success: true }
  } catch (error) {
    console.error('[SystemCmd] 执行系统命令失败:', error)
    return { success: false, error: String(error) }
  }
}

function handleClear(ctx: SystemCommandContext): any {
  console.log('[SystemCmd] 执行 Clear 指令：停止所有插件')
  if (ctx.pluginManager) {
    ctx.pluginManager.killAllPlugins()
  }
  ctx.mainWindow?.webContents.send('app-launched')
  return { success: true }
}

function handleClearHistory(ctx: SystemCommandContext): any {
  console.log('[SystemCmd] 执行清除使用记录')
  try {
    // 清空历史记录
    databaseAPI.dbPut('command-history', [])

    // 通知渲染进程刷新历史记录
    ctx.mainWindow?.webContents.send('history-changed')

    // 触发 app-launched 事件（隐藏窗口）
    ctx.mainWindow?.webContents.send('app-launched')
    ctx.mainWindow?.hide()

    console.log('[SystemCmd] 使用记录已清除')
    return { success: true }
  } catch (error) {
    console.error('[SystemCmd] 清除使用记录失败:', error)
    return { success: false, error: String(error) }
  }
}

async function handleWebSearch(
  ctx: SystemCommandContext,
  param: any,
  urlTemplate: string,
  label: string
): Promise<any> {
  console.log(`[SystemCmd] 执行${label}:`, param)
  if (param?.payload) {
    const query = encodeURIComponent(param.payload)
    const url = urlTemplate.replace('{q}', query)
    await shell.openExternal(url)
    ctx.mainWindow?.webContents.send('app-launched')
    ctx.mainWindow?.hide()
    return { success: true }
  }
  return { success: false, error: '缺少搜索关键词' }
}

async function handleDynamicWebSearch(
  ctx: SystemCommandContext,
  param: any,
  featureCode: string
): Promise<any> {
  console.log('[SystemCmd] 执行网页快开搜索:', featureCode, param)
  const engine = await webSearchAPI.getEngineByFeatureCode(featureCode)
  if (!engine) {
    return { success: false, error: '未找到搜索引擎配置' }
  }
  return handleWebSearch(ctx, param, engine.url, engine.name)
}

async function handleOpenUrl(ctx: SystemCommandContext, param: any): Promise<any> {
  console.log('[SystemCmd] 打开网址:', param)
  if (param?.payload) {
    let url = param.payload.trim()
    if (!url.match(/^https?:\/\//i)) {
      url = `https://${url}`
    }
    await shell.openExternal(url)
    ctx.mainWindow?.webContents.send('app-launched')
    ctx.mainWindow?.hide()
    return { success: true }
  }
  return { success: false, error: '缺少网址' }
}

function handleWindowInfo(ctx: SystemCommandContext): any {
  console.log('[SystemCmd] 执行窗口信息')
  const winInfo = windowManager.getPreviousActiveWindow()

  ctx.mainWindow?.hide()

  const items = [
    { label: '窗口标题', value: winInfo?.title || '未知' },
    { label: '坐标 X', value: winInfo?.x ?? '未知' },
    { label: '坐标 Y', value: winInfo?.y ?? '未知' },
    { label: '窗口宽度', value: winInfo?.width ?? '未知' },
    { label: '窗口高度', value: winInfo?.height ?? '未知' },
    { label: '进程 ID', value: winInfo?.pid ?? '未知' },
    { label: '应用', value: winInfo?.app || '未知' },
    { label: '应用位置', value: winInfo?.appPath || '未知' }
  ]

  // macOS 平台添加 Bundle ID
  if (process.platform === 'darwin' && winInfo?.bundleId) {
    items.push({ label: '应用 ID', value: winInfo.bundleId })
  }

  const infoRows = items
    .map(
      (item) =>
        `<div class="row"><span class="label">${item.label}</span><span class="value">${item.value}</span></div>`
    )
    .join('')

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: rgba(0, 0, 0, 0.75);
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    -webkit-app-region: drag;
  }
  .container {
    padding: 32px 40px;
    min-width: 420px;
    -webkit-app-region: no-drag;
    user-select: text;
    cursor: text;
  }
  .title {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 24px;
    color: rgba(255, 255, 255, 0.9);
    letter-spacing: 0.5px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .row:last-child { border-bottom: none; }
  .label {
    color: rgba(255, 255, 255, 0.5);
    font-size: 13px;
    flex-shrink: 0;
    margin-right: 20px;
  }
  .value {
    color: rgba(255, 255, 255, 0.95);
    font-size: 13px;
    font-family: "SF Mono", "Menlo", monospace;
    text-align: right;
    word-break: break-all;
  }
  .hint {
    margin-top: 20px;
    text-align: center;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.3);
  }
</style>
</head>
<body>
  <div class="container">
    <div class="title">窗口信息</div>
    ${infoRows}
    <div class="hint">点击窗口外部区域关闭</div>
  </div>
</body>
</html>`

  const infoWindow = new BrowserWindow({
    width: 500,
    height: 460,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  infoWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  infoWindow.webContents.on('did-finish-load', () => {
    infoWindow.webContents.insertCSS(GLOBAL_SCROLLBAR_CSS)
  })

  infoWindow.on('blur', () => {
    if (!infoWindow.isDestroyed()) {
      infoWindow.close()
    }
  })

  return { success: true }
}

async function handleCopyPath(
  ctx: SystemCommandContext,
  execAsync: (cmd: string) => Promise<{ stdout: string; stderr: string }>
): Promise<any> {
  console.log('[SystemCmd] 执行复制路径')
  const previousWindow = windowManager.getPreviousActiveWindow()

  if (!previousWindow) {
    return { success: false, error: '无法获取当前窗口信息' }
  }

  if (process.platform === 'darwin') {
    try {
      const script = `
      tell application "Finder"
        if (count of Finder windows) is 0 then
          return POSIX path of (desktop as alias)
        else
          return POSIX path of (target of front window as alias)
        end if
      end tell
    `
      const { stdout } = await execAsync(`osascript -e '${script}'`)
      const folderPath = stdout.trim()
      clipboard.writeText(folderPath)
      console.log('[SystemCmd] 已复制路径:', folderPath)
      ctx.mainWindow?.hide()
      return { success: true, path: folderPath }
    } catch (error) {
      console.error('[SystemCmd] 获取 Finder 路径失败:', error)
      return { success: false, error: String(error) }
    }
  }
  return { success: false, error: `不支持的平台: ${process.platform}` }
}

async function handleOpenTerminal(
  ctx: SystemCommandContext,
  execAsync: (cmd: string) => Promise<{ stdout: string; stderr: string }>
): Promise<any> {
  console.log('[SystemCmd] 执行在终端打开')
  const previousWindow = windowManager.getPreviousActiveWindow()

  if (!previousWindow) {
    return { success: false, error: '无法获取当前窗口信息' }
  }

  if (process.platform === 'darwin') {
    try {
      const script = `
      tell application "Finder"
        if (count of Finder windows) is 0 then
          set folderPath to POSIX path of (desktop as alias)
        else
          set folderPath to POSIX path of (target of front window as alias)
        end if
      end tell

      tell application "Terminal"
        activate
        do script "cd " & quoted form of folderPath
      end tell
    `
      await execAsync(`osascript -e '${script}'`)
      console.log('[SystemCmd] 已在终端打开')
      ctx.mainWindow?.hide()
      return { success: true }
    } catch (error) {
      console.error('[SystemCmd] 在终端打开失败:', error)
      return { success: false, error: String(error) }
    }
  }
  return { success: false, error: `不支持的平台: ${process.platform}` }
}

function handleColorPicker(ctx: SystemCommandContext): Promise<any> {
  console.log('[SystemCmd] 执行屏幕取色')
  ctx.mainWindow?.hide()

  return new Promise((resolve) => {
    try {
      ColorPicker.start((result) => {
        if (result.success && result.hex) {
          clipboard.writeText(result.hex)
          console.log('[SystemCmd] 已复制颜色值:', result.hex)
          if (Notification.isSupported()) {
            new Notification({ title: 'ZTools', body: `已复制颜色值: ${result.hex}` }).show()
          }
          resolve({ success: true, hex: result.hex })
        } else {
          console.log('[SystemCmd] 取色已取消')
          resolve({ success: false, error: '取色已取消' })
        }
      })
    } catch (error) {
      console.error('[SystemCmd] 取色失败:', error)
      resolve({ success: false, error: String(error) })
    }
  })
}
