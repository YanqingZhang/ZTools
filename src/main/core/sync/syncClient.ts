import WebSocket from 'ws'
import { EventEmitter } from 'events'
import crypto from 'crypto'
import os from 'os'
import type LmdbDatabase from '../lmdb/index'
import {
  SyncConfig,
  SyncState,
  ClientMessage,
  ServerMessage,
  FullChangeEntry,
  RemoteCheckpointPayload
} from './types'
import { SyncCheckpoint, SyncCheckpointStore } from './syncCheckpointStore'
import { SyncRetryScheduler } from './syncRetryScheduler'
import {
  DownloadBlobTaskPayload,
  PushBatchTaskPayload,
  SyncRetryStatus,
  SyncTask,
  SyncTaskStore,
  UploadBlobTaskPayload
} from './syncTaskStore'
import { ACCOUNT_SYNC_PREFIXES } from '../storage/storageRouting'
import {
  clearInvalidStoredAccessToken,
  loadStoredSyncConfig,
  refreshStoredSyncTokens,
  type StoredSyncConfig
} from './syncAuthTokenService'

/**
 * WebSocket 同步客户端
 * 负责与同步服务器的实时双向通信
 */
const PUSH_BATCH_SIZE = 50
const SYNC_PROTOCOL_VERSION = 2

/** 需要同步的文档前缀白名单 */
export const SYNC_PREFIXES = ACCOUNT_SYNC_PREFIXES

export class SyncClient extends EventEmitter {
  private ws: WebSocket | null = null
  private remotePullSeq: number = 0
  private localPushSeq: number = 0
  private state: SyncState = 'disconnected'
  private reconnectDelay: number = 1000
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private config: SyncConfig | null = null
  private syncStartedAt: number = 0
  private shouldRequestSnapshot: boolean = false
  private shouldResetRemoteCheckpoint: boolean = false
  private checkpointId: string = ''
  private checkpointLoadedFromRemote: boolean = false
  private authReconnectBlocked: boolean = false

  // 分批推送状态
  private pushQueue: FullChangeEntry[] = []
  private pushOffset: number = 0
  private currentPushTaskId: string | null = null
  private pushMode: 'queue' | 'task' | null = null
  private fullScanPushUpperSeq: number | null = null
  private checkpoint: SyncCheckpoint
  private checkpointStore: SyncCheckpointStore
  private taskStore: SyncTaskStore
  private retryScheduler: SyncRetryScheduler
  private startTraceAt: number = 0

  constructor(private db: LmdbDatabase) {
    super()
    this.checkpointStore = new SyncCheckpointStore(db)
    this.checkpoint = this.checkpointStore.load()
    this.taskStore = new SyncTaskStore((db as any).getSyncTaskDb())
    this.retryScheduler = new SyncRetryScheduler(this.taskStore, (task) => this.runSyncTask(task))
    this.retryScheduler.on('status', (status) => this.emit('retry-status', status))
    this.retryScheduler.on('task-error', (err) =>
      this.emit('sync-error', err instanceof Error ? err.message : String(err))
    )
  }

  /**
   * 获取当前同步状态
   */
  getState(): SyncState {
    return this.state
  }

  getRetryStatus(): SyncRetryStatus {
    return this.retryScheduler.getStatus()
  }

  retryNow(): void {
    this.retryScheduler.retryNow()
  }

  /**
   * 使用给定账号配置启动同步、重试调度和 WebSocket 连接。
   * @param config 当前账号的同步配置。
   * @returns 无返回值。
   */
  start(config: SyncConfig): void {
    this.startTraceAt = Date.now()
    console.log('[SyncClient][Trace] start called', {
      enabled: config.enabled,
      username: config.username,
      deviceId: config.deviceId,
      serverUrl: config.serverUrl
    })
    this.config = config
    this.authReconnectBlocked = false
    this.setState('connecting')
    console.log(`[SyncClient][Trace] state connecting +${Date.now() - this.startTraceAt}ms`)
    this.checkpoint = this.checkpointStore.load(config.username, config.deviceId, config.serverUrl)
    this.remotePullSeq = this.checkpoint.remotePullSeq
    this.localPushSeq = this.checkpoint.localPushSeq
    console.log('[SyncClient][Trace] checkpoint loaded', {
      remotePullSeq: this.remotePullSeq,
      localPushSeq: this.localPushSeq,
      elapsed: Date.now() - this.startTraceAt
    })
    this.retryScheduler.start()
    console.log(`[SyncClient][Trace] retry scheduler started +${Date.now() - this.startTraceAt}ms`)
    this.connect()
  }

  /**
   * 停止同步
   */
  stop(): void {
    if (this.config) {
      this.config = { ...this.config, enabled: false }
    }
    this.retryScheduler.stop()
    this.disconnect()
  }

  /**
   * 重启同步（对标 uTools 的 restartDbSync）
   */
  restartSync(): void {
    if (Date.now() - this.syncStartedAt < 300000) return // 5 分钟内不重启
    this.disconnect(false)
    setImmediate(() => this.connect())
  }

  /**
   * 强制立即重新同步（无冷却期）
   */
  performSync(): void {
    this.disconnect(false)
    setImmediate(() => this.connect())
  }

