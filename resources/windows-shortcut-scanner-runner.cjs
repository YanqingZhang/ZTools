const path = require('path')

const addonPath = process.argv[2]
if (!addonPath || !path.isAbsolute(addonPath)) {
  throw new Error('An absolute native addon path is required')
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nativeAddon = require(addonPath)

/**
 * 校验主进程发送的扫描请求，避免 malformed IPC 数据进入 native 层。
 *
 * @param {unknown} message 待校验的 IPC 消息。
 * @returns {message is { type: 'scan'; scanPaths: string[]; rootScanPaths: string[]; skipFolders: string[] }} 是否为有效扫描请求。
 */
function isScanRequest(message) {
  return (
    typeof message === 'object' &&
    message !== null &&
    message.type === 'scan' &&
    Array.isArray(message.scanPaths) &&
    Array.isArray(message.rootScanPaths) &&
    Array.isArray(message.skipFolders) &&
    message.scanPaths.every((item) => typeof item === 'string') &&
    message.rootScanPaths.every((item) => typeof item === 'string') &&
    message.skipFolders.every((item) => typeof item === 'string')
  )
}

/**
 * 执行一次 native 快捷方式扫描，并将结果或可恢复错误发回主进程。
 *
 * @param {unknown} message 主进程发送的 IPC 消息。
 * @returns {void} 无返回值。
 */
function handleMessage(message) {
  if (!isScanRequest(message)) {
    process.send?.({ type: 'error', error: 'Invalid Windows shortcut scan request' })
    return
  }

  const scanStartedAt = process.hrtime.bigint()
  try {
    // native 访问冲突只会终止当前 runner，不会影响 Electron 主进程。
    const entries = nativeAddon.scanWindowsShortcuts(
      message.scanPaths,
      message.rootScanPaths,
      message.skipFolders
    )
    const nativeElapsedMs = Number(process.hrtime.bigint() - scanStartedAt) / 1_000_000
    process.send?.({ type: 'result', entries, nativeElapsedMs })
    console.error(`[scanWindowsShortcuts] native 扫描 lnk 耗时 ${nativeElapsedMs.toFixed(2)} ms`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const nativeElapsedMs = Number(process.hrtime.bigint() - scanStartedAt) / 1_000_000
    process.send?.({ type: 'error', error: errorMessage, nativeElapsedMs })
    console.error(
      `[scanWindowsShortcuts] native 扫描 lnk 失败，耗时 ${nativeElapsedMs.toFixed(2)} ms`
    )
  }
}

process.once('message', handleMessage)
