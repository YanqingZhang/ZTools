import type LmdbDatabase from '../lmdb/index'
import type { FullChangeEntry } from './types'
import { isOfficialSyncServerUrl, normalizeSyncServerUrl } from '../../../shared/syncServerUrl'

const CHECKPOINT_KEY = '_sync_checkpoint'

export interface SyncCheckpoint {
  uid?: string
  deviceId?: string
  serverUrl?: string
  remotePullSeq: number
  localPushSeq: number
  syncEpoch: number
  protocolVersion: number
  pull?: {
    inProgress: boolean
    batchSince: number
    targetSeq?: number
    startedAt?: number
    updatedAt?: number
    lastError?: string
  }
  push?: {
    inProgress: boolean
    batchFromSeq: number
    batchToSeq: number
    changeIds: Array<{ seq: number; docId: string; rev: string }>
    startedAt?: number
    updatedAt?: number
    attempts: number
    nextRetryAt?: number
    lastError?: string
  }
}

export class SyncCheckpointStore {
  constructor(private db: LmdbDatabase) {}

  /**
   * 读取账号、设备和服务器共同作用域下的同步进度。
   * @param uid 同步账号标识。
   * @param deviceId 当前设备标识。
   * @param serverUrl 当前同步服务器地址。
   * @returns 已有 checkpoint，或新建的零进度 checkpoint。
   */
  load(uid?: string, deviceId?: string, serverUrl?: string): SyncCheckpoint {
    const metaDb = this.db.getMetaDb()
    const existing = this.parse(metaDb.get(this.key(uid, deviceId, serverUrl)))
    if (existing) {
      return this.normalize({ ...existing, uid, deviceId, serverUrl })
    }

    return this.reset(uid, deviceId, serverUrl)
  }

  /**
   * 将同步进度写入其服务器作用域对应的存储 key。
   * @param checkpoint 待保存的同步进度。
   * @returns 无返回值。
   */
  save(checkpoint: SyncCheckpoint): void {
    this.db
      .getMetaDb()
      .putSync(
        this.key(checkpoint.uid, checkpoint.deviceId, checkpoint.serverUrl),
        JSON.stringify(this.normalize(checkpoint))
      )
  }

  /**
   * 清空指定账号、设备和服务器作用域的同步进度。
   * @param uid 同步账号标识。
   * @param deviceId 当前设备标识。
   * @param serverUrl 当前同步服务器地址。
   * @returns 已持久化的零进度 checkpoint。
   */
  reset(uid?: string, deviceId?: string, serverUrl?: string): SyncCheckpoint {
    const checkpoint = this.normalize({
      uid,
      deviceId,
      serverUrl,
      remotePullSeq: 0,
      localPushSeq: 0,
      syncEpoch: 0,
      protocolVersion: 0
    })
    this.save(checkpoint)
    return checkpoint
  }

  beginPull(checkpoint: SyncCheckpoint, targetSeq: number): SyncCheckpoint {
    const now = Date.now()
    const next = this.normalize({
      ...checkpoint,
      pull: {
        inProgress: true,
        batchSince: checkpoint.remotePullSeq,
        targetSeq,
        startedAt: now,
        updatedAt: now
      }
    })
    this.save(next)
    return next
  }

  commitPull(
    checkpoint: SyncCheckpoint,
    remotePullSeq: number,
    options: { syncEpoch?: number; protocolVersion?: number } = {}
  ): SyncCheckpoint {
    const next = this.normalize({
      ...checkpoint,
      remotePullSeq,
      syncEpoch: options.syncEpoch ?? checkpoint.syncEpoch,
      protocolVersion: options.protocolVersion ?? checkpoint.protocolVersion,
      pull: {
        inProgress: false,
        batchSince: remotePullSeq,
        targetSeq: remotePullSeq,
        updatedAt: Date.now()
      }
    })
    this.save(next)
    return next
  }

  failPull(checkpoint: SyncCheckpoint, error: unknown): SyncCheckpoint {
    const next = this.normalize({
      ...checkpoint,
      pull: {
        ...(checkpoint.pull || { batchSince: checkpoint.remotePullSeq }),
        inProgress: false,
        updatedAt: Date.now(),
        lastError: this.errorMessage(error)
      }
    })
    this.save(next)
    return next
  }