  /**
   * 强制全量推送：扫描所有未同步文档，重建 push 列表
   */
  forcePushAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SyncClient] forcePushAll: 未连接')
      return
    }

    const syncPrefixes = SYNC_PREFIXES
    const fullChanges: FullChangeEntry[] = []
    const now = Date.now()

    for (const prefix of syncPrefixes) {
      const docs = this.db.allDocs(prefix)
      for (const doc of docs) {
        fullChanges.push(
          this.withRevisionHistory({
            seq: 0,
            docId: doc._id,
            rev: doc._rev || '',
            deleted: false,
            timestamp: now,
            doc
          })
        )
      }
    }

    if (fullChanges.length === 0) {
      console.log('[SyncClient] forcePushAll: 无文档需要推送')
      return
    }

    console.log(`[SyncClient] forcePushAll: 推送 ${fullChanges.length} 条文档`)
    this.setState('pushing')
    this.fullScanPushUpperSeq = this.db.getLastSeq()
    this.beginBatchPush(fullChanges)
  }

  /**
   * 统计指定同步目标尚未确认的唯一文档数量。
   * @param config 要查询的同步目标；省略时使用当前活动配置。
   * @returns 当前目标 checkpoint 之后的文档和删除记录数量。
   */
  getPendingDocumentCount(config?: SyncConfig | null): number {
    const activeConfig = config || this.config
    const checkpoint = activeConfig
      ? this.checkpointStore.load(
          activeConfig.username,
          activeConfig.deviceId,
          activeConfig.serverUrl
        )
      : this.checkpoint
    const pendingDocIds = new Set<string>()

    for (const change of this.db.getChangesSince(checkpoint.localPushSeq)) {
      if (this.isSyncDocument(change.docId)) pendingDocIds.add(change.docId)
    }

    // 新同步目标尚无本地游标时，当前快照中的文档也必须进入首次推送。
    if (checkpoint.localPushSeq === 0) {
      for (const prefix of SYNC_PREFIXES) {
        for (const doc of this.db.allDocs(prefix)) pendingDocIds.add(doc._id)
      }
    }

    return pendingDocIds.size
  }

  /**
   * 重置当前同步目标的 checkpoint 和重试任务，并按本地快照重新排队。
   * @param config 要重置的同步目标；省略时使用当前活动配置。
   * @returns 重新排队的文档数量和清理的重试任务数量。
   */
  resetLocalSyncState(config?: SyncConfig | null): {
    documentsQueued: number
    tasksCleared: number
  } {
    const activeConfig = config || this.config
    const shouldRestart = Boolean(activeConfig?.enabled)

    this.stop()
    this.pushQueue = []
    this.pushOffset = 0
    this.currentPushTaskId = null
    this.pushMode = null
    this.fullScanPushUpperSeq = null
    this.checkpointLoadedFromRemote = false

    const tasksCleared = this.taskStore.clear()

    this.checkpoint = this.checkpointStore.reset(
      activeConfig?.username,
      activeConfig?.deviceId,
      activeConfig?.serverUrl
    )
    this.remotePullSeq = 0
    this.localPushSeq = 0
    this.checkpointId = activeConfig ? this.buildCheckpointIdFor(activeConfig) : ''
    this.shouldResetRemoteCheckpoint = Boolean(activeConfig?.enabled)
    const documentsQueued = this.getPendingDocumentCount(activeConfig)
    this.retryScheduler.emitStatus()

    if (activeConfig && shouldRestart) {
      this.start(activeConfig)
    }

    return { documentsQueued, tasksCleared }
  }

  private setState(state: SyncState): void {
    if (this.state === state) return
    this.state = state
    this.emit('state', state)
  }

  private disconnect(emitDisconnected = true): void {
    this.clearTimers()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.stopListeningLocalChanges()
    if (emitDisconnected) {
      this.setState('disconnected')
    }
  }

  /**
   * 创建 WebSocket 连接并注册认证、消息、关闭和错误处理流程。
   * @returns 无返回值。
   */
  private connect(): void {
    if (!this.config || !this.config.enabled) return

    this.clearTimers()
    this.setState('connecting')
    this.syncStartedAt = Date.now()
    if (!this.startTraceAt) this.startTraceAt = this.syncStartedAt
    console.log(`[SyncClient][Trace] connect begin +${Date.now() - this.startTraceAt}ms`)

    try {
      this.ws = new WebSocket(this.config.serverUrl)
      console.log(`[SyncClient][Trace] websocket created +${Date.now() - this.startTraceAt}ms`)
    } catch (err) {
      console.error('[SyncClient] WebSocket 创建失败:', err)
      this.scheduleReconnect()
      return
    }

    const ws = this.ws

    ws.on('open', () => {
      if (this.ws !== ws) return
      console.log('[SyncClient] 连接已建立')
      console.log(`[SyncClient][Trace] websocket open +${Date.now() - this.startTraceAt}ms`)
      this.reconnectDelay = 1000
      this.setState('authenticating')
      console.log(`[SyncClient][Trace] state authenticating +${Date.now() - this.startTraceAt}ms`)
      void this.authenticateSocket(ws).catch((error) => {
        this.handleSocketAuthenticationFailure(ws, error)
      })
    })

    ws.on('message', (raw: WebSocket.Data) => {
      if (this.ws !== ws) return
      try {
        const msg: ServerMessage = JSON.parse(raw.toString())
        this.handleMessage(msg)
      } catch (err) {
        console.error('[SyncClient] 消息解析失败:', err)
      }
    })

    ws.on('close', () => {
      if (this.ws !== ws) return
      console.log('[SyncClient] 连接已关闭')
      if (this.checkpoint.push?.inProgress) {
        this.checkpoint = this.checkpointStore.failPush(
          this.checkpoint,
          'WebSocket closed during push'
        )
        this.failCurrentPushTask('WebSocket closed during push')
      }
      this.stopHeartbeat()
      this.stopListeningLocalChanges()
      this.setState(this.authReconnectBlocked ? 'error' : 'disconnected')
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      if (this.ws !== ws) return
      console.error('[SyncClient] WebSocket 错误:', err)
      this.setState('error')
    })
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'auth_ok': {
        console.log('[SyncClient] 认证成功, remote serverSeq:', msg.serverSeq)
        console.log(`[SyncClient][Trace] auth_ok received +${Date.now() - this.startTraceAt}ms`)
        const serverEpoch = msg.syncEpoch || 0
        const localEpoch = this.checkpoint.syncEpoch
        const localProtocolVersion = this.checkpoint.protocolVersion
        this.shouldRequestSnapshot =
          !!msg.features?.snapshotPull &&
          (localProtocolVersion < SYNC_PROTOCOL_VERSION ||
            (serverEpoch > 0 && localEpoch < serverEpoch))
        this.checkpoint = this.checkpointStore.load(
          this.config?.username,
          this.config?.deviceId,
          this.config?.serverUrl
        )
        this.remotePullSeq = this.checkpoint.remotePullSeq
        this.localPushSeq = this.checkpoint.localPushSeq
        this.checkpointLoadedFromRemote = false
        this.checkpointId = this.buildCheckpointId()
        this.startHeartbeat()
        if (this.shouldResetRemoteCheckpoint) {
          this.putRemoteCheckpoint()
          this.shouldResetRemoteCheckpoint = false
        }
        this.requestRemoteCheckpoint()
        break
      }

      case 'changes':
        if (msg.reset) {
          console.log('[SyncClient] 收到 reset/snapshot 响应，准备重置本地同步 checkpoint')
        }
        this.handlePullResponse(msg.changes, msg.seq, {
          reset: !!msg.reset,
          snapshot: !!msg.snapshot,
          syncEpoch: msg.syncEpoch || 0
        })
        break

      case 'change':
        this.handleRemoteChange(msg.change)
        break

      case 'push_ok':
        this.handlePushOk(msg.seq)
        break

      case 'push_missing':
        this.handlePushMissing(msg.missingDigests || [])
        break

      case 'checkpoint':
        this.handleRemoteCheckpoint(msg.checkpoint)
        break

      case 'checkpoint_ok':
        break

      case 'pong':
        break

      case 'error':
        console.error('[SyncClient] 服务器错误:', msg.message)
        if (this.checkpoint.push?.inProgress) {
          this.checkpoint = this.checkpointStore.failPush(this.checkpoint, msg.message)
        }
        if (msg.message === 'Invalid token') {
          void this.refreshAfterAuthFailure()
        }
        this.emit('sync-error', msg.message)
        break
    }
  }

  /**
   * 使用设备级最新凭据完成当前 WebSocket 的认证，避免发送已被其他模块旋转的 token。
   * @param ws 当前等待认证的 WebSocket 实例。
   * @returns 认证帧发送完成后的 Promise。
   * @throws 当凭据失效、账号切换或刷新服务暂时不可用时抛出错误。
   */
  private async authenticateSocket(ws: WebSocket): Promise<void> {
    await this.ensureFreshAccessToken()
    console.log(`[SyncClient][Trace] token checked +${Date.now() - this.startTraceAt}ms`)
    if (this.ws !== ws || !this.config) return

    // 仅向仍处于活动状态的连接发送最新认证凭据。
    ws.send(
      JSON.stringify({
        type: 'auth',
        token: this.config.token,
        deviceId: this.config.deviceId,
        deviceName: os.hostname(),
        protocolVersion: SYNC_PROTOCOL_VERSION
      } satisfies ClientMessage)
    )
  }

  /**
   * 收口 WebSocket 打开后的异步认证异常，并决定是否允许自动重连。
   * @param ws 发生认证异常的 WebSocket 实例。
   * @param error 捕获到的认证错误。
   * @returns 无返回值。
   */
  private handleSocketAuthenticationFailure(ws: WebSocket, error: unknown): void {
    if (this.ws !== ws) return
    const message = error instanceof Error ? error.message : String(error)
    console.error('[SyncClient] WebSocket 认证失败:', error)

    if (error instanceof SyncCredentialsInvalidError) {
      // 确认失效后阻断重连，避免持续消耗连接并停留在“认证中”。
      this.authReconnectBlocked = true
      if (this.config) {
        this.config = { ...this.config, enabled: false, token: '', refreshToken: '' }
      }
    }
    this.emit('sync-error', message)
    this.setState('error')
    ws.close()
  }

  /**
   * 重新加载设备级凭据，并在访问令牌临近过期时刷新。
   * @returns 凭据准备完成后的 Promise。
   * @throws 当本地配置已切换账号、凭据失效或刷新暂时失败时抛出错误。
   */
  private async ensureFreshAccessToken(): Promise<void> {
    const latest = await loadStoredSyncConfig()
    this.applyStoredCredentials(latest)
    if (!this.config?.token) {
      throw new SyncCredentialsInvalidError('登录状态已失效，请重新登录')
    }
    if (this.config.refreshToken && isJwtExpiring(this.config.token)) {
      await this.refreshAccessToken()
    }
  }

  /**
   * 在服务端拒绝访问令牌后强制刷新，并使用新凭据重新建立连接。
   * @returns 刷新和重连调度完成后的 Promise。
   */
  private async refreshAfterAuthFailure(): Promise<void> {
    try {
      if (!this.config?.refreshToken) {
        const rejectedToken = this.config?.token || ''
        this.authReconnectBlocked = true
        if (this.config) {
          this.config = { ...this.config, enabled: false, token: '' }
        }
        this.setState('error')
        if (rejectedToken) {
          await clearInvalidStoredAccessToken(rejectedToken)
        }
        return
      }
      await this.refreshAccessToken(true)
      this.disconnect(false)
      setImmediate(() => this.connect())
    } catch (err) {
      console.error('[SyncClient] 刷新认证失败:', err)
      if (err instanceof SyncCredentialsInvalidError) {
        this.authReconnectBlocked = true
        this.setState('error')
      }
    }
  }

  /**
   * 通过统一刷新服务旋转当前账号 token，并同步更新内存配置。
   * @param force 是否忽略访问令牌有效期并强制刷新。
   * @returns 刷新和内存配置更新完成后的 Promise。
   * @throws 当账号已切换、refresh token 失效或刷新服务暂时不可用时抛出错误。
   */
  private async refreshAccessToken(force = false): Promise<void> {
    const latest = await loadStoredSyncConfig()
    this.applyStoredCredentials(latest)
    if (!this.config?.refreshToken) {
      throw new SyncCredentialsInvalidError('登录状态已失效，请重新登录')
    }
    if (!force && this.config.token && !isJwtExpiring(this.config.token)) {
      return
    }
    const currentRefreshToken = this.config.refreshToken
    const result = await refreshStoredSyncTokens(currentRefreshToken)
    if (result.status === 'invalid') {
      throw new SyncCredentialsInvalidError('登录状态已失效，请重新登录')
    }
    if (result.status === 'unavailable') {
      throw new Error('刷新登录状态失败，请稍后重试')
    }
    if (!this.applyStoredCredentials(result.config)) {
      throw new Error('同步账号已切换')
    }
    if (!this.config?.token) {
      throw new SyncCredentialsInvalidError('登录状态已失效，请重新登录')
    }
  }

  /**
   * 将设备级存储中的 token 应用到当前同步会话，并校验账号和服务地址未被切换。
   * @param storedConfig 设备级存储读取到的最新同步配置。
   * @returns 存储配置属于当前同步会话并已应用时返回 true。
   */
  private applyStoredCredentials(storedConfig: StoredSyncConfig | null): boolean {
    if (!this.config || !storedConfig) return false
    if (
      storedConfig.serverUrl !== this.config.serverUrl ||
      (storedConfig.username || '') !== (this.config.username || '')
    ) {
      return false
    }
    this.config = {
      ...this.config,
      token: storedConfig.token || '',
      refreshToken: storedConfig.refreshToken || ''
    }
    return true
  }

  // ==================== 阶段一：拉取 ====================

  private startPull(): void {
    this.setState('pulling')
    console.log('[SyncClient] 开始拉取, since:', this.remotePullSeq)
    console.log(
      `[SyncClient][Trace] pull start since=${this.remotePullSeq} +${Date.now() - this.startTraceAt}ms`
    )

    this.send({
      type: 'pull',
      since: this.remotePullSeq,
      snapshot: this.shouldRequestSnapshot,
      protocolVersion: SYNC_PROTOCOL_VERSION
    })
  }

  private handlePullResponse(
    changes: FullChangeEntry[] = [],
    seq: number,
    options: { reset?: boolean; snapshot?: boolean; syncEpoch?: number } = {}
  ): void {
    const BATCH_SIZE = 20
    const docChanges = Array.isArray(changes) ? changes : []
    this.checkpoint = this.checkpointStore.beginPull(this.checkpoint, seq)

    if (docChanges.length <= BATCH_SIZE) {
      // 少量变更，直接批量写入
      try {
        const downloaded = this.db.applyRemoteBatch(docChanges)
        this.finishPull(downloaded, docChanges, seq, options)
      } catch (err) {
        this.checkpoint = this.checkpointStore.failPull(this.checkpoint, err)
        console.error('[SyncClient] 应用拉取变更失败:', err)
        this.setState('error')
      }
      return
    }

    // 大量变更，分批 + yield 避免阻塞 UI
    let offset = 0
    let totalDownloaded = 0

    const processNextBatch = (): void => {
      const batch = docChanges.slice(offset, offset + BATCH_SIZE)
      if (batch.length === 0) {
        this.finishPull(totalDownloaded, docChanges, seq, options)
        return
      }

      try {
        totalDownloaded += this.db.applyRemoteBatch(batch)
        offset += BATCH_SIZE
      } catch (err) {
        this.checkpoint = this.checkpointStore.failPull(this.checkpoint, err)
        console.error('[SyncClient] 应用拉取批次失败:', err)
        this.setState('error')
        return
      }

      // yield 事件循环
      setImmediate(processNextBatch)
    }

    processNextBatch()
  }

  private finishPull(
    downloaded: number,
    changes: FullChangeEntry[],
    seq: number,
    options: { reset?: boolean; snapshot?: boolean; syncEpoch?: number } = {}
  ): void {
    this.checkpoint = this.checkpointStore.commitPull(this.checkpoint, seq, {
      protocolVersion: options.snapshot || options.reset ? SYNC_PROTOCOL_VERSION : undefined,
      syncEpoch: options.snapshot || options.reset ? options.syncEpoch || 0 : undefined
    })
    this.remotePullSeq = this.checkpoint.remotePullSeq
    this.putRemoteCheckpoint()
    if (options.snapshot || options.reset) {
      this.shouldRequestSnapshot = false
    }
    console.log(`[SyncClient] 拉取完成, 下载 ${downloaded} 条, remotePullSeq: ${seq}`)
    console.log('[SyncClient][Trace] pull finished', {
      downloaded,
      changes: changes.length,
      seq,
      elapsed: Date.now() - this.startTraceAt
    })

    // 触发 pull 事件（通知插件）
    if (changes.length > 0) {
      this.emit(
        'pull',
        changes.filter((c) => c.doc).map((c) => c.doc)
      )
    }

    this.downloadMissingDocumentAttachments(changes)

    // 进入阶段二：推送
    this.startPush()
  }

  // ==================== 阶段二：推送 ====================

  private startPush(): void {
    this.setState('pushing')
    this.fullScanPushUpperSeq = null
    console.log(
      `[SyncClient][Trace] push start localPushSeq=${this.localPushSeq} +${Date.now() - this.startTraceAt}ms`
    )

    // localPushSeq === 0 表示首次同步或切换账号后，changelog 可能为空但 LMDB 里有历史数据
    // 此时走全量扫描而不是 changelog，确保旧数据都能上传
    if (this.localPushSeq === 0) {
      this.startFullScanPush()
      return
    }

    const changes = this.db.getChangesSince(this.localPushSeq)
    if (changes.length === 0) {
      console.log('[SyncClient] 无本地变更需要推送')
      console.log(
        `[SyncClient][Trace] no local changes, entering live +${Date.now() - this.startTraceAt}ms`
      )
      this.enterLiveMode()
      return
    }

    // 构造带完整文档的变更列表
    // 过滤掉已被远端 Pull 覆盖的本地条目：
    //   - 删除条目：如果文档重新存在（拉取覆盖了本地删除），跳过
    //   - 写入条目：如果当前文档 _rev 与 changelog 记录的不一致，说明被 pull 覆盖，跳过
    // 这避免了首次同步时把"覆盖后的远端数据"重复推回服务端，防止无效广播和 changelog 膨胀
    const fullChanges: FullChangeEntry[] = []
    let skipped = 0

    for (const c of changes) {
      if (c.deleted) {
        const current = this.db.get(c.docId)
        if (current !== null) {
          // 文档被 pull 恢复，本地删除意图已失效，跳过
          skipped++
          continue
        }
        fullChanges.push(this.withRevisionHistory({ ...c, doc: null }))
      } else {
        const current = this.db.get(c.docId)
        if (!current || current._rev !== c.rev) {
          // 当前 _rev 与 changelog 不一致，文档已被远端覆盖，跳过
          skipped++
          continue
        }
        // 从 metaDb 读取真实修改时间（比 changelog.timestamp 更准确）
        const meta = this.db.getSyncMeta(c.docId)
        fullChanges.push(
          this.withRevisionHistory({
            ...c,
            timestamp: meta?._lastModified ?? c.timestamp,
            doc: current
          })
        )
      }
    }

    if (fullChanges.length === 0) {
      console.log(`[SyncClient] 本地 ${changes.length} 条变更均已被远端覆盖，跳过推送`)
      this.enterLiveMode()
      return
    }

    if (skipped > 0) {
      console.log(
        `[SyncClient] 推送 ${fullChanges.length} 条变更（已跳过 ${skipped} 条被远端覆盖）`
      )
    } else {
      console.log(`[SyncClient] 推送 ${fullChanges.length} 条变更`)
    }
    this.beginBatchPush(fullChanges)
  }

  /**
   * 为没有本地 checkpoint 的同步目标构建完整文档和删除快照。
   * @returns 无返回值。
   */
  private startFullScanPush(): void {
    const syncPrefixes = SYNC_PREFIXES
    const fullChanges: FullChangeEntry[] = []
    const currentDocIds = new Set<string>()
    const now = Date.now()
    this.fullScanPushUpperSeq = this.db.getLastSeq()

    for (const prefix of syncPrefixes) {
      const docs = this.db.allDocs(prefix)
      for (const doc of docs) {
        currentDocIds.add(doc._id)
        const meta = this.db.getSyncMeta(doc._id)
        fullChanges.push(
          this.withRevisionHistory({
            seq: 0,
            docId: doc._id,
            rev: doc._rev || '',
            deleted: false,
            timestamp: meta?._lastModified ?? now, // 携带真实修改时间
            doc
          })
        )
      }
    }

    // checkpoint 丢失或目标首次连接时，全量快照还必须包含最新删除 tombstone。
    const latestChanges = new Map<string, FullChangeEntry>()
    for (const change of this.db.getChangesSince(0)) {
      if (!this.isSyncDocument(change.docId)) continue
      latestChanges.set(change.docId, { ...change, doc: null })
    }
    for (const change of latestChanges.values()) {
      if (!change.deleted || currentDocIds.has(change.docId)) continue
      fullChanges.push(
        this.withRevisionHistory({
          ...change,
          seq: 0,
          doc: null
        })
      )
    }

    if (fullChanges.length === 0) {
      console.log('[SyncClient] 全量扫描：无文档需要推送')
      this.commitSyntheticPushCheckpoint()
      this.enterLiveMode()
      return
    }

    console.log(`[SyncClient] 全量扫描推送 ${fullChanges.length} 条文档`)
    console.log('[SyncClient][Trace] full scan push prepared', {
      count: fullChanges.length,
      elapsed: Date.now() - this.startTraceAt
    })
    this.beginBatchPush(fullChanges)
  }

  private withRevisionHistory(change: FullChangeEntry): FullChangeEntry {
    const history = this.db.getRevisionHistory(change.docId, change.rev)
    if (history.length === 0) return change

    return {
      ...change,
      parentRev: change.parentRev ?? history[1] ?? null,
      revisionHistory: history
    }
  }

  // 初始化分批推送队列并发出第一批
  private beginBatchPush(changes: FullChangeEntry[]): void {
    this.pushQueue = changes
    this.pushOffset = 0
    this.pushMode = 'queue'
    this.sendNextBatch().catch((err) => {
      console.error('[SyncClient] 推送批次准备失败:', err)
      this.failCurrentPushTask(err)
      this.checkpoint = this.checkpointStore.failPush(this.checkpoint, err)
      this.setState('error')
    })
  }

  // 发送当前批次（pushOffset 指向队列起始位置）
  private async sendNextBatch(): Promise<void> {
    const batch = this.pushQueue.slice(this.pushOffset, this.pushOffset + PUSH_BATCH_SIZE)
    if (batch.length === 0) {
      // 所有批次推送完毕
      this.pushQueue = []
      this.pushOffset = 0
      this.pushMode = null
      this.finishAllPush()
      return
    }
    const total = this.pushQueue.length
    const end = Math.min(this.pushOffset + PUSH_BATCH_SIZE, total)
    this.checkpoint = this.checkpointStore.beginPush(this.checkpoint, batch)
    const fromSeq = this.checkpoint.push?.batchFromSeq || 0
    const toSeq = this.checkpoint.push?.batchToSeq || this.localPushSeq
    this.currentPushTaskId = this.pushTaskId(fromSeq, toSeq, batch)
    this.taskStore.upsert({
      id: this.currentPushTaskId,
      type: 'push_batch',
      status: 'running',
      payload: { fromSeq, toSeq, changes: batch, checkpointId: this.checkpointId }
    })
    this.retryScheduler.emitStatus()
    await this.uploadAttachmentBlobsForChanges(batch)
    console.log(`[SyncClient] 推送批次 ${this.pushOffset + 1}-${end} / ${total}`)
    console.log('[SyncClient][Trace] push batch send', {
      start: this.pushOffset + 1,
      end,
      total,
      elapsed: Date.now() - this.startTraceAt
    })
    this.send({ type: 'push', changes: batch, protocolVersion: SYNC_PROTOCOL_VERSION })
  }

  private handlePushOk(seq: number): void {
    console.log('[SyncClient][Trace] push_ok received', {
      seq,
      elapsed: Date.now() - this.startTraceAt
    })
    const checkpointBeforeCommit = this.checkpoint
    const pushMode = this.pushMode
    this.checkpoint = this.checkpointStore.commitPush(this.checkpoint)
    this.localPushSeq = this.checkpoint.localPushSeq
    if (this.currentPushTaskId) {
      this.taskStore.remove(this.currentPushTaskId)
      this.currentPushTaskId = null
      this.retryScheduler.emitStatus()
    }
    this.putRemoteCheckpoint()
    const pushedOnlySyntheticChanges = (checkpointBeforeCommit.push?.batchToSeq || 0) === 0

    // 推进游标到下一批
    this.pushOffset += PUSH_BATCH_SIZE

    if (seq > this.remotePullSeq) {
      this.remotePullSeq = seq
      this.checkpoint = this.checkpointStore.commitPull(this.checkpoint, seq)
      this.putRemoteCheckpoint()
    }

    if (pushMode === 'task') {
      this.pushMode = null
      this.startPush()
      return
    }

    // 继续发下一批
    if (pushedOnlySyntheticChanges && this.pushOffset >= this.pushQueue.length) {
      this.commitSyntheticPushCheckpoint()
    }

    this.sendNextBatch().catch((err) => {
      console.error('[SyncClient] 推送下一批失败:', err)
      this.failCurrentPushTask(err)
      this.checkpoint = this.checkpointStore.failPush(this.checkpoint, err)
      this.setState('error')
    })
  }

  private handlePushMissing(missingDigests: string[]): void {
    const batch = this.pushQueue.slice(this.pushOffset, this.pushOffset + PUSH_BATCH_SIZE)
    for (const change of batch) {
      if (!change.doc || change.deleted) continue
      const attachments = change.doc._attachments
      if (!attachments || typeof attachments !== 'object') continue
      for (const meta of Object.values(attachments) as any[]) {
        const digest = this.normalizeDigest(meta?.digest || '')
        if (!digest || !missingDigests.includes(digest)) continue
        this.taskStore.upsert({
          id: this.uploadTaskId(change.docId, digest),
          type: 'upload_blob',
          payload: {
            docId: change.docId,
            digest,
            contentType: meta?.content_type || meta?.contentType || 'application/octet-stream'
          },
          nextRetryAt: Date.now()
        })
      }
    }
    this.retryScheduler.emitStatus()
    this.uploadAttachmentBlobsForChanges(batch, new Set(missingDigests))
      .then(() => {
        console.warn(`[SyncClient] 服务端缺失 ${missingDigests.length} 个附件 blob，已补传并重试`)
        this.send({ type: 'push', changes: batch, protocolVersion: SYNC_PROTOCOL_VERSION })
      })
      .catch((err) => {
        console.error('[SyncClient] 缺失附件 blob 补传失败:', err)
        this.failCurrentPushTask(err)
        this.checkpoint = this.checkpointStore.failPush(this.checkpoint, err)
        this.setState('error')
      })
  }

  /**
   * 完成当前批次队列，并在客户端仍处于推送状态时进入实时模式。
   * @returns 无返回值。
   */
  private finishAllPush(): void {
    console.log(`[SyncClient] 全部推送完成, localPushSeq: ${this.localPushSeq}`)

    if (this.state === 'pushing') {
      this.enterLiveMode()
    }
  }

  // ==================== 阶段三：实时同步 ====================

  private enterLiveMode(): void {
    this.setState('live')
    console.log('[SyncClient] 进入实时同步模式')
    console.log(`[SyncClient][Trace] state live +${Date.now() - this.startTraceAt}ms`)
    this.stopListeningLocalChanges() // 防止重复监听
    this.listenLocalChanges()
    this.retryScheduler.retryNow()
    this.emit('live')
  }

  private localChangeHandler: ((entry: { seq: number; docId: string }) => void) | null = null
  private attachmentAddedHandler:
    | ((entry: { docId: string; md5: string; digest?: string; contentType: string }) => void)
    | null = null

  private listenLocalChanges(): void {
    this.localChangeHandler = (_entry) => {
      if (this.state !== 'live') return

      const changes = this.db.getChangesSince(this.localPushSeq)
      if (changes.length === 0) return

      const fullChanges: FullChangeEntry[] = changes.map((c) => ({
        ...c,
        doc: c.deleted ? null : this.db.get(c.docId)
      }))

      // live 模式变更量通常很小（用户刚操作的几条），直接发送
      // localPushSeq 在 push_ok 时按当前 batchToSeq 推进，
      // 这里用 beginBatchPush 保证与批量推送路径完全一致（含重试）
      this.setState('pushing')
      this.beginBatchPush(fullChanges)
    }

    this.attachmentAddedHandler = ({ docId, md5, digest, contentType }: any) => {
      this.uploadAttachment(docId, digest || md5, contentType).catch(() => {
        // blob 上传失败时保留本地 revision，下次同步仍可根据 digest 补传
      })
    }

    this.db.on('change', this.localChangeHandler)
    this.db.on('attachment-added', this.attachmentAddedHandler)
  }

  private stopListeningLocalChanges(): void {
    if (this.localChangeHandler) {
      this.db.removeListener('change', this.localChangeHandler)
      this.localChangeHandler = null
    }
    if (this.attachmentAddedHandler) {
      this.db.removeListener('attachment-added', this.attachmentAddedHandler)
      this.attachmentAddedHandler = null
    }
  }

  // ==================== 附件同步 ====================

  private getHttpBase(): string {
    const url = this.config!.serverUrl
    return url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
  }

  private normalizeDigest(value: string): string {
    if (!value) return ''
    return value.startsWith('md5-') ? value : `md5-${value}`
  }

  private uploadTaskId(docId: string, digest: string): string {
    return `upload_blob:${docId}:${this.normalizeDigest(digest)}`
  }

  private downloadTaskId(docId: string, digest: string): string {
    return `download_blob:${docId}:${this.normalizeDigest(digest)}`
  }

  private pushTaskId(fromSeq: number, toSeq: number, changes: FullChangeEntry[]): string {
    const revs = changes.map((change) => `${change.docId}@${change.rev}`).join('|')
    return `push_batch:${fromSeq}:${toSeq}:${crypto.createHash('sha1').update(revs).digest('hex')}`
  }

  private async runSyncTask(task: SyncTask): Promise<void> {
    if (task.type === 'upload_blob') {
      const payload = task.payload as UploadBlobTaskPayload
      await this.uploadAttachmentDirect(payload.docId, payload.digest, payload.contentType)
      this.taskStore.remove(task.id)
      return
    }
    if (task.type === 'download_blob') {
      const payload = task.payload as DownloadBlobTaskPayload
      if (this.hasLocalAttachmentBlob(payload.docId, payload.digest)) {
        this.taskStore.remove(task.id)
        return
      }
      await this.downloadAttachmentDirect(payload.docId, payload.digest)
      this.taskStore.remove(task.id)
      return
    }
    if (task.type === 'push_batch') {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket is not connected')
      }
      const payload = task.payload as PushBatchTaskPayload
      this.pushMode = 'task'
      this.currentPushTaskId = task.id
      this.pushQueue = []
      this.pushOffset = 0
      this.checkpoint = this.checkpointStore.beginPush(this.checkpoint, payload.changes)
      await this.uploadAttachmentBlobsForChanges(payload.changes)
      this.send({ type: 'push', changes: payload.changes, protocolVersion: SYNC_PROTOCOL_VERSION })
    }
  }

  private async uploadAttachment(
    docId: string,
    digestOrMd5: string,
    contentType: string
  ): Promise<void> {
    const digest = this.normalizeDigest(digestOrMd5)
    this.taskStore.upsert({
      id: this.uploadTaskId(docId, digest),
      type: 'upload_blob',
      payload: { docId, digest, contentType },
      nextRetryAt: Date.now()
    })
    this.retryScheduler.retryNow()
    await this.uploadAttachmentDirect(docId, digest, contentType)
    this.taskStore.remove(this.uploadTaskId(docId, digest))
    this.retryScheduler.emitStatus()
  }

  private async uploadAttachmentDirect(
    docId: string,
    digestOrMd5: string,
    contentType: string
  ): Promise<void> {
    if (!this.config?.token) throw new Error('Missing sync token')
    const base = this.getHttpBase()
    const data = this.db.getAttachment(docId)
    if (!data) throw new Error(`Missing local attachment blob: ${docId}`)
    const digest = this.normalizeDigest(digestOrMd5)

    try {
      const resp = await fetch(`${base}/api/sync/attachments/blobs/${encodeURIComponent(digest)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': contentType,
          'X-Device-Id': this.config.deviceId
        },
        body: Buffer.from(data)
      })
      if (!resp.ok) {
        const err = new Error(`Attachment upload failed: ${resp.status}`)
        ;(err as any).status = resp.status
        throw err
      }
      console.log(`[SyncClient] 附件 blob 上传: ${docId} ${digest}`)
    } catch (err) {
      console.error('[SyncClient] 附件上传失败:', docId, err)
      throw err
    }
  }

  private async uploadAttachmentBlobsForChanges(
    changes: FullChangeEntry[],
    onlyDigests?: Set<string>
  ): Promise<void> {
    const seen = new Set<string>()
    const uploads: Promise<void>[] = []
    for (const change of changes) {
      if (!change.doc || change.deleted) continue
      const attachments = change.doc._attachments
      if (!attachments || typeof attachments !== 'object') continue
      for (const meta of Object.values(attachments) as any[]) {
        const digest = this.normalizeDigest(meta?.digest || '')
        if (!digest) continue
        if (onlyDigests && !onlyDigests.has(digest)) continue
        const key = `${change.docId}\n${digest}`
        if (seen.has(key)) continue
        seen.add(key)
        uploads.push(
          this.uploadAttachment(
            change.docId,
            digest,
            meta?.content_type || meta?.contentType || 'application/octet-stream'
          )
        )
      }
    }
    await Promise.all(uploads)
  }

  private async downloadAttachment(
    docId: string,
    digestOrMd5?: string,
    meta: any = {}
  ): Promise<void> {
    const digest = digestOrMd5 ? this.normalizeDigest(digestOrMd5) : ''
    if (!digest) return
    if (this.hasLocalAttachmentBlob(docId, digest)) return
    this.taskStore.upsert({
      id: this.downloadTaskId(docId, digest),
      type: 'download_blob',
      payload: {
        docId,
        digest,
        contentType: meta?.content_type || meta?.contentType,
        length: meta?.length
      },
      nextRetryAt: Date.now()
    })
    this.retryScheduler.retryNow()
    await this.downloadAttachmentDirect(docId, digest)
    this.taskStore.remove(this.downloadTaskId(docId, digest))
    this.retryScheduler.emitStatus()
  }

  private async downloadAttachmentDirect(docId: string, digestOrMd5?: string): Promise<void> {
    if (!this.config?.token) throw new Error('Missing sync token')
    const base = this.getHttpBase()
    const digest = digestOrMd5 ? this.normalizeDigest(digestOrMd5) : ''
    if (!digest) return
    try {
      const resp = await fetch(`${base}/api/sync/attachments/blobs/${encodeURIComponent(digest)}`, {
        headers: { Authorization: `Bearer ${this.config.token}` }
      })
      if (!resp.ok) {
        const err = new Error(`Attachment download failed: ${resp.status}`)
        ;(err as any).status = resp.status
        throw err
      }
      const contentType = resp.headers.get('content-type') || 'application/octet-stream'
      const buffer = Buffer.from(await resp.arrayBuffer())
      const result = this.db.putAttachmentFromRemote(docId, buffer, contentType)
      if (result?.ok === false) {
        throw new Error(result.message || `Attachment store failed: ${docId}`)
      }
      console.log(`[SyncClient] 附件下载: ${docId}${digest ? ` ${digest}` : ''}`)
    } catch (err) {
      console.error('[SyncClient] 附件下载失败:', docId, err)
      throw err
    }
  }

  private hasLocalAttachmentBlob(docId: string, digestOrMd5: string): boolean {
    const digest = this.normalizeDigest(digestOrMd5)
    if (!digest) return false
    const localData = this.db.getAttachment(docId)
    if (!localData) return false
    const localMeta = this.db.getAttachmentType(docId)
    if (!localMeta) return false
    return this.normalizeDigest(localMeta.digest || localMeta.md5 || '') === digest
  }

  private downloadMissingDocumentAttachments(changes: FullChangeEntry[]): void {
    for (const change of changes) {
      if (!change.doc || change.deleted) continue
      const attachments = change.doc._attachments
      if (!attachments || typeof attachments !== 'object') continue
      for (const meta of Object.values(attachments) as any[]) {
        const digest = this.normalizeDigest(meta?.digest || '')
        if (!digest) continue
        if (!this.hasLocalAttachmentBlob(change.docId, digest)) {
          this.downloadAttachment(change.docId, digest, meta).catch((err) => {
            console.error('[SyncClient] 文档附件下载失败:', change.docId, err)
          })
        }
      }
    }
  }

  private handleRemoteChange(change: FullChangeEntry): void {
    try {
      this.db.applyRemoteChange({
        docId: change.docId,
        rev: change.rev,
        parentRev: change.parentRev || null,
        deleted: change.deleted,
        timestamp: change.timestamp,
        doc: change.doc,
        resolution: change.resolution
      })

      if (change.seq > this.remotePullSeq) {
        this.checkpoint = this.checkpointStore.commitPull(this.checkpoint, change.seq)
        this.remotePullSeq = this.checkpoint.remotePullSeq
        this.putRemoteCheckpoint()
      }

      // 触发 pull 事件
      if (change.doc) {
        this.emit('pull', [change.doc])
      }
      this.downloadMissingDocumentAttachments([change])
    } catch (err) {
      console.error('[SyncClient] 应用实时变更失败:', change.docId, err)
    }
  }

  private commitSyntheticPushCheckpoint(): void {
    if (this.fullScanPushUpperSeq === null) return
    this.checkpoint = this.checkpointStore.commitLocalPushSeq(
      this.checkpoint,
      this.fullScanPushUpperSeq
    )
    this.localPushSeq = this.checkpoint.localPushSeq
    this.putRemoteCheckpoint()
    this.fullScanPushUpperSeq = null
  }

  private requestRemoteCheckpoint(): void {
    if (!this.checkpointId) {
      this.startPull()
      return
    }
    this.send({ type: 'get_checkpoint', checkpointId: this.checkpointId })
  }

  private handleRemoteCheckpoint(remote?: RemoteCheckpointPayload): void {
    if (this.checkpointLoadedFromRemote) return
    this.checkpointLoadedFromRemote = true

    if (remote?.id) {
      const remotePullSeq = this.safeSeq(remote.remotePullSeq ?? remote.lastSeq)
      const remotePushSeq = this.safeSeq(remote.localPushSeq)
      if (remotePullSeq > 0 && remotePullSeq < this.checkpoint.remotePullSeq) {
        this.checkpoint = { ...this.checkpoint, remotePullSeq }
      }
      if (remotePushSeq > 0 && remotePushSeq < this.checkpoint.localPushSeq) {
        this.checkpoint = { ...this.checkpoint, localPushSeq: remotePushSeq }
      }
      if ((remote.syncEpoch || 0) > this.checkpoint.syncEpoch) {
        this.checkpoint = { ...this.checkpoint, syncEpoch: remote.syncEpoch || 0 }
      }
      if ((remote.protocolVersion || 0) > this.checkpoint.protocolVersion) {
        this.checkpoint = { ...this.checkpoint, protocolVersion: remote.protocolVersion || 0 }
      }
      this.checkpointStore.save(this.checkpoint)
      this.remotePullSeq = this.checkpoint.remotePullSeq
      this.localPushSeq = this.checkpoint.localPushSeq
    }

    this.startPull()
  }

  private putRemoteCheckpoint(): void {
    if (!this.checkpointId || !this.config?.enabled) return
    this.send({
      type: 'put_checkpoint',
      checkpoint: {
        id: this.checkpointId,
        sourceId: this.config.deviceId,
        targetId: this.config.serverUrl,
        lastSeq: this.checkpoint.remotePullSeq,
        remotePullSeq: this.checkpoint.remotePullSeq,
        localPushSeq: this.checkpoint.localPushSeq,
        syncEpoch: this.checkpoint.syncEpoch,
        protocolVersion: this.checkpoint.protocolVersion,
        data: this.checkpoint
      }
    })
  }

  private buildCheckpointId(): string {
    if (!this.config) {
      return this.buildCheckpointIdFor(null)
    }
    return this.buildCheckpointIdFor(this.config)
  }

  private buildCheckpointIdFor(config: SyncConfig | null): string {
    const uid = config?.username || 'anonymous'
    const deviceId = config?.deviceId || 'unknown-device'
    const serverUrl = config?.serverUrl || 'unknown-server'
    const input = `${uid}\n${deviceId}\n${serverUrl}\n${SYNC_PROTOCOL_VERSION}`
    return `ztools-${crypto.createHash('sha1').update(input).digest('hex')}`
  }

  private safeSeq(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10)
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
    }
    return 0
  }

  /**
   * 判断文档是否属于账号同步白名单。
   * @param docId 待检查的文档 ID。
   * @returns 文档需要进入同步链路时返回 true。
   */
  private isSyncDocument(docId: string): boolean {
    return SYNC_PREFIXES.some((prefix) => docId.startsWith(prefix))
  }

  // ==================== 辅助方法 ====================

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' })
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * 在同步仍启用且认证未被阻断时按指数退避调度重连。
   * @returns 无返回值。
   */
  private scheduleReconnect(): void {
    if (!this.config?.enabled || this.authReconnectBlocked) return

    this.reconnectTimer = setTimeout(() => {
      console.log(`[SyncClient] 重连中 (delay: ${this.reconnectDelay}ms)`)
      this.connect()
    }, this.reconnectDelay)

    // 指数退避
    if (this.reconnectDelay < 60000) {
      this.reconnectDelay *= 2
    } else {
      this.reconnectDelay = 60000 + Math.floor(60000 * Math.random())
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // 取消进行中的分批推送
    this.pushQueue = []
    this.pushOffset = 0
    this.currentPushTaskId = null
    this.pushMode = null
    this.fullScanPushUpperSeq = null
  }

  private failCurrentPushTask(error: unknown): void {
    if (!this.currentPushTaskId) return
    this.taskStore.markFailed(this.currentPushTaskId, error, 'pending')
    this.currentPushTaskId = null
    this.retryScheduler.emitStatus()
  }
}

class SyncCredentialsInvalidError extends Error {
  /**
   * 创建一个可阻断自动重连的凭据失效错误。
   * @param message 展示给同步状态界面的错误消息。
   * @returns 初始化后的凭据失效错误实例。
   */
  constructor(message: string) {
    super(message)
    this.name = 'SyncCredentialsInvalidError'
  }
}

/**
 * 判断 JWT 是否已经过期或将在给定提前量内过期。
 * @param token 待检查的 JWT 字符串。
 * @param skewMs 提前判定为过期的毫秒数。
 * @returns token 无法解析、缺少过期时间或即将过期时返回 true。
 */
function isJwtExpiring(token: string, skewMs = 60000): boolean {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return true
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    const exp = Number(payload?.exp || 0)
    if (!exp) return true
    return exp * 1000 <= Date.now() + skewMs
  } catch {
    return true
  }
}
