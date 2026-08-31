const { app, shell } = require('electron')
const { fork } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const SKIP_FOLDERS = [
  'sdk',
  'doc',
  'docs',
  'samples',
  'sample',
  'examples',
  'example',
  'demos',
  'demo',
  'documentation'
]

/**
 * 从命令行参数读取指定诊断选项。
 *
 * @param {string} name 选项名称，不包含前导双横线。
 * @returns {string | undefined} 选项值；未传入时返回 undefined。
 */
function readOption(name) {
  const prefix = `--${name}=`
  const argument = process.argv.find((item) => item.startsWith(prefix))
  return argument?.slice(prefix.length)
}

const addonPath = path.resolve(
  process.cwd(),
  readOption('addon') || 'resources/lib/win/ztools_native.node'
)
const nativeAddon = require(addonPath)

/**
 * 创建包含中英文名称、嵌套目录、lnk 和 url 的扫描样本。
 *
 * @param {string} rootPath 样本根目录。
 * @returns {number} 创建的快捷方式文件数量。
 * @throws {Error} 目录或快捷方式创建失败时抛出。
 */
function createFixture(rootPath) {
  const targetPath = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'notepad.exe')
  const nestedPaths = [
    rootPath,
    path.join(rootPath, 'Utilities'),
    path.join(rootPath, '工具'),
    path.join(rootPath, '多层目录', '第二层', '第三层')
  ]

  // 准备内容一致但目录名不同的扫描树。
  for (const nestedPath of nestedPaths) {
    fs.mkdirSync(nestedPath, { recursive: true })
  }

  let shortcutCount = 0
  for (let index = 0; index < 24; index += 1) {
    const parentPath = nestedPaths[index % nestedPaths.length]
    const displayName = index % 2 === 0 ? `Notepad ${index}` : `记事本 ${index}`
    const shortcutPath = path.join(parentPath, `${displayName}.lnk`)

    // 使用 Electron 自身的 Shell API 生成有效快捷方式，避免手工构造 lnk 二进制。
    const created = shell.writeShortcutLink(shortcutPath, {
      target: targetPath,
      description: displayName,
      workingDirectory: path.dirname(targetPath)
    })
    if (!created) {
      throw new Error(`Failed to create shortcut: ${shortcutPath}`)
    }
    shortcutCount += 1
  }

  // 同时覆盖 native scanner 的非 HTTP URL 解析分支。
  fs.writeFileSync(
    path.join(rootPath, '测试协议.url'),
    '[InternetShortcut]\r\nURL=ztools-diagnostic://open\r\nIconFile=C:\\Windows\\System32\\notepad.exe\r\n',
    'utf8'
  )
  shortcutCount += 1

  return shortcutCount
}

/**
 * 在扫描目录内创建指回根目录的 junction，用于验证重解析点循环保护。
 *
 * @param {string} rootPath 扫描样本根目录。
 * @returns {string} 创建的 junction 路径。
 * @throws {Error} junction 创建失败时抛出。
 */
function createLoopJunction(rootPath) {
  const junctionPath = path.join(rootPath, '循环重解析目录')
  fs.symlinkSync(rootPath, junctionPath, 'junction')
  return junctionPath
}

/**
 * 启动全局输入钩子，用于复现 issue 中 Electron 与 uiohook 并存的条件。
 *
 * @returns {() => void} 停止并释放全局输入钩子的清理函数。
 * @throws {Error} uiohook 启动失败时抛出。
 */
function startInputHook() {
  const { uIOhook } = require('uiohook-napi')
  uIOhook.start()

  // 资源清理必须与启动配对，避免 Electron 进程因 hook 线程无法退出。
  return () => uIOhook.stop()
}

/**
 * 对指定目录重复调用 native scanner 并校验返回数量。
 *
 * @param {string} scanPath 待扫描目录。
 * @param {number} expectedCount 预期最少返回条目数。
 * @param {number} iterations 重复扫描次数。
 * @returns {{ iterations: number, entries: number, elapsedMs: number }} 扫描统计。
 * @throws {Error} native 返回条目不足时抛出。
 */
function runScanner(scanPath, expectedCount, iterations) {
  const startedAt = performance.now()
  let entries = []

  // 重复进入字符串转换、目录遍历、COM 并行解析和 N-API 返回值构造路径。
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    entries = nativeAddon.scanWindowsShortcuts([scanPath], [], SKIP_FOLDERS)
    if (entries.length < expectedCount) {
      throw new Error(
        `Unexpected entry count at iteration ${iteration}: ${entries.length} < ${expectedCount}`
      )
    }
  }

  return {
    iterations,
    entries: entries.length,
    elapsedMs: Math.round(performance.now() - startedAt)
  }
}

/**
 * 通过正式 runner 执行一次隔离扫描，并校验 IPC 响应。
 *
 * @param {string} scanPath 待扫描目录。
 * @param {number} expectedCount 预期最少返回条目数。
 * @returns {Promise<number>} 扫描完成后的条目数量。
 * @throws {Error} runner 启动、IPC、native 扫描或响应校验失败时抛出。
 */