  beginPush(checkpoint: SyncCheckpoint, batch: FullChangeEntry[]): SyncCheckpoint {
    const sequenced = batch.filter((change) => change.seq > 0)
    const batchFromSeq = sequenced.length > 0 ? sequenced[0].seq : 0
    const batchToSeq =
      sequenced.length > 0 ? sequenced[sequenced.length - 1].seq : checkpoint.localPushSeq
    const previousAttempts =
      checkpoint.push?.inProgress &&
      checkpoint.push.batchFromSeq === batchFromSeq &&
      checkpoint.push.batchToSeq === batchToSeq
        ? checkpoint.push.attempts
        : 0
    const now = Date.now()
    const next = this.normalize({
      ...checkpoint,
      push: {
        inProgress: true,
        batchFromSeq,
        batchToSeq,
        changeIds: batch.map((change) => ({
          seq: change.seq,
          docId: change.docId,
          rev: change.rev
        })),
        startedAt: checkpoint.push?.startedAt || now,
        updatedAt: now,
        attempts: previousAttempts + 1
      }
    })
    this.save(next)
    return next
  }

  commitPush(checkpoint: SyncCheckpoint): SyncCheckpoint {
    const committedSeq = checkpoint.push?.batchToSeq || checkpoint.localPushSeq
    return this.commitLocalPushSeq(
      {
        ...checkpoint,
        push: checkpoint.push
          ? {
              ...checkpoint.push,
              inProgress: false,
              updatedAt: Date.now(),
              lastError: undefined
            }
          : undefined
      },
      committedSeq
    )
  }

  commitLocalPushSeq(checkpoint: SyncCheckpoint, localPushSeq: number): SyncCheckpoint {
    const next = this.normalize({
      ...checkpoint,
      localPushSeq: Math.max(checkpoint.localPushSeq, localPushSeq)
    })
    this.save(next)
    return next
  }

  failPush(checkpoint: SyncCheckpoint, error: unknown): SyncCheckpoint {
    const next = this.normalize({
      ...checkpoint,
      push: checkpoint.push
        ? {
            ...checkpoint.push,
            inProgress: false,
            updatedAt: Date.now(),
            lastError: this.errorMessage(error)
          }
        : undefined
    })
    this.save(next)
    return next
  }

  /**
   * 生成 checkpoint 存储 key，并为官方服务保留历史 key 兼容性。
   * @param uid 同步账号标识。
   * @param deviceId 当前设备标识。
   * @param serverUrl 当前同步服务器地址。
   * @returns LMDB metadata key。
   */
  private key(uid?: string, deviceId?: string, serverUrl?: string): string {
    if (!uid || !deviceId) return CHECKPOINT_KEY
    if (serverUrl && !isOfficialSyncServerUrl(serverUrl)) {
      // 私有服务必须进入独立命名空间，避免同名账号复用其他服务器的拉取序号。
      return `${CHECKPOINT_KEY}:${this.serverIdentity(serverUrl)}:${uid}:${deviceId}`
    }
    return `${CHECKPOINT_KEY}:${uid}:${deviceId}`
  }

  /**
   * 生成稳定且可作为 LMDB key 片段的服务地址标识。
   * @param serverUrl 当前同步服务器地址。
   * @returns URL 编码后的规范化服务器地址。
   */
  private serverIdentity(serverUrl: string): string {
    try {
      return encodeURIComponent(normalizeSyncServerUrl(serverUrl))
    } catch {
      return encodeURIComponent(serverUrl.trim().replace(/\/+$/, '').toLowerCase())
    }
  }

  /**
   * 补全 checkpoint 缺省值，并保留其账号、设备和服务器作用域。
   * @param value 待规范化的部分 checkpoint。
   * @returns 字段完整且数值安全的 checkpoint。
   */
  private normalize(value: Partial<SyncCheckpoint>): SyncCheckpoint {
    return {
      uid: value.uid,
      deviceId: value.deviceId,
      serverUrl: value.serverUrl,
      remotePullSeq: this.safeNumber(value.remotePullSeq),
      localPushSeq: this.safeNumber(value.localPushSeq),
      syncEpoch: this.safeNumber(value.syncEpoch),
      protocolVersion: this.safeNumber(value.protocolVersion),
      pull: value.pull,
      push: value.push
    }
  }

  private parse(raw: unknown): SyncCheckpoint | null {
    if (!raw) return null
    try {
      if (typeof raw === 'string') return JSON.parse(raw)
      if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString())
      return raw as SyncCheckpoint
    } catch {
      return null
    }
  }

  private safeNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10)
      return Number.isFinite(parsed) ? parsed : 0
    }
    if (Buffer.isBuffer(value)) {
      const parsed = parseInt(value.toString(), 10)
      return Number.isFinite(parsed) ? parsed : 0
    }
    return 0
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
