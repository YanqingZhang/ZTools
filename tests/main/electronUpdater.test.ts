import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CancellationToken } from 'builder-util-runtime'
import type { PlatformUpdaterCallbacks } from '../../src/main/api/platformUpdater/types'

const updaterMocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

vi.mock('electron-log', () => ({
  default: {}
}))

vi.mock('electron-updater', () => ({
  NsisUpdater: class {},
  autoUpdater: {
    currentVersion: { prerelease: [], version: '3.0.2' },
    downloadUpdate: updaterMocks.downloadUpdate,
    checkForUpdates: updaterMocks.checkForUpdates,
    quitAndInstall: updaterMocks.quitAndInstall,
    setFeedURL: updaterMocks.setFeedURL,
    on: updaterMocks.on
  }
}))

import { ElectronUpdaterService } from '../../src/main/api/electronUpdater'

describe('ElectronUpdaterService cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updaterMocks.checkForUpdates.mockResolvedValue({
      updateInfo: { version: '3.1.0', releaseNotes: 'New version' }
    })
    updaterMocks.downloadUpdate.mockImplementation(
      (cancellationToken: CancellationToken) =>
        new Promise((_resolve, reject) => {
          cancellationToken.once('cancel', () => reject(new Error('cancelled')))
        })
    )
  })

  it('cancels an active download without installing and allows a new download', async () => {
    const callbacks: PlatformUpdaterCallbacks = {
      onDownloadStart: vi.fn(),
      onDownloadProgress: vi.fn(),
      onDownloadCancelled: vi.fn(),
      onDownloaded: vi.fn(),
      onDownloadFailed: vi.fn(),
      onBeforeInstall: vi.fn()
    }
    const service = new ElectronUpdaterService(callbacks)
    await service.checkForUpdates()

    // 启动下载后立即取消，验证安装流程不会继续执行。
    const firstDownload = service.downloadAndInstall()
    const cancelResult = await service.cancelUpdate()

    expect(cancelResult).toEqual({ success: true, cancelled: true })
    await expect(firstDownload).resolves.toEqual({ success: false, cancelled: true })
    expect(service.getDownloadStatus().status).toBe('available')
    expect(callbacks.onDownloadCancelled).toHaveBeenCalledOnce()
    expect(callbacks.onDownloadFailed).not.toHaveBeenCalled()
    expect(updaterMocks.quitAndInstall).not.toHaveBeenCalled()

    // 模拟底层下载进入无法中断的收尾阶段，完成后仍不得继续安装。
    let finishSecondDownload: (() => void) | null = null
    updaterMocks.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          finishSecondDownload = () => resolve(['/update'])
        })
    )
    const secondDownload = service.downloadUpdate(false)
    expect(updaterMocks.downloadUpdate).toHaveBeenCalledTimes(2)
    const secondCancellation = service.cancelUpdate()
    finishSecondDownload?.()

    await expect(secondCancellation).resolves.toEqual({ success: true, cancelled: true })
    await expect(secondDownload).resolves.toEqual({ success: false, cancelled: true })
    expect(callbacks.onDownloadCancelled).toHaveBeenCalledTimes(2)
    expect(updaterMocks.quitAndInstall).not.toHaveBeenCalled()
  })
})
