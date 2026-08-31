import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const moduleLoader = require('module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
}
const preloadPath = require.resolve('../../resources/preload.js')
const originalLoad = moduleLoader._load

describe('plugin preload user bridges', () => {
  const ipcInvoke = vi.fn()
  const ipcOn = vi.fn()
  const ipcSend = vi.fn()
  const ipcSendSync = vi.fn()
  const ipcRemoveListener = vi.fn()
  const ipcEmit = vi.fn()

  beforeEach(() => {
    delete require.cache[preloadPath]
    ipcInvoke.mockReset()
    ipcInvoke.mockImplementation((_channel: string, apiName?: string) => {
      if (apiName === 'getUserTempToken') {
        return Promise.resolve({ token: 'plugin-token', expiredAt: 1_800_000_000_000 })
      }
      return Promise.resolve(undefined)
    })
    ipcOn.mockReset()
    ipcSend.mockReset()
    ipcSendSync.mockReset().mockImplementation((channel: string, apiName?: string) => {
      if (channel === 'get-os-type') return 'Darwin'
      if (channel === 'plugin.api' && apiName === 'getUser') {
        return { avatar: 'avatar.png', nickname: 'Zing', uid: 'zing' }
      }
      return undefined
    })
    ipcRemoveListener.mockReset()
    ipcEmit.mockReset()
    ;(globalThis as any).window = { addEventListener: vi.fn() }

    moduleLoader._load = ((request: string, parent: unknown, isMain: boolean) => {
      if (request === 'electron') {
        return {
          ipcRenderer: {
            invoke: ipcInvoke,
            on: ipcOn,
            send: ipcSend,
            sendSync: ipcSendSync,
            removeListener: ipcRemoveListener,
            emit: ipcEmit
          }
        }
      }

      return originalLoad.call(moduleLoader, request, parent, isMain)
    }) as typeof originalLoad
  })

  afterEach(() => {
    delete require.cache[preloadPath]
    moduleLoader._load = originalLoad
    delete (globalThis as any).window
  })

  it('exposes getUser through the synchronous plugin.api channel', () => {
    require(preloadPath)

    expect((globalThis as any).window.ztools.getUser()).toEqual({
      avatar: 'avatar.png',
      nickname: 'Zing',
      uid: 'zing'
    })
    expect(ipcSendSync).toHaveBeenCalledWith('plugin.api', 'getUser', undefined)
  })

  it('exposes getUserTempToken through the asynchronous plugin.api channel', async () => {
    require(preloadPath)

    await expect((globalThis as any).window.ztools.getUserTempToken()).resolves.toEqual({
      token: 'plugin-token',
      expiredAt: 1_800_000_000_000
    })
    expect(ipcInvoke).toHaveBeenCalledWith('plugin.api', 'getUserTempToken', undefined)
  })
})
