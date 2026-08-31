import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUserInfo: vi.fn(),
  registerPluginApiServices: vi.fn()
}))

vi.mock('electron', () => ({ app: { getVersion: vi.fn(() => '3.0.2') } }))
vi.mock('../../src/main/core/account/userProfileStore', () => ({
  getCurrentUserInfo: mocks.getCurrentUserInfo
}))
vi.mock('../../src/main/api/plugin/pluginApiDispatcher', () => ({
  registerPluginApiServices: mocks.registerPluginApiServices
}))
vi.mock('../../src/main/api/plugin/device', () => ({
  default: { getDeviceIdPublic: vi.fn(() => 'device-1') }
}))
vi.mock('../../src/main/core/account/officialAccountService', () => ({
  loadOfficialAccountSession: vi.fn(),
  refreshOfficialAccountTokens: vi.fn()
}))
vi.mock('../../src/main/utils/httpRequest.js', () => ({ httpRequest: vi.fn() }))

import pluginUserAPI from '../../src/main/api/plugin/user'

describe('plugin user API registration', () => {
  it('registers synchronous user info and asynchronous temporary token handlers', () => {
    const user = { avatar: 'avatar.png', nickname: 'Zing', uid: 'zing' }
    mocks.getCurrentUserInfo.mockReturnValue(user)
    const pluginManager = {
      getPluginManifestNameByWebContents: vi.fn(() => 'quick-translate')
    }

    pluginUserAPI.init(pluginManager as any)

    const services = mocks.registerPluginApiServices.mock.calls[0][0]
    const event = { returnValue: undefined } as unknown as Electron.IpcMainEvent
    services.getUser(event)

    expect(event.returnValue).toEqual(user)
    expect(services.getUserTempToken).toBeTypeOf('function')
  })
})
