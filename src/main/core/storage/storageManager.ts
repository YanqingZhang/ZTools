import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import LmdbDatabase from '../lmdb'
import {
  ensure3Layout,
  hasLegacyLmdb,
  type AppDataPathOptions,
  type ZToolsDataLayout
} from '../appData/appDataPaths'
import { readDataVersion, writeDataVersion } from '../appData/appDataVersion'
import { StorageRouter } from './storageRouter'

const DEFAULT_MAP_SIZE = 2 * 1024 * 1024 * 1024
const DEFAULT_MAX_DBS = 6

export interface StorageInitState {
  firstRun: boolean
  legacyLmdbFound: boolean
  importedFromLegacy: boolean
  layout: ZToolsDataLayout
}

export interface StorageManagerOptions extends AppDataPathOptions {
  mapSize?: number
}

export class StorageManager extends EventEmitter {
  private deviceDb: LmdbDatabase | null = null
  private accountDb: LmdbDatabase | null = null
  private router: StorageRouter | null = null
  private currentAccountUid: string | null = null
  private initState: StorageInitState | null = null

  constructor(private options: StorageManagerOptions = {}) {
    super()
  }

  init(): StorageInitState {
    if (this.initState && this.deviceDb && this.accountDb && this.router) {
      return this.initState
    }

    const existingVersion = readDataVersion(this.options)
    const firstRun = !existingVersion
    const legacyLmdbFound = firstRun && hasLegacyLmdb(this.options)
    const layout = ensure3Layout(this.options)
    const version =
      existingVersion ||
      (legacyLmdbFound ? null : writeDataVersion({ importedFromLegacy: false }, this.options))

    this.deviceDb = this.openDb(layout.deviceLmdbPath)
    this.currentAccountUid = this.loadPersistedAccountUid(this.deviceDb)
    this.accountDb = this.openDb(this.accountPathForUid(this.currentAccountUid, layout))
    this.router = new StorageRouter(this)
    this.router.bindAccountDb(this.accountDb)

    this.initState = {
      firstRun,
      legacyLmdbFound,
      importedFromLegacy: Boolean(version?.importedFromLegacy),
      layout
    }
    return this.initState
  }

  getInitState(): StorageInitState {
    return this.init()
  }

  getLayout(): ZToolsDataLayout {
    return this.init().layout
  }

  getDeviceDb(): LmdbDatabase {
    this.init()
    return this.deviceDb!
  }

  getAccountDb(): LmdbDatabase {
    this.init()
    return this.accountDb!
  }

  getRouter(): StorageRouter {
    this.init()
    return this.router!
  }

  getCurrentAccountUid(): string | null {
    this.init()
    return this.currentAccountUid
  }

  switchAccount(uid?: string | null): void {
    this.init()
    const normalizedUid = uid?.trim() || null
    if (normalizedUid === this.currentAccountUid) return

    const nextPath = this.accountPathForUid(normalizedUid, this.getLayout())
    const nextDb = this.openDb(nextPath)
    const previousDb = this.accountDb

    this.currentAccountUid = normalizedUid
    this.accountDb = nextDb
    this.router?.bindAccountDb(nextDb)

    if (previousDb) {
      try {
        previousDb.close()
      } catch (error) {
        console.error('[Storage] close previous account db failed:', error)
      }
    }

    this.persistCurrentAccountUid(normalizedUid)

    this.emit('account-switched', { uid: normalizedUid })
  }

  /**
   * 关闭当前账号数据库、切回默认数据空间，并永久删除该账号的本地数据库目录。
   * @param uid 要删除的当前账号标识。
   * @returns 无返回值。
   * @throws 账号标识为空、与当前账号不一致或目录边界校验失败时抛出错误。
   */
  deleteCurrentAccount(uid: string): void {
    this.init()
    const normalizedUid = uid?.trim()

    // 只允许调用方删除当前已激活账号，避免误删默认空间或其他账号。
    if (!normalizedUid) throw new Error('删除本地账号数据时账号标识不能为空')
    if (!this.currentAccountUid || normalizedUid !== this.currentAccountUid) {
      throw new Error('待删除账号与当前本地账号不一致')
    }

    const layout = this.getLayout()
    const accountsRoot = path.resolve(layout.accountsRoot)
    const accountPath = path.resolve(this.accountPathForUid(normalizedUid, layout))
    const defaultAccountPath = path.resolve(layout.defaultAccountLmdbPath)

    // 删除目标必须是 accounts 的直属哈希目录，且绝不能命中默认数据空间。
    if (path.dirname(accountPath) !== accountsRoot || accountPath === defaultAccountPath) {
      throw new Error('待删除账号目录超出允许范围')
    }

    // 先切换并关闭旧 LMDB 句柄，确保文件系统允许递归删除账号目录。
    this.switchAccount(null)

    // 状态切换完成后再做不可恢复的目录清理，保留默认空间和其他账号数据。
    fs.rmSync(accountPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  close(): void {
    this.router?.unbind()
    this.router = null
    for (const db of [this.accountDb, this.deviceDb]) {
      try {
        db?.close()
      } catch (error) {
        console.error('[Storage] close db failed:', error)
      }
    }
    this.accountDb = null
    this.deviceDb = null
    this.currentAccountUid = null
    this.initState = null
  }

  private openDb(dbPath: string): LmdbDatabase {
    return new LmdbDatabase({
      path: dbPath,
      mapSize: this.options.mapSize || DEFAULT_MAP_SIZE,
      maxDbs: DEFAULT_MAX_DBS
    })
  }

  private accountPathForUid(uid: string | null, layout: ZToolsDataLayout): string {
    return uid ? path.join(layout.accountsRoot, hashAccountId(uid)) : layout.defaultAccountLmdbPath
  }

  private loadPersistedAccountUid(deviceDb: LmdbDatabase): string | null {
    const doc = deviceDb.get('SYNC/current-account')
    const uid = doc?.data?.uid
    return typeof uid === 'string' && uid.trim() ? uid.trim() : null
  }

  private persistCurrentAccountUid(uid: string | null): void {
    const deviceDb = this.getDeviceDb()
    const existing = deviceDb.get('SYNC/current-account')
    deviceDb.put({
      _id: 'SYNC/current-account',
      _rev: existing?._rev,
      data: { uid }
    })
  }
}

export function hashAccountId(uid: string): string {
  return crypto.createHash('sha256').update(uid).digest('hex').slice(0, 16)
}

export const storageManager = new StorageManager()
