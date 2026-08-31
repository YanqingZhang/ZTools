import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  electronRegister: vi.fn(),
  electronUnregister: vi.fn(),
  ensureListener: vi.fn(),
  registerShortcut: vi.fn(),
  unregisterShortcut: vi.fn(),
  stopListener: vi.fn(),
  prepareGlobalShortcut: vi.fn(),
  captureCurrentActiveWindow: vi.fn()
}))

vi.mock('electron', () => ({
  app: {},
  globalShortcut: {
    register: mocks.electronRegister,
    unregister: mocks.electronUnregister
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: {}
}))

vi.mock('../../src/main/core/native/index.js', () => ({
  OptimizedShortcutManager: {
    ensureListener: mocks.ensureListener,
    registerShortcut: mocks.registerShortcut,
    unregisterShortcut: mocks.unregisterShortcut,
    stopListener: mocks.stopListener
  },
  WindowManager: {}
}))

vi.mock('../../src/main/appMain.js', () => ({
  getCurrentShortcut: vi.fn(),
  updateShortcut: vi.fn()
}))

vi.mock('../../src/main/core/dndManager.js', () => ({
  default: { shouldIgnoreHotkeys: vi.fn(() => false) }
}))

vi.mock('../../src/main/core/doubleTapManager.js', () => ({
  default: {
    acquireKeyboardState: vi.fn(() => vi.fn()),
    register: vi.fn(),
    unregister: vi.fn()
  }
}))

vi.mock('../../src/main/managers/proxyManager.js', () => ({ default: {} }))
vi.mock('../../src/main/managers/windowManager.js', () => ({
  default: { captureCurrentActiveWindow: mocks.captureCurrentActiveWindow }
}))
vi.mock('../../src/main/core/screenCapture.js', () => ({ primeScreenCaptureFrame: vi.fn() }))
vi.mock('../../src/main/api/shared/database.js', () => ({
  default: { dbGet: vi.fn(), dbPut: vi.fn() }
}))
vi.mock('../../src/main/api/index.js', () => ({
  default: { prepareGlobalShortcut: mocks.prepareGlobalShortcut }
}))

const { SettingsAPI } = await import('../../src/main/api/renderer/settings')

describe('SettingsAPI optimized shortcut fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureListener.mockImplementation(() => {
      throw new Error('listener startup timed out')
    })
    mocks.unregisterShortcut.mockReturnValue({ success: true })
    mocks.electronRegister.mockReturnValue(true)
    mocks.prepareGlobalShortcut.mockResolvedValue({
      target: 'demo/action',
      shouldCaptureSelectedText: false
    })
  })

  it('native listener startup failure falls back to Electron globalShortcut', async () => {
    const settings = new SettingsAPI()

    const result = await settings.registerGlobalShortcut('Alt+F', 'demo/action', false, true)

    expect(result).toMatchObject({ success: true, degraded: true })
    expect(mocks.ensureListener).toHaveBeenCalledOnce()
    expect(mocks.unregisterShortcut).toHaveBeenCalledWith('Alt+F')
    expect(mocks.stopListener).toHaveBeenCalledOnce()
    expect(mocks.electronRegister).toHaveBeenCalledWith('Alt+F', expect.any(Function))
  })

  it('captures the active window before handling a global shortcut', async () => {
    const settings = new SettingsAPI()
    const handler = vi.fn()
    settings.setGlobalShortcutHandler(handler)

    await settings.registerGlobalShortcut('Alt+F', 'demo/action', false, false)
    const shortcutHandler = mocks.electronRegister.mock.calls.at(-1)?.[1]

    shortcutHandler()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith('demo/action', undefined))

    expect(mocks.captureCurrentActiveWindow).toHaveBeenCalledOnce()
    expect(mocks.captureCurrentActiveWindow.mock.invocationCallOrder[0]).toBeLessThan(
      handler.mock.invocationCallOrder[0]
    )
  })
})
