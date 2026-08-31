import { OFFICIAL_SYNC_SERVER_URL, isOfficialSyncServerUrl } from '../../../shared/syncServerUrl'
import {
  clearOfficialRejectedAccessToken,
  loadOfficialAccountSession,
  refreshOfficialAccountTokens,
  saveOfficialAccountSession
} from '../account/officialAccountService'
import {
  CredentialSessionService,
  type CredentialRefreshResult,
  type CredentialSession
} from '../auth/credentialSessionService'
import lmdbInstance, { storageManager } from '../lmdb/lmdbInstance'
import type { SyncConfig } from './types'

export type SyncProvider = 'official' | 'private'

export interface SyncProfile {
  provider: SyncProvider
  enabled: boolean
  serverUrl: string
  syncInterval: number
  lastSyncTime: number
  deviceId?: string
}

const SYNC_PROFILE_DOCUMENT_ID = 'SYNC/profile'
const PRIVATE_SYNC_SESSION_DOCUMENT_ID = 'SYNC/private-session'
const LEGACY_SYNC_CONFIG_DOCUMENT_ID = 'SYNC/config'
const MIGRATION_MARKER_DOCUMENT_ID = 'SYNC/separated-auth-migrated'

const privateSessionService = new CredentialSessionService(PRIVATE_SYNC_SESSION_DOCUMENT_ID)

/**
 * 读取当前本地数据空间的同步配置。
 * @returns 已保存的配置；未配置时返回默认关闭的官方同步配置。
 */
export async function loadSyncProfile(): Promise<SyncProfile> {
  const doc = await lmdbInstance.promises.get(SYNC_PROFILE_DOCUMENT_ID)
  return normalizeProfile(doc?.data)
}

/**
 * 保存当前本地数据空间的同步配置，并保留未显式更新的稳定字段。
 * @param input 要更新的同步配置字段。
 * @returns 持久化后的完整同步配置。
 * @throws 存储写入失败时抛出错误。
 */
export async function saveSyncProfile(input: Partial<SyncProfile>): Promise<SyncProfile> {
  const currentDoc = await lmdbInstance.promises.get(SYNC_PROFILE_DOCUMENT_ID)
  const current = normalizeProfile(currentDoc?.data)
  const provider = input.provider || current.provider
  // 切换到未配置的私服时保留空地址，禁止沿用官方服务地址。
  const privateServerUrl =
    typeof input.serverUrl === 'string'
      ? input.serverUrl
      : current.provider === 'private'
        ? current.serverUrl
        : ''
  const next = normalizeProfile({
    ...current,
    ...input,
    provider,
    serverUrl: provider === 'official' ? OFFICIAL_SYNC_SERVER_URL : privateServerUrl,
    lastSyncTime: input.lastSyncTime ?? current.lastSyncTime
  })
  const result = await lmdbInstance.promises.put({
    _id: SYNC_PROFILE_DOCUMENT_ID,
    _rev: currentDoc?._rev,
    data: next
  })
  if (!result?.ok) throw new Error(result?.message || '保存同步配置失败')
  return next
}

/**
 * 读取当前本地数据空间保存的私服凭据。
 * @returns 私服凭据；尚未登录时返回 null。
 */
export function loadPrivateSyncSession(): Promise<CredentialSession | null> {
  return privateSessionService.load()
}

/**
 * 保存当前本地数据空间的私服凭据。
 * @param session 私服地址、用户名和 token。
 * @returns 持久化后的私服凭据。
 */
export function savePrivateSyncSession(session: CredentialSession): Promise<CredentialSession> {
  return privateSessionService.save(session)
}

/**
 * 清空当前本地数据空间的私服凭据，不广播服务端拒绝凭据事件。
 * @returns 清理后的私服会话。
 */
export function clearPrivateSyncSession(): Promise<CredentialSession | null> {
  return privateSessionService.clear({ notifyInvalidated: false })
}

/**
 * 根据同步方式组合现有 SyncClient 所需的运行配置。
 * @param profile 可选的同步配置；省略时读取当前数据空间配置。
 * @returns 包含活动服务凭据的 SyncClient 配置。
 */
export async function resolveSyncRuntimeConfig(profile?: SyncProfile): Promise<SyncConfig> {
  const activeProfile = profile || (await loadSyncProfile())
  const session =
    activeProfile.provider === 'official'
      ? await loadOfficialAccountSession()
      : await loadPrivateSyncSession()
  const sessionMatches = Boolean(
    session &&
    (activeProfile.provider === 'official' || session.serverUrl === activeProfile.serverUrl)
  )
  return {
    enabled: Boolean(activeProfile.enabled && sessionMatches && session?.token),
    serverUrl: activeProfile.serverUrl,
    token: sessionMatches ? session?.token || '' : '',
    refreshToken: sessionMatches ? session?.refreshToken || '' : '',
    syncInterval: activeProfile.syncInterval,
    lastSyncTime: activeProfile.lastSyncTime,
    deviceId: activeProfile.deviceId || '',
    username: sessionMatches ? session?.username || '' : ''
  }
}

