import { app } from 'electron'
import pluginDeviceAPI from '../../api/plugin/device'
import { httpRequest } from '../../utils/httpRequest'
import { DEFAULT_SYNC_SERVER_URL, syncServerUrlToHttp } from '../../api/renderer/pluginMarketConfig'
import {
  loadOfficialAccountSession,
  refreshOfficialAccountTokens
} from '../account/officialAccountService'
import type { CredentialSession } from '../auth/credentialSessionService'
import {
  getUpdateChannel,
  getUpdateSystemType,
  type ServerUpdateInfo
} from '../../api/serverUpdateCatalog'

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000

class ActivityHeartbeatService {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private updateHandler: ((update: ServerUpdateInfo | null) => void | Promise<void>) | null = null

  /**
   * 注册心跳更新信息的消费回调。
   * @param handler 接收服务端更新信息的回调函数。
   * @returns 无返回值。
   */
  setUpdateHandler(handler: (update: ServerUpdateInfo | null) => void | Promise<void>): void {
    this.updateHandler = handler
  }

  start(): void {
    if (this.timer) return
    void this.sendHeartbeat()
    this.timer = setInterval(() => {
      void this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 立即触发一次官方服务心跳；E2E 模式跳过真实网络请求以保持测试隔离。
   * @returns 无返回值。
   */
  runNow(): void {
    if (process.env.ZTOOLS_E2E === '1') return
    void this.sendHeartbeat()
  }

  /**
   * 上报当前设备活跃状态，并在访问令牌过期时通过统一服务刷新后重试一次。
   * @returns 上报完成后的 Promise。
   */
  private async sendHeartbeat(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const config = await this.loadConfig()
      const response = await this.postHeartbeat(config)
      if (response.status !== 401) {
        await this.updateHandler?.(response.update)
        return
      }
      const refreshed = await refreshOfficialAccountTokens(config?.refreshToken)
      if (
        (refreshed.status === 'refreshed' || refreshed.status === 'reused') &&
        refreshed.session.token
      ) {
        const retry = await this.postHeartbeat(refreshed.session)
        await this.updateHandler?.(retry.update)
      } else if (refreshed.status === 'invalid') {
        // 登录凭据确认失效后仍以匿名心跳获取版本更新信息。
        const retry = await this.postHeartbeat(null)
        await this.updateHandler?.(retry.update)
      }
    } catch (error) {
      console.warn('[ActivityHeartbeat] 上报失败:', error)
    } finally {
      this.inFlight = false
    }
  }

  /**
   * 向官方服务端提交当前设备的活跃心跳和 ZTools 版本。
   * @param config 当前同步账号配置；未登录时为 null
   * @returns 服务端返回的 HTTP 状态码和更新信息
   */
  private async postHeartbeat(
    config: CredentialSession | null
  ): Promise<{ status: number; update: ServerUpdateInfo | null }> {
    const deviceId = pluginDeviceAPI.getDeviceIdPublic()
    const token = config?.serverUrl === DEFAULT_SYNC_SERVER_URL ? config.token : ''

    // 使用 Electron 实际应用版本，确保开发和打包环境的上报来源一致。
    const ztoolsVersion = app.getVersion()
    const response = await httpRequest(
      `${syncServerUrlToHttp(DEFAULT_SYNC_SERVER_URL)}/api/activity/heartbeat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          deviceId,
          uid: token ? config?.username || '' : '',
          ztoolsVersion,
          systemType: getUpdateSystemType(),
          updateChannel: getUpdateChannel()
        }),
        validateStatus: (status) => (status >= 200 && status < 300) || status === 401
      }
    )
    return {
      status: response.status,
      update: response.status === 200 ? (response.data?.update ?? null) : null
    }
  }

  /**
   * 从设备级路由存储读取心跳所需的账号配置。
   * @returns 当前配置；读取失败或未配置时返回 null。
   */
  private async loadConfig(): Promise<CredentialSession | null> {
    return loadOfficialAccountSession()
  }
}

export default new ActivityHeartbeatService()
