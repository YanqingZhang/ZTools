import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/api/shared/database', () => ({
  default: { dbGet: vi.fn(), dbPut: vi.fn() }
}))

vi.mock('../../src/main/core/native/index.js', () => ({
  WindowManager: { getActiveWindow: vi.fn() }
}))

const { isFullscreenWindow, isWindowsDesktopWindow } =
  await import('../../src/main/core/dndManager')

describe('isFullscreenWindow', () => {
  it('macOS 只使用 native 返回的全屏状态', () => {
    expect(isFullscreenWindow({ app: 'Safari.app', isFullscreen: true }, 'darwin')).toBe(true)
    expect(
      isFullscreenWindow(
        { app: 'Safari.app', isFullscreen: false, x: 0, y: 33, width: 1470, height: 923 },
        'darwin'
      )
    ).toBe(false)
    expect(
      isFullscreenWindow({ app: 'Safari.app', x: 0, y: 33, width: 1470, height: 923 }, 'darwin')
    ).toBe(false)
  })

  it('Windows 只使用 native 返回的全屏状态', () => {
    expect(
      isFullscreenWindow(
        { app: 'game.exe', x: 0, y: 0, width: 1920, height: 1080, isFullscreen: true },
        'win32'
      )
    ).toBe(true)
    expect(
      isFullscreenWindow(
        { app: 'app.exe', x: 0, y: 0, width: 1920, height: 1080, isFullscreen: false },
        'win32'
      )
    ).toBe(false)
  })

  it('即使 native 状态异常也排除 Windows 桌面 Shell 窗口', () => {
    for (const className of ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']) {
      expect(
        isFullscreenWindow({ app: 'explorer.exe', className, isFullscreen: true }, 'win32')
      ).toBe(false)
      expect(isWindowsDesktopWindow({ app: 'explorer.exe', className })).toBe(true)
    }
  })

  it('不把全屏 Explorer 文件夹窗口当作桌面', () => {
    expect(isWindowsDesktopWindow({ app: 'explorer.exe', className: 'CabinetWClass' })).toBe(false)
    expect(
      isFullscreenWindow(
        { app: 'explorer.exe', className: 'CabinetWClass', isFullscreen: true },
        'win32'
      )
    ).toBe(true)
  })

  it('Windows native 字段缺失时按非全屏处理', () => {
    expect(
      isFullscreenWindow({ app: 'app.exe', x: 0, y: 0, width: 3840, height: 2160 }, 'win32')
    ).toBe(false)
  })

  it('不支持的平台按非全屏处理', () => {
    expect(isFullscreenWindow({ app: 'app', isFullscreen: true }, 'linux')).toBe(false)
  })

  it('排除 ZTools 自身窗口', () => {
    expect(
      isFullscreenWindow({ app: 'ZTools.app', pid: process.pid, isFullscreen: true }, 'darwin')
    ).toBe(false)
  })
})
