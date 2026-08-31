import { app } from 'electron'
import { getUpdateChannel } from '../serverUpdateCatalog'
import {
  DEFAULT_SYNC_SERVER_URL,
  PluginMarketAuthMode,
  PluginMarketAuthRequiredError,
  requestPluginMarket,
  syncServerUrlToHttp
} from './pluginMarketConfig'

export type ZToolsNotificationItem = {
  id: number
  type: 'comment_reply' | 'system_announcement' | string
  title: string
  content: string
  level: 'info' | 'warning' | 'important' | string
  payload: Record<string, unknown>
  read: boolean
  createdAt: number
}

export type ZToolsNotificationPage = {
  items: ZToolsNotificationItem[]
  nextBeforeId: number
  unreadCount: number
  hasMore: boolean
  hasMoreUnread: boolean
}

export type ZToolsNotificationSummary = {
  unreadCount: number
  latestId: number
  hasMoreUnread: boolean
}

type NotificationResult<T> = {
  success: boolean
  data?: T
  error?: string
  authRequired?: boolean
}

class NotificationsAPI {
  /**
   * 获取当前账号和客户端环境适用的消息摘要。
   * @returns 未读数量和最新消息标识；请求失败时返回错误信息。
   */
  public async summary(): Promise<NotificationResult<ZToolsNotificationSummary>> {
    try {
      const response = await requestPluginMarket(this.url('/api/notifications/summary'))
      return { success: true, data: parseSummary(response.data) }
    } catch (error: unknown) {
      return notificationError(error, '消息摘要加载失败')
    }
  }

  /**
   * 按游标获取消息列表。
   * @param beforeId 上一页最后一条消息标识，首页传 0。
   * @param limit 单次返回数量。
   * @param unreadOnly 是否只请求未读消息。
   * @returns 消息列表及下一页游标；请求失败时返回错误信息。
   */
  public async list(
    beforeId = 0,
    limit = 20,
    unreadOnly = false
  ): Promise<NotificationResult<ZToolsNotificationPage>> {
    try {
      const query = this.query()
      if (beforeId > 0) query.set('beforeId', String(beforeId))
      query.set('limit', String(limit))
      if (unreadOnly) query.set('filter', 'unread')
      const response = await requestPluginMarket(
        `${syncServerUrlToHttp(DEFAULT_SYNC_SERVER_URL)}/api/notifications?${query.toString()}`
      )
      return { success: true, data: parsePage(response.data) }
    } catch (error: unknown) {
      return notificationError(error, '消息列表加载失败')
    }
  }

  /**
   * 将一条消息标记为已读。
   * @param id 消息标识。
   * @returns 操作结果。
   */
  public async markRead(id: number): Promise<NotificationResult<void>> {
    return this.postAction(`/api/notifications/${id}/read`, '标记消息已读失败')
  }

  /**
   * 将当前客户端环境适用的消息全部标记为已读。
   * @returns 操作结果。
   */
  public async markAllRead(): Promise<NotificationResult<void>> {
    return this.postAction('/api/notifications/read-all', '全部标记已读失败')
  }

  /**
   * 归档一条消息并同步设置为已读。
   * @param id 消息标识。
   * @returns 操作结果。
   */
  public async archive(id: number): Promise<NotificationResult<void>> {
    return this.postAction(`/api/notifications/${id}/archive`, '归档消息失败')
  }

  /**
   * 调用需要登录的通知操作接口。
   * @param path 服务端通知接口路径。
   * @param fallback 请求失败时使用的默认错误。
   * @returns 操作结果。
   */
  private async postAction(path: string, fallback: string): Promise<NotificationResult<void>> {
    try {
      await requestPluginMarket(this.url(path), { method: 'POST' }, PluginMarketAuthMode.REQUIRED)
      return { success: true }
    } catch (error: unknown) {
      return notificationError(error, fallback)
    }
  }

  /**
   * 构造带客户端平台、版本和更新渠道的通知接口地址。
   * @param path 服务端通知接口路径。
   * @returns 完整通知接口地址。
   */
  private url(path: string): string {
    return `${syncServerUrlToHttp(DEFAULT_SYNC_SERVER_URL)}${path}?${this.query().toString()}`
  }

  /**
   * 构造服务端公告范围过滤使用的客户端参数。
   * @returns 客户端平台、版本和更新渠道查询参数。
   */
  private query(): URLSearchParams {
    return new URLSearchParams({
      systemType: process.platform,
      updateChannel: getUpdateChannel(),
      version: app.getVersion()
    })
  }
}

/**
 * 将服务端消息摘要转换为稳定的客户端类型。
 * @param value 服务端原始响应。
 * @returns 归一化后的消息摘要。
 */
function parseSummary(value: unknown): ZToolsNotificationSummary {
  const data = parseObject(value)
  return {
    unreadCount: Number(data.unreadCount || 0),
    latestId: Number(data.latestId || 0),
    hasMoreUnread: Boolean(data.hasMoreUnread)
  }
}

/**
 * 将服务端消息列表转换为稳定的客户端类型。
 * @param value 服务端原始响应。
 * @returns 归一化后的消息列表。
 */
function parsePage(value: unknown): ZToolsNotificationPage {
  const data = parseObject(value)
  const items = Array.isArray(data.items) ? data.items.map(parseItem) : []
  return {
    items,
    nextBeforeId: Number(data.nextBeforeId || 0),
    unreadCount: Number(data.unreadCount || 0),
    hasMore: Boolean(data.hasMore),
    hasMoreUnread: Boolean(data.hasMoreUnread)
  }
}

/**
 * 归一化一条服务端消息。
 * @param value 服务端原始消息。
 * @returns 客户端消息对象。
 */
function parseItem(value: unknown): ZToolsNotificationItem {
  const item = parseObject(value)
  return {
    id: Number(item.id || 0),
    type: String(item.type || ''),
    title: String(item.title || ''),
    content: String(item.content || ''),
    level: String(item.level || 'info'),
    payload: parseObject(item.payload),
    read: Boolean(item.read),
    createdAt: Number(item.createdAt || 0)
  }
}

/**
 * 将未知响应安全转换为普通对象。
 * @param value 原始响应值。
 * @returns 可读取的普通对象。
 */
function parseObject(value: unknown): Record<string, any> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, any>
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, any>) : {}
}

/**
 * 将通知请求异常转换为统一结果。
 * @param error 请求异常。
 * @param fallback 默认错误信息。
 * @returns 失败结果。
 */
function notificationError(error: unknown, fallback: string): NotificationResult<never> {
  if (error instanceof PluginMarketAuthRequiredError) {
    return { success: false, error: error.message, authRequired: true }
  }
  return { success: false, error: error instanceof Error ? error.message : fallback }
}

export default new NotificationsAPI()