/**
 * 刷新当前同步方式对应的凭据。
 * @param expectedRefreshToken 调用方持有的 refresh token 快照。
 * @returns 当前同步会话的刷新结果。
 */
export async function refreshActiveSyncSession(
  expectedRefreshToken?: string
): Promise<CredentialRefreshResult> {
  const profile = await loadSyncProfile()
  if (profile.provider === 'official') {
    return refreshOfficialAccountTokens(expectedRefreshToken)
  }
  return privateSessionService.refresh(expectedRefreshToken)
}

/**
 * 清理当前同步方式被拒绝的访问令牌。
 * @param expectedAccessToken 被服务端拒绝的访问令牌快照。
 * @returns 清理后的活动凭据。
 */
export async function clearActiveRejectedAccessToken(
  expectedAccessToken: string
): Promise<CredentialSession | null> {
  const profile = await loadSyncProfile()
  if (profile.provider === 'official') {
    return clearOfficialRejectedAccessToken(expectedAccessToken)
  }
  return privateSessionService.clearRejectedAccessToken(expectedAccessToken)
}

/**
 * 监听私服凭据失效。
 * @param listener 私服 token 被清空后的监听函数。
 * @returns 用于取消监听的函数。
 */
export function onPrivateSyncSessionInvalidated(
  listener: (session: CredentialSession) => void
): () => void {
  return privateSessionService.onInvalidated(listener)
}

/**
 * 将旧版混合 `SYNC/config` 拆分到官方账号、同步配置和私服会话文档。
 * @returns 迁移完成后的 Promise；已迁移时直接结束。
 */
export async function migrateLegacySyncConfig(): Promise<void> {
  const marker = await lmdbInstance.promises.get(MIGRATION_MARKER_DOCUMENT_ID)
  if (marker?.data?.completed) return

  const legacyDoc = await lmdbInstance.promises.get(LEGACY_SYNC_CONFIG_DOCUMENT_ID)
  const legacy = legacyDoc?.data as Partial<SyncConfig> | undefined
  if (legacy?.serverUrl) {
    const provider: SyncProvider = isOfficialSyncServerUrl(legacy.serverUrl)
      ? 'official'
      : 'private'
    if (provider === 'official' && legacy.username && legacy.token) {
      await saveOfficialAccountSession({
        username: legacy.username,
        token: legacy.token,
        refreshToken: legacy.refreshToken
      })
      // 只有官方账号有权决定当前本地数据空间。
      storageManager.switchAccount(legacy.username)
    }
    if (provider === 'private' && legacy.username) {
      await savePrivateSyncSession({
        serverUrl: legacy.serverUrl,
        username: legacy.username,
        token: legacy.token || '',
        refreshToken: legacy.refreshToken || ''
      })
    }
    await saveSyncProfile({
      provider,
      enabled: Boolean(legacy.enabled),
      serverUrl: provider === 'official' ? OFFICIAL_SYNC_SERVER_URL : legacy.serverUrl,
      syncInterval: legacy.syncInterval || 30,
      lastSyncTime: legacy.lastSyncTime || 0,
      deviceId: legacy.deviceId
    })
  }

  const result = await lmdbInstance.promises.put({
    _id: MIGRATION_MARKER_DOCUMENT_ID,
    _rev: marker?._rev,
    data: { completed: true, migratedAt: Date.now() }
  })
  if (!result?.ok) throw new Error(result?.message || '同步配置迁移失败')
}

/**
 * 将未知存储值规范化为可用同步配置。
 * @param value 存储中读取的未知配置。
 * @returns 字段完整的同步配置。
 */
function normalizeProfile(value: unknown): SyncProfile {
  const source = value && typeof value === 'object' ? (value as Partial<SyncProfile>) : {}
  const provider: SyncProvider = source.provider === 'private' ? 'private' : 'official'
  return {
    provider,
    enabled: Boolean(source.enabled),
    serverUrl:
      provider === 'official'
        ? OFFICIAL_SYNC_SERVER_URL
        : typeof source.serverUrl === 'string'
          ? source.serverUrl
          : '',
    syncInterval:
      typeof source.syncInterval === 'number' && source.syncInterval > 0 ? source.syncInterval : 30,
    lastSyncTime:
      typeof source.lastSyncTime === 'number' && Number.isFinite(source.lastSyncTime)
        ? source.lastSyncTime
        : 0,
    deviceId: typeof source.deviceId === 'string' ? source.deviceId : undefined
  }
}
