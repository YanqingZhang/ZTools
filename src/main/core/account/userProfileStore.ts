import lmdbInstance from '../lmdb/lmdbInstance'
import { loadOfficialAccountSessionSync } from './officialAccountService'
const USER_PROFILE_CACHE_PREFIX = 'ZTOOLS/account-profile-cache:'

export interface UserInfo {
  avatar: string
  nickname: string
  uid: string
}

interface CachedUserProfile {
  avatarUrl?: string
  nickname?: string
  uid?: string
  updatedAt?: number
}

/**
 * 生成指定账号对应的设备级资料缓存文档 ID。
 * @param uid 账号唯一标识
 * @returns 资料缓存文档 ID
 */
function getUserProfileCacheId(uid: string): string {
  return `${USER_PROFILE_CACHE_PREFIX}${uid}`
}

/**
 * 将服务端账号资料写入设备级缓存，供同步插件 API 立即读取。
 * @param profile 服务端返回的账号资料
 * @param fallbackUid 资料缺少 uid 时使用的账号标识
 * @returns 无返回值
 */
export function cacheUserProfile(profile: unknown, fallbackUid: string = ''): void {
  if (!profile || typeof profile !== 'object') return

  const source = profile as CachedUserProfile
  const uid = (typeof source.uid === 'string' ? source.uid : fallbackUid).trim()
  if (!uid) return

  try {
    // 保留现有 revision，确保重复刷新资料时更新同一缓存文档。
    const docId = getUserProfileCacheId(uid)
    const existing = lmdbInstance.get(docId)
    lmdbInstance.put({
      _id: docId,
      _rev: existing?._rev,
      data: {
        uid,
        nickname: typeof source.nickname === 'string' ? source.nickname : '',
        avatarUrl: typeof source.avatarUrl === 'string' ? source.avatarUrl : '',
        updatedAt: Date.now()
      }
    })
  } catch (error) {
    // 缓存失败不应改变远端资料操作的成功结果。
    console.warn('[UserProfile] 缓存账号资料失败:', error)
  }
}

/**
 * 同步读取当前登录用户的公开资料。
 * @returns 已登录时返回用户资料，未登录或配置不可用时返回 null
 */
export function getCurrentUserInfo(): UserInfo | null {
  try {
    const config = loadOfficialAccountSessionSync()
    const uid = typeof config?.username === 'string' ? config.username.trim() : ''
    if (!config?.token || !uid) return null

    // 资料缓存缺失时仍返回字段完整的用户对象，避免首次登录期间产生不稳定结果。
    const cached = lmdbInstance.get(getUserProfileCacheId(uid))?.data as
      | CachedUserProfile
      | undefined
    const nickname =
      typeof cached?.nickname === 'string' && cached.nickname.trim() ? cached.nickname : uid
    const avatar = typeof cached?.avatarUrl === 'string' ? cached.avatarUrl : ''

    return { avatar, nickname, uid }
  } catch (error) {
    // 本地配置读取异常按未登录处理，避免同步 IPC 将存储错误泄露给插件。
    console.warn('[UserProfile] 读取当前用户失败:', error)
    return null
  }
}
