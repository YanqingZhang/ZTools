import { fork, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve(__dirname, '../..')
const runnerPath = path.join(projectRoot, 'resources', 'windows-shortcut-scanner-runner.cjs')
const addonPath = path.join(projectRoot, 'resources', 'lib', 'win', 'ztools_native.node')
const children = new Set<ChildProcess>()

type RunnerResponse = { type: 'result'; entries: unknown[] } | { type: 'error'; error: string }

/**
 * 启动正式 scanner runner 并发送一次 IPC 请求。
 *
 * @param message 待发送给 runner 的扫描请求。
 * @param nativeAddonPath runner 加载的 native 模块路径。
 * @returns runner 返回的结果或错误消息。
 * @throws runner 启动失败、提前退出或超时时抛出。
 */
function requestRunner(
  message: unknown,
  nativeAddonPath: string = addonPath
): Promise<RunnerResponse> {
  return new Promise((resolve, reject) => {
    const child = fork(runnerPath, [nativeAddonPath], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    children.add(child)
    let settled = false

    /**
     * 完成测试请求并清理子进程。
     *
     * @param error 失败原因；成功时为 null。
     * @param response runner 成功发送的响应。
     * @returns 无返回值。
     */
    const finish = (error: Error | null, response?: RunnerResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      children.delete(child)
      if (child.connected) child.disconnect()
      if (!child.killed) child.kill()

      if (error) reject(error)
      else resolve(response!)
    }

    const timeout = setTimeout(() => finish(new Error('runner test timed out')), 10_000)
    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) => {
      finish(new Error(`runner exited early: code=${code}, signal=${signal}`))
    })
    child.once('message', (response) => finish(null, response as RunnerResponse))
    child.send(message)
  })
}

afterEach(() => {
  // 失败断言也必须回收所有仍存活的 runner。
  for (const child of children) {
    if (child.connected) child.disconnect()
    if (!child.killed) child.kill()
  }
  children.clear()
})

describe.runIf(process.platform === 'win32')('Windows shortcut scanner runner', () => {
  it('扫描中文空目录并返回空结果', async () => {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-scanner-runner-'))
    const scanPath = path.join(testRoot, 'OneDrive', '桌面')
    await fs.mkdir(scanPath, { recursive: true })

    try {
      const response = await requestRunner({
        type: 'scan',
        scanPaths: [scanPath],
        rootScanPaths: [],
        skipFolders: []
      })

      expect(response).toMatchObject({ type: 'result', entries: [] })
      expect(response.type).toBe('result')
      expect(response).toHaveProperty('nativeElapsedMs', expect.any(Number))
    } finally {
      // 临时样本必须精确限定在本测试创建的目录内。
      await fs.rm(testRoot, { recursive: true, force: true })
    }
  })

  it('拒绝非法 IPC 请求而不崩溃', async () => {
    const response = await requestRunner({ type: 'scan', scanPaths: 'invalid' })
    expect(response).toEqual({ type: 'error', error: 'Invalid Windows shortcut scan request' })
  })

  it('native 加载失败只终止 runner', async () => {
    const missingAddonPath = path.join(os.tmpdir(), 'missing-ztools-native.node')
    await expect(requestRunner({ type: 'scan' }, missingAddonPath)).rejects.toThrow(
      /runner exited early/
    )

    // 当前 Vitest worker 能继续执行即证明父进程未被 runner 失败带走。
    expect(process.pid).toBeGreaterThan(0)
  })
})