function runIsolatedScannerOnce(scanPath, expectedCount) {
  return new Promise((resolve, reject) => {
    const runnerPath = path.resolve('resources/windows-shortcut-scanner-runner.cjs')
    const child = fork(runnerPath, [addonPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false

    /**
     * 完成单次 runner 验证并释放子进程资源。
     *
     * @param {Error | null} error 失败原因；成功时为 null。
     * @param {number} entryCount 成功时的条目数量。
     * @returns {void} 无返回值。
     */
    const finish = (error, entryCount = 0) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (child.connected) child.disconnect()
      if (!child.killed) child.kill()
      if (error) reject(error)
      else resolve(entryCount)
    }

    const timeout = setTimeout(
      () => finish(new Error('Isolated scanner timed out after 20 seconds')),
      20_000
    )
    child.stderr?.on('data', (data) => process.stderr.write(data))
    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) => {
      finish(new Error(`Isolated scanner exited early: code=${code}, signal=${signal}`))
    })
    child.once('message', (message) => {
      if (message?.type !== 'result' || !Array.isArray(message.entries)) {
        finish(new Error(message?.error || 'Invalid isolated scanner response'))
        return
      }
      if (message.entries.length < expectedCount) {
        finish(new Error(`Unexpected isolated entry count: ${message.entries.length}`))
        return
      }
      finish(null, message.entries.length)
    })
    child.send({
      type: 'scan',
      scanPaths: [scanPath],
      rootScanPaths: [],
      skipFolders: SKIP_FOLDERS
    })
  })
}

/**
 * 重复启动正式 runner，验证进程隔离扫描和清理行为。
 *
 * @param {string} scanPath 待扫描目录。
 * @param {number} expectedCount 预期最少返回条目数。
 * @param {number} iterations 重复扫描次数。
 * @returns {Promise<{ iterations: number, entries: number, elapsedMs: number }>} 扫描统计。
 * @throws {Error} 任意一次隔离扫描失败时抛出。
 */
async function runScannerIsolated(scanPath, expectedCount, iterations) {
  const startedAt = performance.now()
  let entries = 0

  // 每轮创建新进程，覆盖主程序实际的故障隔离和资源释放边界。
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    entries = await runIsolatedScannerOnce(scanPath, expectedCount)
  }

  return {
    iterations,
    entries,
    elapsedMs: Math.round(performance.now() - startedAt)
  }
}

/**
 * 执行单个隔离诊断场景并输出机器可读结果。
 *
 * @returns {Promise<void>} 场景完成后结束的 Promise。
 * @throws {Error} 参数无效、样本创建失败或扫描失败时抛出。
 */
async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This diagnostic only supports Windows')
  }

  const pathKind = readOption('path') || 'ascii'
  const hookEnabled = readOption('hook') === 'on'
  const baseKind = readOption('base') || 'temp'
  const junctionEnabled = readOption('junction') === 'loop'
  const isolationEnabled = readOption('isolate') === 'on'
  const iterations = Number.parseInt(readOption('iterations') || '50', 10)
  if (
    !['ascii', 'unicode'].includes(pathKind) ||
    !['temp', 'onedrive'].includes(baseKind) ||
    !Number.isInteger(iterations) ||
    iterations < 1
  ) {
    throw new Error(
      'Expected --path=ascii|unicode, --base=temp|onedrive and a positive --iterations value'
    )
  }

  await app.whenReady()

  const caseName = `${baseKind}-${pathKind}-${hookEnabled ? 'hook' : 'plain'}-${process.pid}`
  const basePath =
    baseKind === 'onedrive' ? process.env.OneDrive || process.env.OneDriveConsumer : os.tmpdir()
  if (!basePath) {
    throw new Error('OneDrive base path is unavailable')
  }

  const expectedParent = path.join(basePath, 'ztools-windows-scanner-diagnostic')
  const diagnosticRoot = path.join(expectedParent, caseName)
  const scanPath = path.join(
    diagnosticRoot,
    pathKind === 'unicode' ? 'OneDrive 模拟目录' : 'onedrive-simulated',
    pathKind === 'unicode' ? '桌面' : 'desktop'
  )
  let stopInputHook = null
  let junctionPath = null

  try {
    // 每个进程使用独立根目录，防止崩溃场景污染其他对照组。
    fs.mkdirSync(diagnosticRoot, { recursive: true })
    const fixtureCount = createFixture(scanPath)
    if (junctionEnabled) {
      junctionPath = createLoopJunction(scanPath)
    }
    if (hookEnabled) {
      stopInputHook = startInputHook()
    }

    const result = isolationEnabled
      ? await runScannerIsolated(scanPath, fixtureCount, iterations)
      : runScanner(scanPath, fixtureCount, iterations)
    console.log(
      JSON.stringify({
        status: 'passed',
        pathKind,
        hookEnabled,
        baseKind,
        junctionEnabled,
        isolationEnabled,
        scanPath,
        ...result
      })
    )
  } finally {
    // 先释放进程级 hook，再删除精确限定在诊断父目录下的样本。
    stopInputHook?.()
    if (junctionPath) {
      fs.unlinkSync(junctionPath)
    }
    if (path.resolve(diagnosticRoot).startsWith(`${path.resolve(expectedParent)}${path.sep}`)) {
      fs.rmSync(diagnosticRoot, { recursive: true, force: true })
      try {
        // 仅在所有诊断场景已清理、父目录确实为空时删除公共诊断目录。
        fs.rmdirSync(expectedParent)
      } catch (error) {
        if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') {
          throw error
        }
      }
    }
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
