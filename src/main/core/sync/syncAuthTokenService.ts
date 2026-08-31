import { onOfficialAccountInvalidated } from '../account/officialAccountService'
import type { CredentialSession } from '../auth/credentialSessionService'
import {
  clearActiveRejectedAccessToken,
  loadSyncProfile,
  onPrivateSyncSessionInvalidated,
  refreshActiveSyncSession,
  resolveSyncRuntimeConfig
} from './syncProfileService'
import type { SyncConfig } from './types'

export type StoredSyncConfig = Partial<SyncConfig>

export type StoredTokenRefreshResult =
  | { status: 'refreshed' | 'reused'; config: StoredSyncConfig }
  | { status: 'invalid'; config: StoredSyncConfig }
  | { status: 'unavailable'; config: StoredSyncConfig | null; error?: unknown }

type CredentialsInvalidatedListener = (config: StoredSyncConfig) => void

const listeners = new Set<CredentialsInvalidatedListener>()
let sourceListenersBound = false

/**
 * 读取当前同步方式解析后的 SyncClient 运行配置。
 * @returns 包含活动服务凭据的配置；读取失败时返回 null。
 */
export async function loadStoredSyncConfig(): Promise<StoredSyncConfig | null> {
  try {
    return await resolveSyncRuntimeConfig()
  } catch {
    return null
  }
}

/**
 * 监听当前同步凭据被服务端确认失效的事件。
 * @param listener 凭据失效后的处理函数。
 * @returns 用于取消监听的清理函数。
 */
export function onSyncCredentialsInvalidated(listener: CredentialsInvalidatedListener): () => void {
  bindCredentialSourceListeners()
  listeners.add(listener)
  return (): void => {
    listeners.delete(listener)
  }
}

/**
 * 刷新当前同步方式对应的 token，并重新解析完整运行配置。
 * @param expectedRefreshToken 调用方持有的 refresh token 快照。
 * @returns 与旧 SyncClient 接口兼容的刷新结果。
 */
export async function refreshStoredSyncTokens(
  expectedRefreshToken?: string
): Promise<StoredTokenRefreshResult> {
  const result = await refreshActiveSyncSession(expectedRefreshToken)
  const config = await loadStoredSyncConfig()
  if (result.status === 'unavailable') {
    return { status: 'unavailable', config, error: result.error }
  }
  return {
    status: result.status,
    config: config || sessionToConfig(result.session)
  }
}

/**
 * 清理当前同步方式已被拒绝的 refresh token。
 * @param expectedRefreshToken 被服务端拒绝的 refresh token 快照。
 * @returns 清理后的运行配置。
 */
export async function clearInvalidStoredCredentials(
  expectedRefreshToken: string
): Promise<StoredSyncConfig | null> {
  const current = await loadStoredSyncConfig()
  if (!current || current.refreshToken !== expectedRefreshToken) return current
  await refreshActiveSyncSession(expectedRefreshToken)
  return loadStoredSyncConfig()
}

/**
 * 清理当前同步方式已被拒绝的访问令牌。
 * @param expectedAccessToken 被服务端拒绝的访问令牌快照。
 * @returns 清理后的运行配置。
 */
export async function clearInvalidStoredAccessToken(
  expectedAccessToken: string
): Promise<StoredSyncConfig | null> {
  await clearActiveRejectedAccessToken(expectedAccessToken)
  return loadStoredSyncConfig()
}

/**
 * 首次监听时绑定官方和私服会话事件，并只转发当前同步方式的失效状态。
 * @returns 无返回值。
 */
function bindCredentialSourceListeners(): void {
  if (sourceListenersBound) return
  sourceListenersBound = true
  onOfficialAccountInvalidated((session) => {
    void notifyIfActive('official', session)
  })
  onPrivateSyncSessionInvalidated((session) => {
    void notifyIfActive('private', session)
  })
}

/**
 * 仅在失效来源等于当前同步方式时通知 SyncClient。
 * @param provider 发生凭据失效的服务类型。
 * @param session 已清空 token 的凭据会话。
 * @returns 通知处理完成后的 Promise。
 */
async function notifyIfActive(
  provider: 'official' | 'private',
  session: CredentialSession
): Promise<void> {
  const profile = await loadSyncProfile()
  if (profile.provider !== provider) return
  const config = { ...(await resolveSyncRuntimeConfig(profile)), ...session, enabled: false }
  for (const listener of listeners) {
    try {
      listener(config)
    } catch (error) {
      console.error('[SyncAuth] 凭据失效监听器执行失败:', error)
    }
  }
}

/**
 * 在运行配置暂时无法读取时将凭据会话转换为兼容配置。
 * @param session 当前凭据会话。
 * @returns 最小可用的同步配置。
 */
function sessionToConfig(session: CredentialSession): StoredSyncConfig {
  return {
    serverUrl: session.serverUrl,
    username: session.username,
    token: session.token,
    refreshToken: session.refreshToken
  }
}
