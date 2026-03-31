import type { PluginManager } from '../../managers/pluginManager'
import { app, dialog, ipcMain, shell } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import * as tar from 'tar'
import { normalizeIconPath } from '../../common/iconUtils'
import { isBundledInternalPlugin } from '../../core/internalPlugins'
import lmdbInstance from '../../core/lmdb/lmdbInstance'
import windowManager from '../../managers/windowManager'
import { sleep, shuffleArray } from '../../utils/common.js'
import { downloadFile } from '../../utils/download.js'
import { httpGet } from '../../utils/httpRequest.js'
import yaml from 'yaml'
import AdmZip from 'adm-zip'
import { isValidZpx } from '../../utils/zpxArchive.js'
import { packZpx, extractZpx, readTextFromZpx, readFileFromZpx } from '../../utils/zpxArchive.js'
import { pluginFeatureAPI } from '../plugin/feature'
import webSearchAPI from './webSearch'
import databaseAPI from '../shared/database'
import pluginDeviceAPI from '../plugin/device'
import {
  applyDevProjectsOrderUpdate,
  buildInstalledDevelopmentPlugin,
  canPackageDevProject,
  DEV_PLUGIN_PROJECTS_DB_KEY,
  DEV_PLUGIN_REGISTRY_DB_KEY,
  getDevPluginLocalBindingsKey,
  insertDevProjectAtTop,
  mergeLegacyDevelopmentProjects,
  migrateLegacyDevProjects,
  readDevProjectRecords,
  readDevPluginLocalBindingsDoc,
  readDevPluginRegistryDoc,
  upsertDevProjectFromConfig,
  validateRepairConfigSelection,
  type DevPluginLocalBindingsDoc,
  type DevPluginRegistryDoc,
  type DevProjectLocalBinding
} from './pluginDevelopmentRegistry'
import {
  getPluginSource,
  isSamePluginVariantRef,
  normalizePluginVariantRef,
  removePluginVariantRef,
  type PluginVariantRef,
  type PluginSource
} from '../../../shared/pluginVariantRef'
import { getPluginDataPrefix } from '../../../shared/pluginRuntimeNamespace'

// 插件目录
const PLUGIN_DIR = path.join(app.getPath('userData'), 'plugins')
const PLUGIN_MARKET_STOREFRONT_CACHE_KEY = 'plugin-market-storefront'
const PLUGIN_MARKET_STOREFRONT_FINGERPRINT_CACHE_KEY = 'plugin-market-storefront-fingerprint'

type PluginMarketPlugin = {
  name: string
  version: string
  title?: string
  description?: string
  logo?: string
  platform?: string[]
  downloadUrl?: string
  [key: string]: unknown
}

type PluginMarketBannerItem = {
  image: string
  url?: string
}

type PluginMarketCategoryConfig = {
  key?: string
  title?: string
  description?: string
  icon?: string
  list?: string[]
}

type PluginMarketLayoutSectionConfig = {
  type?: string
  title?: string
  count?: number
  height?: number
  showDescription?: boolean
  children?: PluginMarketBannerItem[]
  categories?: string[]
  plugins?: string[]
}

type PluginMarketCategoryLayoutSection = {
  type: string // 'list' | 'fixed' | 'random'
  title?: string // 支持模板字符串如 '${title}系列，共${count}个工具'
  count?: number
  plugins?: string[]
}

type PluginMarketStorefrontCategory = {
  key: string
  title: string
  description?: string
  icon?: string
  plugins: PluginMarketPlugin[]
}

type PluginMarketStorefrontSection =
  | {
      type: 'banner'
      key: string
      items: PluginMarketBannerItem[]
      height?: number
    }
  | {
      type: 'navigation'
      key: string
      title?: string
      categories: Array<{
        key: string
        title: string
        description?: string
        icon?: string
        showDescription: boolean
        pluginCount: number
      }>
    }
  | {
      type: 'fixed' | 'random'
      key: string
      title?: string
      plugins: PluginMarketPlugin[]
    }

type PluginMarketStorefront = {
  sections: PluginMarketStorefrontSection[]
  categories: Record<string, PluginMarketStorefrontCategory>
  categoryLayouts: Record<string, PluginMarketCategoryLayoutSection[]>
}

type PluginMarketResult = {
  success: boolean
  data?: PluginMarketPlugin[]
  storefront?: PluginMarketStorefront
  error?: string
}

/**
 * 插件管理API - 主程序专用
 */
export class PluginsAPI {
  private mainWindow: Electron.BrowserWindow | null = null
  private pluginManager: PluginManager | null = null

  public init(mainWindow: Electron.BrowserWindow, pluginManager: PluginManager): void {
    this.mainWindow = mainWindow
    this.pluginManager = pluginManager
    this.setupIPC()
  }

  private setupIPC(): void {
    ipcMain.handle('get-plugins', () => this.getPlugins())
    ipcMain.handle('get-all-plugins', () => this.getAllPlugins())
    ipcMain.handle('import-plugin', () => this.importPlugin())
    ipcMain.handle('import-dev-plugin', (_event, pluginJsonPath?: string) =>
      this.importDevPlugin(pluginJsonPath)
    )
    ipcMain.handle('get-dev-projects', () => this.getDevProjects())
    ipcMain.handle('update-dev-projects-order', (_event, pluginNames: string[]) =>
      this.updateDevProjectsOrder(pluginNames)
    )
    ipcMain.handle('remove-dev-project', (_event, pluginName: string) =>
      this.removeDevProject(pluginName)
    )
    ipcMain.handle('install-dev-plugin', (_event, pluginPath: string) =>
      this.installDevPlugin(pluginPath)
    )
    ipcMain.handle('uninstall-dev-plugin', (_event, pluginPath: string) =>
      this.uninstallDevPlugin(pluginPath)
    )
    ipcMain.handle('validate-dev-project', (_event, pluginName: string) =>
      this.validateDevProject(pluginName)
    )
    ipcMain.handle('reload-dev-project', (_event, pluginName: string) =>
      this.reloadDevProject(pluginName)
    )
    ipcMain.handle('select-dev-project-config', (_event, pluginName: string) =>
      this.selectDevProjectConfig(pluginName)
    )
    ipcMain.handle('package-dev-project', (_event, pluginName: string) =>
      this.packageDevProject(pluginName)
    )
    ipcMain.handle('delete-plugin', (_event, pluginPath: string) => this.deletePlugin(pluginPath))
    ipcMain.handle('reload-plugin', (_event, pluginPath: string) => this.reloadPlugin(pluginPath))
    ipcMain.handle('get-running-plugins', () => this.getRunningPlugins())
    ipcMain.handle('kill-plugin', (_event, pluginPath: string) => this.killPlugin(pluginPath))
    ipcMain.handle('kill-plugin-and-return', (_event, pluginPath: string) =>
      this.killPluginAndReturn(pluginPath)
    )
    ipcMain.handle('fetch-plugin-market', () => this.fetchPluginMarket())
    ipcMain.handle('install-plugin-from-market', (_event, plugin: any) =>
      this.installPluginFromMarket(plugin)
    )
    ipcMain.handle('get-plugin-readme', (_event, pluginPathOrName: string, pluginName?: string) =>
      this.getPluginReadme(pluginPathOrName, pluginName)
    )
    ipcMain.handle('get-plugin-db-data', (_event, pluginRef: PluginVariantRef | string) =>
      this.getPluginDbData(pluginRef)
    )
    ipcMain.handle('read-plugin-info-from-zpx', (_event, zpxPath: string) =>
      this.readPluginInfoFromZpx(zpxPath)
    )
    ipcMain.handle('install-plugin-from-path', (_event, zpxPath: string) =>
      this.installPluginFromPath(zpxPath)
    )
    // mainPush 功能：查询插件的动态搜索结果
    ipcMain.handle(
      'query-main-push',
      async (_event, pluginPath: string, featureCode: string, queryData: any) => {
        try {
          return await this.pluginManager?.queryMainPush(pluginPath, featureCode, queryData)
        } catch (error: unknown) {
          console.error('[Plugins] mainPush 查询失败:', error)
          return []
        }
      }
    )

    // mainPush 功能：通知插件用户选择了搜索结果
    ipcMain.handle(
      'select-main-push',
      async (_event, pluginPath: string, featureCode: string, selectData: any) => {
        try {
          return await this.pluginManager?.selectMainPush(pluginPath, featureCode, selectData)
        } catch (error: unknown) {
          console.error('[Plugins] mainPush 选择失败:', error)
          return false
        }
      }
    )

    ipcMain.handle(
      'call-headless-plugin',
      async (_event, pluginPath: string, featureCode: string, action: any) => {
        try {
          const result = await this.pluginManager?.callHeadlessPluginMethod(
            pluginPath,
            featureCode,
            action
          )
          return { success: true, result }
        } catch (error: unknown) {
          console.error('[Plugins] 调用无界面插件失败:', error)
          return { success: false, error: error instanceof Error ? error.message : '未知错误' }
        }
      }
    )

    ipcMain.handle('get-plugin-memory-info', async (_event, pluginPath: string) => {
      try {
        const memoryInfo = await this.pluginManager?.getPluginMemoryInfo(pluginPath)
        return { success: true, data: memoryInfo }
      } catch (error: unknown) {
        console.error('[Plugins] 获取插件内存信息失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '获取失败' }
      }
    })

    ipcMain.handle(
      'install-plugin-from-npm',
      (_event, options: { packageName: string; useChinaMirror?: boolean }) =>
        this.installPluginFromNpm(options.packageName, options.useChinaMirror)
    )

    ipcMain.handle('export-all-plugins', () => this.exportAllPlugins())
  }

  // 获取插件列表（过滤掉内置插件，用于插件中心显示）
  public async getPlugins(): Promise<any[]> {
    const allPlugins = await this.getAllPlugins()
    // 过滤掉所有内置插件（system、setting 等）
    return allPlugins.filter((plugin: any) => !isBundledInternalPlugin(plugin.name))
  }

  // 获取所有插件列表（包括 system 插件，用于生成搜索指令）
  public async getAllPlugins(): Promise<any[]> {
    try {
      const data = databaseAPI.dbGet('plugins')
      const plugins = data || []

      // 合并动态 features 和网页快开搜索引擎
      const webSearchFeatures = await webSearchAPI.getSearchEngineFeatures()
      for (const plugin of plugins) {
        const dynamicFeatures = pluginFeatureAPI.loadDynamicFeatures(
          plugin.name,
          getPluginSource(plugin.isDevelopment)
        )
        plugin.features = [...(plugin.features || []), ...dynamicFeatures]

        // 将网页快开搜索引擎作为系统插件的动态 features
        if (plugin.name === 'system' && webSearchFeatures.length > 0) {
          plugin.features = [...plugin.features, ...webSearchFeatures]
        }

        // 处理插件 logo 路径
        if (plugin.logo) {
          plugin.logo = normalizeIconPath(plugin.logo, plugin.path)
        }

        // 处理每个 feature 的 icon 路径
        if (plugin.features && Array.isArray(plugin.features)) {
          for (const feature of plugin.features) {
            if (feature.icon) {
              feature.icon = normalizeIconPath(feature.icon, plugin.path)
            }
          }
        }
      }

      return plugins
    } catch (error) {
      console.error('[Plugins] 获取插件列表失败:', error)
      return []
    }
  }

  private readInstalledPlugins(): any[] {
    const plugins = databaseAPI.dbGet('plugins')
    return Array.isArray(plugins) ? plugins : []
  }

  private writeInstalledPlugins(plugins: any[]): void {
    databaseAPI.dbPut('plugins', plugins)
  }

  private notifyPluginsChanged(): void {
    this.mainWindow?.webContents.send('plugins-changed')
  }

  private getDeviceId(): string {
    try {
      return pluginDeviceAPI.getDeviceIdPublic()
    } catch (error) {
      console.warn('[Plugins] 获取设备 ID 失败，使用 fallback:', error)
      const fallbackSeed = [
        app.getPath('userData'),
        app.getName(),
        process.platform,
        process.arch,
        process.env.USER || '',
        process.env.USERNAME || '',
        process.env.HOSTNAME || ''
      ].join('|')
      return createHash('sha256').update(fallbackSeed).digest('hex').slice(0, 32)
    }
  }

  private getCurrentDeviceBindingsDbKey(): { deviceId: string; key: string } {
    const deviceId = this.getDeviceId()
    return {
      deviceId,
      key: getDevPluginLocalBindingsKey(deviceId)
    }
  }

  private writeDevProjectState(
    registry: DevPluginRegistryDoc,
    localBindings: DevPluginLocalBindingsDoc
  ): void {
    const localBindingsKey = getDevPluginLocalBindingsKey(localBindings.deviceId)
    databaseAPI.dbPut(DEV_PLUGIN_REGISTRY_DB_KEY, registry)
    databaseAPI.dbPut(localBindingsKey, localBindings)
  }

  private async migrateLegacyDevProjectStateIfNeeded(
    registry: DevPluginRegistryDoc,
    localBindings: DevPluginLocalBindingsDoc
  ): Promise<{ registry: DevPluginRegistryDoc; localBindings: DevPluginLocalBindingsDoc }> {
    const hasRegistryProjects = Object.keys(registry.projects).length > 0
    const hasLocalBindings = Object.keys(localBindings.bindings).length > 0
    if (hasRegistryProjects || hasLocalBindings) {
      return { registry, localBindings }
    }

    const legacyRecords = readDevProjectRecords(databaseAPI.dbGet(DEV_PLUGIN_PROJECTS_DB_KEY))
    const installedPlugins = this.readInstalledPlugins()
    const mergedLegacyRecords = mergeLegacyDevelopmentProjects(legacyRecords, installedPlugins)
    if (mergedLegacyRecords.length === 0) {
      return { registry, localBindings }
    }

    console.log('[Plugins] 检测到旧版开发项目数据，开始迁移:', {
      legacyCount: mergedLegacyRecords.length,
      deviceId: localBindings.deviceId
    })

    const pluginConfigs: Record<string, any> = {}
    for (const record of mergedLegacyRecords) {
      const pluginJsonPath = path.join(record.path, 'plugin.json')
      try {
        pluginConfigs[pluginJsonPath] = await this.readPluginConfigFromFile(pluginJsonPath)
      } catch {
        // 忽略失效记录，迁移 helper 会跳过无法识别的配置
      }
    }

    const migrated = migrateLegacyDevProjects({
      legacyRecords: mergedLegacyRecords,
      installedPlugins,
      pluginConfigs,
      deviceId: localBindings.deviceId
    })

    this.writeDevProjectState(migrated.registry, migrated.localBindings)
    console.log('[Plugins] 开发项目旧数据迁移完成:', {
      projectCount: Object.keys(migrated.registry.projects).length,
      bindingCount: Object.keys(migrated.localBindings.bindings).length,
      deviceId: migrated.localBindings.deviceId
    })
    return migrated
  }

  private async readDevProjectState(): Promise<{
    registry: DevPluginRegistryDoc
    localBindings: DevPluginLocalBindingsDoc
  }> {
    const { deviceId, key } = this.getCurrentDeviceBindingsDbKey()
    const registryRaw = databaseAPI.dbGet(DEV_PLUGIN_REGISTRY_DB_KEY)
    const localBindingsRaw = databaseAPI.dbGet(key)
    const registry = readDevPluginRegistryDoc(registryRaw)
    const localBindings = readDevPluginLocalBindingsDoc(localBindingsRaw, deviceId)
    return this.migrateLegacyDevProjectStateIfNeeded(registry, localBindings)
  }

  private nowIso(): string {
    return new Date().toISOString()
  }

  /**
   * 将 name、项目目录、配置路径和已安装开发插件路径统一解析为开发项目 identity。
   */
  private resolveDevProjectName(
    projectNameOrPath: string,
    registry: DevPluginRegistryDoc,
    localBindings: DevPluginLocalBindingsDoc,
    installedPlugins: any[] = []
  ): string | null {
    if (typeof projectNameOrPath !== 'string' || !projectNameOrPath.trim()) {
      return null
    }
    const normalizedIdentity = projectNameOrPath.trim()
    if (registry.projects[normalizedIdentity]) {
      return normalizedIdentity
    }

    const maybePath = path.resolve(normalizedIdentity)
    for (const binding of Object.values(localBindings.bindings)) {
      if (binding.projectPath && path.resolve(binding.projectPath) === maybePath) {
        return binding.name
      }
      if (binding.configPath && path.resolve(binding.configPath) === maybePath) {
        return binding.name
      }
    }

    const installedByPath = installedPlugins.find(
      (plugin) => typeof plugin.path === 'string' && path.resolve(plugin.path) === maybePath
    )
    if (installedByPath?.isDevelopment && typeof installedByPath.name === 'string') {
      return installedByPath.name
    }

    const installedByName = installedPlugins.find(
      (plugin) => plugin?.isDevelopment && plugin?.name === normalizedIdentity
    )
    if (installedByName?.name) {
      return installedByName.name
    }

    return null
  }

  private async readPluginConfigFromFile(configPath: string): Promise<any> {
    const content = await fs.readFile(configPath, 'utf-8')
    return JSON.parse(content)
  }

  /**
   * 按需刷新某个开发项目在当前设备上的绑定状态，并同步回主记录快照。
   */
  private async validateAndRefreshDevProjectState(
    projectName: string,
    state?: { registry: DevPluginRegistryDoc; localBindings: DevPluginLocalBindingsDoc }
  ): Promise<{
    success: boolean
    error?: string
    registry: DevPluginRegistryDoc
    localBindings: DevPluginLocalBindingsDoc
    binding?: DevProjectLocalBinding
    pluginConfig?: any
  }> {
    const currentState = state ?? (await this.readDevProjectState())
    const registryEntry = currentState.registry.projects[projectName]
    if (!registryEntry) {
      console.warn('[Plugins] 校验开发项目失败，项目不存在:', projectName)
      return {
        success: false,
        error: `开发项目 "${projectName}" 不存在`,
        registry: currentState.registry,
        localBindings: currentState.localBindings
      }
    }

    const now = this.nowIso()
    const currentBinding = currentState.localBindings.bindings[projectName]
    if (!currentBinding) {
      console.warn('[Plugins] 开发项目缺少当前设备绑定，标记为 unbound:', {
        projectName,
        deviceId: currentState.localBindings.deviceId
      })
      const unboundBinding: DevProjectLocalBinding = {
        name: projectName,
        projectPath: null,
        configPath: null,
        status: 'unbound',
        lastValidatedAt: now,
        updatedAt: now,
        lastError: '项目未绑定到当前设备路径'
      }
      const localBindings = {
        ...currentState.localBindings,
        updatedAt: now,
        bindings: {
          ...currentState.localBindings.bindings,
          [projectName]: unboundBinding
        }
      }
      this.writeDevProjectState(currentState.registry, localBindings)
      return {
        success: false,
        error: unboundBinding.lastError,
        registry: currentState.registry,
        localBindings,
        binding: unboundBinding
      }
    }

    const fallbackConfigPath =
      currentBinding.projectPath && currentBinding.projectPath.trim()
        ? path.join(currentBinding.projectPath, 'plugin.json')
        : ''
    const candidateConfigPaths = [currentBinding.configPath, fallbackConfigPath].filter(
      (item, index, list): item is string => !!item && list.indexOf(item) === index
    )

    console.log('[Plugins] 开始校验开发项目配置状态:', {
      projectName,
      candidateConfigPaths
    })

    let usedConfigPath = currentBinding.configPath
    let pluginConfig: any | null = null
    let validationStatus: DevProjectLocalBinding['status'] = 'config_missing'
    let lastError = 'plugin.json 文件不存在'

    for (const candidatePath of candidateConfigPaths) {
      try {
        const loadedConfig = await this.readPluginConfigFromFile(candidatePath)
        if (!loadedConfig?.name) {
          validationStatus = 'invalid_config'
          lastError = 'plugin.json 缺少 name 字段'
          usedConfigPath = candidatePath
          break
        }
        if (loadedConfig.name !== projectName) {
          validationStatus = 'invalid_config'
          lastError = `plugin.json name 与项目不一致（期望: ${projectName}，实际: ${loadedConfig.name}）`
          usedConfigPath = candidatePath
          break
        }
        if (isBundledInternalPlugin(loadedConfig.name)) {
          validationStatus = 'invalid_config'
          lastError = '内置插件不能作为开发项目'
          usedConfigPath = candidatePath
          break
        }
        validationStatus = 'ready'
        lastError = ''
        usedConfigPath = candidatePath
        pluginConfig = loadedConfig
        break
      } catch (error) {
        validationStatus = 'config_missing'
        lastError = error instanceof Error ? error.message : 'plugin.json 不可读取'
        usedConfigPath = candidatePath
      }
    }

    const nextBinding: DevProjectLocalBinding = {
      ...currentBinding,
      name: projectName,
      projectPath: usedConfigPath ? path.dirname(usedConfigPath) : currentBinding.projectPath,
      configPath: usedConfigPath,
      status: validationStatus,
      lastValidatedAt: now,
      updatedAt: now,
      ...(lastError ? { lastError } : {})
    }
    if (!lastError && 'lastError' in nextBinding) {
      delete nextBinding.lastError
    }

    const nextRegistryProjects = { ...currentState.registry.projects }
    if (pluginConfig) {
      nextRegistryProjects[projectName] = {
        ...registryEntry,
        configSnapshot: { ...pluginConfig },
        updatedAt: now
      }
    }

    const nextRegistry: DevPluginRegistryDoc = {
      ...currentState.registry,
      projects: nextRegistryProjects
    }
    const nextLocalBindings: DevPluginLocalBindingsDoc = {
      ...currentState.localBindings,
      updatedAt: now,
      bindings: {
        ...currentState.localBindings.bindings,
        [projectName]: nextBinding
      }
    }

    this.writeDevProjectState(nextRegistry, nextLocalBindings)
    console.log('[Plugins] 开发项目配置状态已刷新:', {
      projectName,
      status: validationStatus,
      configPath: nextBinding.configPath,
      hasSnapshotUpdate: !!pluginConfig
    })
    return {
      success: validationStatus === 'ready',
      ...(validationStatus === 'ready' ? {} : { error: lastError }),
      registry: nextRegistry,
      localBindings: nextLocalBindings,
      binding: nextBinding,
      ...(pluginConfig ? { pluginConfig } : {})
    }
  }

  /**
   * 删除开发版插件变体时，同时清理与该变体关联的历史、固定、自启动等持久化数据。
   */
  private removePluginUsageData(pluginName: string, pluginSource: PluginSource): void {
    const history: { pluginName: string }[] = databaseAPI.dbGet('command-history') || []
    const newHistory = history.filter(
      (item: any) =>
        !isSamePluginVariantRef(
          {
            pluginName: item?.pluginName,
            source: item?.pluginSource
          },
          {
            pluginName,
            source: pluginSource
          }
        )
    )
    if (newHistory.length !== history.length) {
      databaseAPI.dbPut('command-history', newHistory)
      this.mainWindow?.webContents.send('history-changed')
    }

    const pinned: { pluginName: string }[] = databaseAPI.dbGet('pinned-commands') || []
    const newPinned = pinned.filter(
      (item: any) =>
        !isSamePluginVariantRef(
          {
            pluginName: item?.pluginName,
            source: item?.pluginSource
          },
          {
            pluginName,
            source: pluginSource
          }
        )
    )
    if (newPinned.length !== pinned.length) {
      databaseAPI.dbPut('pinned-commands', newPinned)
      this.mainWindow?.webContents.send('pinned-changed')
    }

    const autoStartPlugins = databaseAPI.dbGet('autoStartPlugin') || []
    const nextAutoStartPlugins = removePluginVariantRef(autoStartPlugins, {
      pluginName,
      source: pluginSource
    })
    if (nextAutoStartPlugins.length !== autoStartPlugins.length) {
      databaseAPI.dbPut('autoStartPlugin', nextAutoStartPlugins)
    }

    const outKillPlugins = databaseAPI.dbGet('outKillPlugin') || []
    const nextOutKillPlugins = removePluginVariantRef(outKillPlugins, {
      pluginName,
      source: pluginSource
    })
    if (nextOutKillPlugins.length !== outKillPlugins.length) {
      databaseAPI.dbPut('outKillPlugin', nextOutKillPlugins)
    }

    const autoDetachPlugins = databaseAPI.dbGet('autoDetachPlugin') || []
    const nextAutoDetachPlugins = removePluginVariantRef(autoDetachPlugins, {
      pluginName,
      source: pluginSource
    })
    if (nextAutoDetachPlugins.length !== autoDetachPlugins.length) {
      databaseAPI.dbPut('autoDetachPlugin', nextAutoDetachPlugins)
    }
  }

  public async getDevProjects(): Promise<any[]> {
    try {
      const { registry, localBindings } = await this.readDevProjectState()
      const installedPlugins = this.readInstalledPlugins()
      const runningPluginPaths = this.getRunningPlugins()
      const runningSet = new Set(runningPluginPaths.map((item) => path.resolve(item)))
      const devInstalledByName = new Map<string, any>()
      for (const plugin of installedPlugins) {
        if (plugin?.isDevelopment && typeof plugin?.name === 'string') {
          devInstalledByName.set(plugin.name, plugin)
        }
      }

      const projects: any[] = []
      const orderedProjects = Object.entries(registry.projects).sort(
        ([, projectA], [, projectB]) => projectA.sortOrder - projectB.sortOrder
      )
      for (const [name, project] of orderedProjects) {
        const localBinding = localBindings.bindings[name]
        const localPath = localBinding?.projectPath ? path.resolve(localBinding.projectPath) : null
        const installedDevPlugin = devInstalledByName.get(name)
        const installedPath =
          typeof installedDevPlugin?.path === 'string'
            ? path.resolve(installedDevPlugin.path)
            : null
        const projectPath = localPath || null

        projects.push({
          name,
          title: project.configSnapshot.title,
          version: project.configSnapshot.version,
          description: project.configSnapshot.description || '',
          author: project.configSnapshot.author || '',
          homepage: project.configSnapshot.homepage || '',
          logo: projectPath
            ? this.resolvePluginLogo(projectPath, project.configSnapshot.logo)
            : project.configSnapshot.logo || '',
          preload: project.configSnapshot.preload,
          features: Array.isArray(project.configSnapshot.features)
            ? project.configSnapshot.features
            : [],
          developmentMain: project.configSnapshot.development?.main,
          path: projectPath,
          configPath: localBinding?.configPath || null,
          localStatus: localBinding?.status || 'unbound',
          lastValidatedAt: localBinding?.lastValidatedAt || null,
          lastError: localBinding?.lastError || null,
          isDevModeInstalled: !!installedDevPlugin,
          isRunning: !!(
            (projectPath && runningSet.has(projectPath)) ||
            (installedPath && runningSet.has(installedPath))
          ),
          addedAt: project.addedAt,
          sortOrder: project.sortOrder
        })
      }

      return projects
    } catch (error) {
      console.error('[Plugins] 获取开发项目列表失败:', error)
      return []
    }
  }

  private async updateDevProjectsOrder(pluginNames: string[]): Promise<any> {
    try {
      const state = await this.readDevProjectState()
      const nextRegistry = applyDevProjectsOrderUpdate(state.registry, pluginNames)
      this.writeDevProjectState(nextRegistry, state.localBindings)
      this.notifyPluginsChanged()
      return { success: true }
    } catch (error) {
      console.error('[Plugins] 更新开发项目顺序失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '更新顺序失败' }
    }
  }

  /**
   * 验证插件配置
   * @param pluginConfig 插件配置对象
   * @param existingPlugins 已存在的插件列表
   * @returns 验证结果 { valid: boolean, error?: string }
   */
  private validatePluginConfig(
    pluginConfig: any,
    existingPlugins: any[]
  ): { valid: boolean; error?: string } {
    // 检查 title 是否冲突（如果有 title 字段）
    if (pluginConfig.title) {
      const titleConflict = existingPlugins.find((p: any) => p.title === pluginConfig.title)
      if (titleConflict) {
        return {
          valid: false,
          error: `插件标题 "${pluginConfig.title}" 已被插件 "${titleConflict.name}" 使用，请使用不同的标题`
        }
      }
    }

    // 校验必填字段
    const requiredFields = ['name', 'version']
    for (const field of requiredFields) {
      if (!pluginConfig[field]) {
        return { valid: false, error: `缺少必填字段: ${field}` }
      }
    }

    // 检查插件是否声明了 features 或 tools（至少需要一个）
    const hasFeatures = Array.isArray(pluginConfig.features) && pluginConfig.features.length > 0
    const hasTools =
      pluginConfig.tools &&
      typeof pluginConfig.tools === 'object' &&
      !Array.isArray(pluginConfig.tools) &&
      Object.keys(pluginConfig.tools).length > 0

    // features 和 tools 不能同时为空
    if (!hasFeatures && !hasTools) {
      return { valid: false, error: 'features 和 tools 不能同时为空' }
    }

    // 校验 features 字段（传统插件功能）
    if (hasFeatures) {
      for (const feature of pluginConfig.features) {
        if (!feature.code || !Array.isArray(feature.cmds)) {
          return { valid: false, error: 'feature 缺少必填字段 (code, cmds)' }
        }
      }
    }

    // 校验 tools 字段（MCP 工具声明）
    if (hasTools) {
      for (const [toolName, tool] of Object.entries(pluginConfig.tools)) {
        // 工具名必须使用小写 snake_case 命名（符合 MCP 规范）
        if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
          return { valid: false, error: `tools.${toolName} 必须使用小写 snake_case 命名` }
        }
        if (!tool || typeof tool !== 'object') {
          return { valid: false, error: `tools.${toolName} 配置无效` }
        }
        // 必须提供工具描述
        if (typeof (tool as any).description !== 'string' || !(tool as any).description.trim()) {
          return { valid: false, error: `tools.${toolName}.description 必须是非空字符串` }
        }
        // 必须提供 JSON Schema 格式的输入参数定义
        if (
          !(tool as any).inputSchema ||
          typeof (tool as any).inputSchema !== 'object' ||
          Array.isArray((tool as any).inputSchema)
        ) {
          return { valid: false, error: `tools.${toolName}.inputSchema 必须是对象` }
        }
      }
    }

    // 无界面插件（仅声明 tools，没有 main）的额外校验
    if (!pluginConfig.main && hasTools) {
      if (!pluginConfig.preload) {
        return { valid: false, error: '声明 tools 的插件必须提供 preload' }
      }
      if (!pluginConfig.logo) {
        return { valid: false, error: '声明 tools 的插件必须提供 logo' }
      }
    }

    return { valid: true }
  }

  private resolvePluginLogo(pluginPath: string, logo: unknown): string {
    if (typeof logo !== 'string' || !logo) return ''
    if (/^(https?:|file:)/.test(logo)) return logo
    return pathToFileURL(path.join(pluginPath, logo)).href
  }

  /**
   * 选择插件文件（不安装，仅返回文件路径）
   * 用于导入本地插件时先预览再安装
   * 注意：此方法通过 internal:select-plugin-file 调用
   */
  public async selectPluginFile(): Promise<any> {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow!, {
        title: '选择插件文件',
        filters: [{ name: '插件文件', extensions: ['zpx'] }],
        properties: ['openFile']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: '未选择文件' }
      }

      return { success: true, filePath: result.filePaths[0] }
    } catch (error: unknown) {
      console.error('[Plugins] 选择插件文件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 导入 ZPX 插件（保留用于兼容性，直接安装不预览）
  private async importPlugin(): Promise<any> {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow!, {
        title: '选择插件文件',
        filters: [{ name: '插件文件', extensions: ['zpx'] }],
        properties: ['openFile']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: '未选择文件' }
      }

      const zpxPath = result.filePaths[0]
      return await this._installPluginFromZpx(zpxPath)
    } catch (error: unknown) {
      console.error('[Plugins] 导入插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 从 ZPX 安装插件（核心逻辑）
   * 流程：读取 .zpx 中的 plugin.json → 校验 → 解压到插件目录 → 保存数据库
   * @param zpxPath .zpx 文件路径
   */
  private async _installPluginFromZpx(zpxPath: string): Promise<any> {
    await fs.mkdir(PLUGIN_DIR, { recursive: true })

    try {
      // 从 ZPX 中读取 plugin.json（不解压整个包）
      let pluginJsonContent: string
      try {
        pluginJsonContent = await readTextFromZpx(zpxPath, 'plugin.json')
      } catch {
        return { success: false, error: 'plugin.json 文件不存在' }
      }

      if (!pluginJsonContent) {
        return { success: false, error: 'plugin.json 文件不存在' }
      }

      // 解析配置
      let pluginConfig: any
      try {
        pluginConfig = JSON.parse(pluginJsonContent)
      } catch {
        return { success: false, error: 'plugin.json 格式错误' }
      }

      // 校验必填字段
      if (!pluginConfig.name) {
        return { success: false, error: 'plugin.json 缺少 name 字段' }
      }

      const pluginName = pluginConfig.name
      const pluginPath = path.join(PLUGIN_DIR, pluginName)

      // 检查目录是否已存在
      try {
        await fs.access(pluginPath)
        return { success: false, error: '插件目录已存在' }
      } catch {
        // 不存在，继续
      }

      // 检查插件是否已存在
      const existingPlugins = await this.getPlugins()
      if (existingPlugins.some((p: any) => p.name === pluginName)) {
        return { success: false, error: '插件已存在' }
      }

      // 验证插件配置
      const validation = this.validatePluginConfig(pluginConfig, existingPlugins)
      if (!validation.valid) {
        return { success: false, error: validation.error }
      }

      // 校验通过，解压 ZPX 到目标目录
      await extractZpx(zpxPath, pluginPath)

      // 保存到数据库
      const pluginInfo = {
        name: pluginConfig.name,
        title: pluginConfig.title,
        version: pluginConfig.version,
        description: pluginConfig.description || '',
        author: pluginConfig.author || '',
        homepage: pluginConfig.homepage || '',
        logo: pluginConfig.logo ? pathToFileURL(path.join(pluginPath, pluginConfig.logo)).href : '',
        main: pluginConfig.main,
        preload: pluginConfig.preload,
        features: pluginConfig.features,
        path: pluginPath,
        isDevelopment: false,
        installedAt: new Date().toISOString()
      }

      let plugins: any = databaseAPI.dbGet('plugins')
      if (!plugins) plugins = []
      plugins.push(pluginInfo)
      databaseAPI.dbPut('plugins', plugins)

      // 输出新增的指令
      console.log('[Plugins] \n=== 新增插件指令 ===')
      console.log(`插件名称: ${pluginConfig.name}`)
      console.log(`插件版本: ${pluginConfig.version}`)
      console.log('[Plugins] 新增指令列表:')
      pluginConfig.features.forEach((feature: any, index: number) => {
        console.log(`  [${index + 1}] ${feature.code} - ${feature.explain || '无说明'}`)

        // 格式化 cmds（区分字符串和对象）
        const formattedCmds = feature.cmds
          .map((cmd: any) => {
            if (typeof cmd === 'string') {
              return cmd
            } else if (typeof cmd === 'object' && cmd !== null) {
              // 对象类型的匹配指令
              const type = cmd.type || 'unknown'
              const label = cmd.label || type
              return `[${type}] ${label}`
            }
            return String(cmd)
          })
          .join(', ')

        console.log(`      关键词: ${formattedCmds}`)
      })
      console.log('[Plugins] ==================\n')

      this.mainWindow?.webContents.send('plugins-changed')
      return { success: true, plugin: pluginInfo }
    } catch (error: unknown) {
      console.error('[Plugins] 安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }

  /**
   * 从 ZIP 安装插件（兼容旧格式）
   * 用于市场下载的旧 ZIP 格式插件，过渡期结束后移除
   * @param zipPath .zip 文件路径
   */
  private async _installPluginFromZip(zipPath: string): Promise<any> {
    await fs.mkdir(PLUGIN_DIR, { recursive: true })

    try {
      const zip = new AdmZip(zipPath)
      const pluginJsonEntry = zip.readAsText('plugin.json')
      if (!pluginJsonEntry) {
        return { success: false, error: 'plugin.json 文件不存在' }
      }

      let pluginConfig: any
      try {
        pluginConfig = JSON.parse(pluginJsonEntry)
      } catch {
        return { success: false, error: 'plugin.json 格式错误' }
      }

      if (!pluginConfig.name) {
        return { success: false, error: 'plugin.json 缺少 name 字段' }
      }

      const pluginName = pluginConfig.name
      const pluginPath = path.join(PLUGIN_DIR, pluginName)

      try {
        await fs.access(pluginPath)
        return { success: false, error: '插件目录已存在' }
      } catch {
        // 不存在，继续
      }

      const existingPlugins = await this.getPlugins()
      const validation = this.validatePluginConfig(pluginConfig, existingPlugins)
      if (!validation.valid) {
        return { success: false, error: validation.error }
      }

      // ZIP 解压到目标目录
      zip.extractAllTo(pluginPath, true)

      const pluginInfo = {
        name: pluginConfig.name,
        title: pluginConfig.title,
        version: pluginConfig.version,
        description: pluginConfig.description || '',
        author: pluginConfig.author || '',
        homepage: pluginConfig.homepage || '',
        logo: pluginConfig.logo ? pathToFileURL(path.join(pluginPath, pluginConfig.logo)).href : '',
        main: pluginConfig.main,
        preload: pluginConfig.preload,
        features: pluginConfig.features,
        path: pluginPath,
        isDevelopment: false,
        installedAt: new Date().toISOString()
      }

      let plugins: any = databaseAPI.dbGet('plugins')
      if (!plugins) plugins = []
      plugins.push(pluginInfo)
      databaseAPI.dbPut('plugins', plugins)

      console.log('[Plugins] ZIP 兼容安装完成:', pluginName)
      this.mainWindow?.webContents.send('plugins-changed')
      return { success: true, plugin: pluginInfo }
    } catch (error: unknown) {
      console.error('[Plugins] ZIP 兼容安装失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }

  /**
   * 从 ZPX 文件中读取插件信息（不安装）
   * 用于安装前预览插件详情
   * @param zpxPath .zpx 文件路径
   */
  public async readPluginInfoFromZpx(zpxPath: string): Promise<any> {
    try {
      // 从 ZPX 中读取 plugin.json
      let pluginJsonContent: string
      try {
        pluginJsonContent = await readTextFromZpx(zpxPath, 'plugin.json')
      } catch {
        return { success: false, error: '无效的插件文件：缺少 plugin.json' }
      }

      let pluginConfig: any
      try {
        pluginConfig = JSON.parse(pluginJsonContent)
      } catch {
        return { success: false, error: '无效的插件文件：plugin.json 格式错误' }
      }

      if (!pluginConfig.name) {
        return { success: false, error: '无效的插件文件：缺少 name 字段' }
      }

      // 尝试从 ZPX 中提取 logo 为 base64
      let logoBase64 = ''
      if (pluginConfig.logo) {
        try {
          const logoBuffer = await readFileFromZpx(zpxPath, pluginConfig.logo)
          const ext = path.extname(pluginConfig.logo).toLowerCase().replace('.', '')
          const mimeType =
            ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : `image/${ext}`
          logoBase64 = `data:${mimeType};base64,${logoBuffer.toString('base64')}`
        } catch (error) {
          console.warn('[Plugins] 提取插件 logo 失败:', error)
        }
      }

      // 检查插件是否已安装
      const existingPlugins = await this.getPlugins()
      const isInstalled = existingPlugins.some((p: any) => p.name === pluginConfig.name)

      return {
        success: true,
        pluginInfo: {
          name: pluginConfig.name,
          title: pluginConfig.title || pluginConfig.name,
          version: pluginConfig.version || '未知',
          description: pluginConfig.description || '',
          author: pluginConfig.author || '未知',
          logo: logoBase64,
          features: pluginConfig.features || [],
          isInstalled
        }
      }
    } catch (error: unknown) {
      console.error('[Plugins] 读取插件信息失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '读取失败' }
    }
  }

  /**
   * 从指定文件路径安装插件（.zpx），支持覆盖已存在的插件
   * @param zpxPath .zpx 文件路径
   */
  public async installPluginFromPath(zpxPath: string): Promise<any> {
    try {
      // 从 ZPX 中读取 plugin.json 获取插件名称
      let pluginJsonContent: string
      try {
        pluginJsonContent = await readTextFromZpx(zpxPath, 'plugin.json')
      } catch {
        return { success: false, error: 'plugin.json 文件不存在' }
      }

      let pluginConfig: any
      try {
        pluginConfig = JSON.parse(pluginJsonContent)
      } catch {
        return { success: false, error: 'plugin.json 格式错误' }
      }

      if (!pluginConfig.name) {
        return { success: false, error: 'plugin.json 缺少 name 字段' }
      }

      const pluginName = pluginConfig.name
      const pluginPath = path.join(PLUGIN_DIR, pluginName)

      // 检查是否已存在，如果存在则先删除旧版本（覆盖安装）
      const existingPlugins: any[] = databaseAPI.dbGet('plugins') || []
      const existingIndex = existingPlugins.findIndex((p: any) => p.name === pluginName)

      if (existingIndex !== -1) {
        console.log('[Plugins] 插件已存在，执行覆盖安装:', pluginName)

        // 终止正在运行的插件
        try {
          await this.pluginManager?.killPluginByName?.(pluginName)
        } catch {
          // 忽略终止错误
        }

        // 从数据库中移除旧记录
        existingPlugins.splice(existingIndex, 1)
        databaseAPI.dbPut('plugins', existingPlugins)

        // 删除旧目录
        try {
          await fs.rm(pluginPath, { recursive: true, force: true })
          console.log('[Plugins] 已删除旧插件目录:', pluginPath)
        } catch {
          // 忽略删除错误
        }
      }

      // 执行安装
      return await this._installPluginFromZpx(zpxPath)
    } catch (error: unknown) {
      console.error('[Plugins] 覆盖安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }

  /**
   * 导入开发项目，只登记主记录与当前设备绑定，不会自动进入搜索结果。
   */
  private async importDevPlugin(pluginJsonPath?: string): Promise<any> {
    try {
      console.log('[Plugins] 开始导入开发项目:', pluginJsonPath || '通过选择器选择')
      // 如果没有传入路径，通过对话框选择
      if (!pluginJsonPath) {
        const result = await dialog.showOpenDialog(this.mainWindow!, {
          title: '选择插件配置文件',
          properties: ['openFile'],
          filters: [{ name: '插件配置', extensions: ['json'] }],
          message: '请选择 plugin.json 文件'
        })

        if (result.canceled || result.filePaths.length === 0) {
          console.log('[Plugins] 导入开发项目已取消')
          return { success: false, error: '未选择文件' }
        }

        pluginJsonPath = result.filePaths[0]
      }

      // 检查文件名是否为 plugin.json
      if (path.basename(pluginJsonPath) !== 'plugin.json') {
        return { success: false, error: '请选择 plugin.json 文件' }
      }

      // 获取插件文件夹路径（plugin.json 所在的目录）
      const pluginPath = path.resolve(path.dirname(pluginJsonPath))
      let pluginConfig: any
      try {
        pluginConfig = await this.readPluginConfigFromFile(pluginJsonPath)
      } catch {
        return { success: false, error: 'plugin.json 格式错误' }
      }

      if (!pluginConfig.name) {
        return { success: false, error: 'plugin.json 缺少 name 字段' }
      }

      if (isBundledInternalPlugin(pluginConfig.name)) {
        return { success: false, error: '内置插件不能作为开发项目导入' }
      }

      const existingPlugins = this.readInstalledPlugins()
      const validation = this.validatePluginConfig(
        pluginConfig,
        existingPlugins.filter((plugin) => plugin?.name !== pluginConfig.name)
      )
      if (!validation.valid) {
        return { success: false, error: validation.error }
      }

      const state = await this.readDevProjectState()
      const projectName = pluginConfig.name
      const hasExistingProject = Boolean(projectName && state.registry.projects[projectName])
      const upserted = upsertDevProjectFromConfig({
        registry: state.registry,
        localBindings: state.localBindings,
        pluginPath,
        pluginConfig
      })
      if (!upserted.success) {
        return { success: false, error: upserted.reason || '开发项目登记失败' }
      }
      const nextRegistry =
        !hasExistingProject && projectName
          ? insertDevProjectAtTop(upserted.registry, projectName)
          : upserted.registry
      this.writeDevProjectState(nextRegistry, upserted.localBindings)

      // 输出新增的开发项目信息
      console.log('[Plugins] \n=== 新增开发项目 ===')
      console.log(`插件名称: ${pluginConfig.name}`)
      console.log(`插件版本: ${pluginConfig.version}`)
      console.log(`工程目录: ${pluginPath}`)
      console.log(`开发模式入口: ${pluginConfig.development?.main || '无'}`)
      console.log('[Plugins] =========================\n')
      console.log('[Plugins] 开发项目已登记:', {
        pluginName: pluginConfig.name,
        projectPath: pluginPath,
        configPath: pluginJsonPath
      })

      this.notifyPluginsChanged()
      return {
        success: true,
        pluginName: pluginConfig.name,
        pluginPath
      }
    } catch (error: unknown) {
      console.error('[Plugins] 添加开发中插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 删除插件
  private async deletePlugin(pluginPath: string): Promise<any> {
    try {
      const plugins: any = databaseAPI.dbGet('plugins')
      if (!plugins || !Array.isArray(plugins)) {
        return { success: false, error: '插件列表不存在' }
      }

      const pluginIndex = plugins.findIndex((p: any) => p.path === pluginPath)
      if (pluginIndex === -1) {
        return { success: false, error: '插件不存在' }
      }

      const pluginInfo = plugins[pluginIndex]

      // ✅ 检查是否为内置插件
      if (isBundledInternalPlugin(pluginInfo.name)) {
        return {
          success: false,
          error: '内置插件不能卸载'
        }
      }

      plugins.splice(pluginIndex, 1)
      databaseAPI.dbPut('plugins', plugins)

      this.removePluginUsageData(
        pluginInfo.name,
        pluginInfo.isDevelopment ? 'development' : 'installed'
      )

      await databaseAPI.clearPluginData({
        pluginName: pluginInfo.name,
        source: getPluginSource(pluginInfo.isDevelopment)
      })

      this.notifyPluginsChanged()

      if (!pluginInfo.isDevelopment) {
        try {
          await fs.rm(pluginPath, { recursive: true, force: true })
          console.log('[Plugins] 已删除插件目录:', pluginPath)
        } catch (error) {
          console.error('[Plugins] 删除插件目录失败:', error)
        }
      } else {
        console.log('[Plugins] 开发中插件，保留目录:', pluginPath)
      }

      return { success: true }
    } catch (error: unknown) {
      console.error('[Plugins] 删除插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 重载插件
  private async reloadPlugin(pluginPath: string): Promise<any> {
    try {
      const plugins = this.readInstalledPlugins()
      if (!Array.isArray(plugins)) {
        return { success: false, error: '插件列表不存在' }
      }

      const normalizedPluginPath = path.resolve(pluginPath)
      const pluginIndex = plugins.findIndex(
        (plugin) =>
          typeof plugin.path === 'string' && path.resolve(plugin.path) === normalizedPluginPath
      )
      if (pluginIndex === -1) {
        const state = await this.readDevProjectState()
        const projectName = this.resolveDevProjectName(
          pluginPath,
          state.registry,
          state.localBindings
        )
        if (!projectName) {
          return { success: false, error: '插件不存在' }
        }
        return this.reloadDevProject(projectName)
      }

      const oldPlugin = plugins[pluginIndex]
      const pluginJsonPath = path.join(normalizedPluginPath, 'plugin.json')

      try {
        await fs.access(pluginJsonPath)
      } catch (error) {
        console.log('[Plugins] 文件不存在', error)
        return { success: false, error: 'plugin.json 文件不存在' }
      }

      const pluginConfig = await this.readPluginConfigFromFile(pluginJsonPath)

      plugins[pluginIndex] = {
        ...oldPlugin,
        title: pluginConfig.title || oldPlugin.title,
        name: pluginConfig.name || oldPlugin.name,
        version: pluginConfig.version || oldPlugin.version,
        description: pluginConfig.description || oldPlugin.description,
        author: pluginConfig.author ?? oldPlugin.author,
        homepage: pluginConfig.homepage ?? oldPlugin.homepage,
        logo: pluginConfig.logo
          ? pathToFileURL(path.join(normalizedPluginPath, pluginConfig.logo)).href
          : oldPlugin.logo,
        features: pluginConfig.features || oldPlugin.features,
        main:
          oldPlugin.isDevelopment && pluginConfig.development?.main
            ? pluginConfig.development.main
            : pluginConfig.main || oldPlugin.main
      }

      this.writeInstalledPlugins(plugins)
      this.notifyPluginsChanged()
      console.log('[Plugins] 插件重载成功:', normalizedPluginPath)
      return { success: true }
    } catch (error: unknown) {
      console.error('[Plugins] 重载插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 获取运行中的插件
  private getRunningPlugins(): string[] {
    if (this.pluginManager) {
      return this.pluginManager.getRunningPlugins()
    }
    return []
  }

  /**
   * 供开发者工具详情页按需校验当前项目的本地绑定状态。
   */
  private async validateDevProject(projectName: string): Promise<any> {
    try {
      console.log('[Plugins] 请求校验开发项目:', projectName)
      const state = await this.readDevProjectState()
      const normalizedProjectName = this.resolveDevProjectName(
        projectName,
        state.registry,
        state.localBindings
      )
      if (!normalizedProjectName) {
        return { success: false, error: '开发项目不存在' }
      }

      const validated = await this.validateAndRefreshDevProjectState(normalizedProjectName, state)
      if (!validated.success) {
        console.warn('[Plugins] 开发项目校验未通过:', {
          projectName: normalizedProjectName,
          error: validated.error
        })
        return { success: false, error: validated.error || '开发项目校验失败' }
      }
      console.log('[Plugins] 开发项目校验通过:', {
        projectName: normalizedProjectName,
        status: validated.binding?.status
      })
      return {
        success: true,
        pluginName: normalizedProjectName,
        binding: validated.binding
      }
    } catch (error: unknown) {
      console.error('[Plugins] 校验开发项目失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 从开发项目列表中移除指定项目，但保留磁盘工程目录。
   */
  private async removeDevProject(projectNameOrPath: string): Promise<any> {
    try {
      console.log('[Plugins] 请求删除开发项目:', projectNameOrPath)
      const state = await this.readDevProjectState()
      const normalizedProjectName = this.resolveDevProjectName(
        projectNameOrPath,
        state.registry,
        state.localBindings,
        this.readInstalledPlugins()
      )
      if (!normalizedProjectName) {
        return { success: false, error: '开发项目不存在' }
      }

      const { [normalizedProjectName]: _removedProject, ...nextRegistryProjects } =
        state.registry.projects
      const { [normalizedProjectName]: _removedBinding, ...nextBindings } =
        state.localBindings.bindings

      this.writeDevProjectState(
        {
          ...state.registry,
          projects: nextRegistryProjects
        },
        {
          ...state.localBindings,
          updatedAt: this.nowIso(),
          bindings: nextBindings
        }
      )
      this.removePluginUsageData(normalizedProjectName, 'development')
      this.notifyPluginsChanged()
      console.log('[Plugins] 开发项目删除完成:', normalizedProjectName)
      return { success: true, pluginName: normalizedProjectName }
    } catch (error: unknown) {
      console.error('[Plugins] 删除开发项目失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 将开发项目显式安装为开发模式插件。
   */
  private async installDevPlugin(projectNameOrPath: string): Promise<any> {
    try {
      console.log('[Plugins] 请求安装开发模式:', projectNameOrPath)
      const state = await this.readDevProjectState()
      const projectName = this.resolveDevProjectName(
        projectNameOrPath,
        state.registry,
        state.localBindings,
        this.readInstalledPlugins()
      )
      if (!projectName) {
        return { success: false, error: '开发项目不存在' }
      }

      const validated = await this.validateAndRefreshDevProjectState(projectName, state)
      if (!validated.success || !validated.binding || !validated.pluginConfig) {
        return { success: false, error: validated.error || '开发项目校验失败' }
      }

      const pluginConfig = validated.pluginConfig
      if (!pluginConfig?.development?.main) {
        return { success: false, error: 'plugin.json 缺少 development.main 字段' }
      }
      if (!validated.binding.projectPath) {
        return { success: false, error: '开发项目未绑定有效路径' }
      }

      const plugins = this.readInstalledPlugins()
      const validation = this.validatePluginConfig(
        pluginConfig,
        plugins.filter((plugin) => plugin?.name !== projectName)
      )
      if (!validation.valid) {
        return { success: false, error: validation.error }
      }

      const projectPath = path.resolve(validated.binding.projectPath)
      const installedPlugin = buildInstalledDevelopmentPlugin(projectPath, pluginConfig)
      installedPlugin.logo = this.resolvePluginLogo(projectPath, pluginConfig.logo)
      const existingIndex = plugins.findIndex(
        (plugin) => plugin?.isDevelopment && plugin?.name === projectName
      )
      if (existingIndex >= 0) {
        plugins[existingIndex] = installedPlugin
      } else {
        plugins.push(installedPlugin)
      }

      this.writeInstalledPlugins(plugins)
      this.notifyPluginsChanged()
      console.log('[Plugins] 开发模式安装完成:', {
        projectName,
        projectPath,
        developmentMain: pluginConfig.development.main
      })
      return { success: true, pluginName: projectName }
    } catch (error: unknown) {
      console.error('[Plugins] 安装开发模式失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 将开发项目从开发模式中卸载，但保留开发项目登记与工程目录。
   */
  private async uninstallDevPlugin(projectNameOrPath: string): Promise<any> {
    try {
      console.log('[Plugins] 请求卸载开发模式:', projectNameOrPath)
      const state = await this.readDevProjectState()
      const plugins = this.readInstalledPlugins()
      const projectName = this.resolveDevProjectName(
        projectNameOrPath,
        state.registry,
        state.localBindings,
        plugins
      )
      if (!projectName) {
        return { success: true }
      }

      const pluginInfo = plugins.find(
        (plugin) => plugin?.isDevelopment && plugin?.name === projectName
      )
      if (!pluginInfo?.isDevelopment) {
        return { success: true }
      }

      if (typeof pluginInfo.path === 'string' && pluginInfo.path) {
        this.pluginManager?.killPlugin(pluginInfo.path)
      }
      this.writeInstalledPlugins(
        plugins.filter((plugin) => !(plugin?.isDevelopment && plugin?.name === projectName))
      )
      this.removePluginUsageData(projectName, 'development')
      this.notifyPluginsChanged()
      console.log('[Plugins] 开发模式卸载完成:', projectName)
      return { success: true, pluginName: projectName }
    } catch (error: unknown) {
      console.error('[Plugins] 卸载开发模式失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 重新读取开发项目配置，并在已安装开发模式时同步刷新安装态快照。
   */
  private async reloadDevProject(projectName: string): Promise<any> {
    try {
      console.log('[Plugins] 请求重载开发项目:', projectName)
      const state = await this.readDevProjectState()
      const resolvedProjectName = this.resolveDevProjectName(
        projectName,
        state.registry,
        state.localBindings,
        this.readInstalledPlugins()
      )
      if (!resolvedProjectName) {
        return { success: false, error: '开发项目不存在' }
      }

      const validated = await this.validateAndRefreshDevProjectState(resolvedProjectName, state)
      if (!validated.success || !validated.binding || !validated.pluginConfig) {
        return { success: false, error: validated.error || '开发项目校验失败' }
      }
      if (!validated.binding.projectPath) {
        return { success: false, error: '开发项目未绑定有效路径' }
      }

      const plugins = this.readInstalledPlugins()
      const devInstalledIndex = plugins.findIndex(
        (plugin) => plugin?.isDevelopment && plugin?.name === resolvedProjectName
      )
      if (devInstalledIndex >= 0) {
        const oldPlugin = plugins[devInstalledIndex]
        const projectPath = path.resolve(validated.binding.projectPath)
        plugins[devInstalledIndex] = {
          ...oldPlugin,
          ...buildInstalledDevelopmentPlugin(projectPath, validated.pluginConfig),
          logo: this.resolvePluginLogo(projectPath, validated.pluginConfig.logo),
          installedAt: oldPlugin.installedAt || this.nowIso()
        }
        this.writeInstalledPlugins(plugins)
      }

      this.notifyPluginsChanged()
      console.log('[Plugins] 开发项目重载完成:', {
        projectName: resolvedProjectName,
        installedDevMode: devInstalledIndex >= 0
      })
      return { success: true, pluginName: resolvedProjectName }
    } catch (error: unknown) {
      console.error('[Plugins] 重载开发项目失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 为当前设备重新绑定 plugin.json，用于修复配置丢失、非法或未绑定状态。
   */
  private async selectDevProjectConfig(
    projectName: string,
    providedConfigPath?: string
  ): Promise<any> {
    try {
      console.log('[Plugins] 请求重新绑定开发项目配置:', projectName)
      const state = await this.readDevProjectState()
      const registryItem = state.registry.projects[projectName]
      if (!registryItem) {
        return { success: false, error: '开发项目不存在' }
      }

      let configPath = providedConfigPath ? path.resolve(providedConfigPath) : ''

      if (!configPath) {
        const result = await dialog.showOpenDialog(this.mainWindow!, {
          title: '选择 plugin.json',
          properties: ['openFile'],
          filters: [{ name: '插件配置', extensions: ['json'] }],
          message: `为 ${projectName} 选择 plugin.json`
        })
        if (result.canceled || result.filePaths.length === 0) {
          console.log('[Plugins] 重新绑定开发项目配置已取消:', projectName)
          return { success: false, error: '未选择文件' }
        }

        configPath = path.resolve(result.filePaths[0])
      }

      if (path.basename(configPath) !== 'plugin.json') {
        return { success: false, error: '请选择 plugin.json 文件' }
      }

      let selectedConfig: any
      try {
        selectedConfig = await this.readPluginConfigFromFile(configPath)
      } catch {
        return { success: false, error: 'plugin.json 格式错误' }
      }

      if (!validateRepairConfigSelection(registryItem, selectedConfig)) {
        return {
          success: false,
          error: `选择的 plugin.json 与项目 "${projectName}" identity 不匹配`
        }
      }

      const now = this.nowIso()
      const nextLocalBindings: DevPluginLocalBindingsDoc = {
        ...state.localBindings,
        updatedAt: now,
        bindings: {
          ...state.localBindings.bindings,
          [projectName]: {
            name: projectName,
            projectPath: path.dirname(configPath),
            configPath,
            status: 'ready',
            lastValidatedAt: now,
            updatedAt: now
          }
        }
      }
      const nextRegistry: DevPluginRegistryDoc = {
        ...state.registry,
        projects: {
          ...state.registry.projects,
          [projectName]: {
            ...registryItem,
            configSnapshot: { ...selectedConfig },
            updatedAt: now
          }
        }
      }

      this.writeDevProjectState(nextRegistry, nextLocalBindings)
      const validated = await this.validateAndRefreshDevProjectState(projectName, {
        registry: nextRegistry,
        localBindings: nextLocalBindings
      })
      if (!validated.success) {
        return { success: false, error: validated.error || '开发项目校验失败' }
      }

      this.notifyPluginsChanged()
      console.log('[Plugins] 开发项目配置已重新绑定:', {
        projectName,
        configPath
      })
      return { success: true, pluginName: projectName }
    } catch (error: unknown) {
      console.error('[Plugins] 重新选择开发项目配置失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 直接基于开发项目工程目录打包，不要求项目已经安装为开发模式。
   */
  private async packageDevProject(
    projectName: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[Plugins] 请求打包开发项目:', projectName)
      const state = await this.readDevProjectState()
      const resolvedProjectName = this.resolveDevProjectName(
        projectName,
        state.registry,
        state.localBindings,
        this.readInstalledPlugins()
      )
      if (!resolvedProjectName) {
        return { success: false, error: '开发项目不存在' }
      }

      const validated = await this.validateAndRefreshDevProjectState(resolvedProjectName, state)
      if (!validated.success || !validated.binding) {
        return { success: false, error: validated.error || '开发项目校验失败' }
      }
      if (!canPackageDevProject(validated.binding)) {
        return { success: false, error: '当前项目状态不可打包' }
      }
      if (!validated.binding.projectPath) {
        return { success: false, error: '开发项目未绑定有效路径' }
      }

      const projectPath = validated.binding.projectPath
      try {
        await fs.access(projectPath)
      } catch {
        return { success: false, error: '插件目录不存在' }
      }

      const version =
        validated.pluginConfig?.version ||
        state.registry.projects[resolvedProjectName]?.configSnapshot?.version ||
        '0.0.0'
      const defaultName = `${resolvedProjectName}-v${version}.zpx`
      const result = await dialog.showSaveDialog(this.mainWindow!, {
        title: '保存插件包',
        defaultPath: defaultName,
        filters: [{ name: '插件包', extensions: ['zpx'] }]
      })
      if (result.canceled || !result.filePath) {
        console.log('[Plugins] 开发项目打包已取消:', resolvedProjectName)
        return { success: false, error: '已取消' }
      }

      await packZpx(projectPath, result.filePath)
      shell.showItemInFolder(result.filePath)
      console.log('[Plugins] 开发项目打包完成:', {
        projectName: resolvedProjectName,
        outputPath: result.filePath
      })
      return { success: true }
    } catch (error: unknown) {
      console.error('[Plugins] 打包开发项目失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '打包失败' }
    }
  }

  // 终止插件
  private killPlugin(pluginPath: string): { success: boolean; error?: string } {
    try {
      console.log('[Plugins] 终止插件:', pluginPath)
      if (this.pluginManager) {
        const result = this.pluginManager.killPlugin(pluginPath)
        if (result) {
          return { success: true }
        } else {
          return { success: false, error: '插件未运行' }
        }
      }
      return { success: false, error: '功能不可用' }
    } catch (error: unknown) {
      console.error('[Plugins] 终止插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 终止插件并返回搜索页面
  private killPluginAndReturn(pluginPath: string): { success: boolean; error?: string } {
    try {
      console.log('[Plugins] 终止插件并返回搜索页面:', pluginPath)
      if (this.pluginManager) {
        const result = this.pluginManager.killPlugin(pluginPath)
        if (result) {
          windowManager.notifyBackToSearch()
          this.mainWindow?.webContents.focus()
          return { success: true }
        } else {
          return { success: false, error: '插件未运行' }
        }
      }
      return { success: false, error: '功能不可用' }
    } catch (error: unknown) {
      console.error('[Plugins] 终止插件并返回搜索页面失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 获取插件市场列表
  private async fetchPluginMarket(): Promise<PluginMarketResult> {
    const getCachedResult = (): PluginMarketResult | null => {
      const cachedData = databaseAPI.dbGet('plugin-market-data')
      if (!Array.isArray(cachedData)) {
        return null
      }

      const storefrontFingerprint = databaseAPI.dbGet(
        PLUGIN_MARKET_STOREFRONT_FINGERPRINT_CACHE_KEY
      )
      const cachedStorefront = databaseAPI.dbGet(PLUGIN_MARKET_STOREFRONT_CACHE_KEY)
      const currentFingerprint = this.getPluginMarketFingerprint(cachedData)
      const storefront =
        storefrontFingerprint === currentFingerprint && cachedStorefront
          ? cachedStorefront
          : undefined

      return {
        success: true,
        data: cachedData,
        ...(storefront ? { storefront } : {})
      }
    }

    try {
      // 读取设置，检查是否有自定义插件市场 URL
      const settings = databaseAPI.dbGet('settings-general')
      const defaultBaseUrl =
        'https://github.com/ZToolsCenter/ZTools-plugins/releases/latest/download'
      let baseUrl = defaultBaseUrl

      if (settings?.pluginMarketCustom && settings?.pluginMarketUrl) {
        baseUrl = settings.pluginMarketUrl.replace(/\/+$/, '') // 去除末尾斜杠
      }

      const pluginsJsonUrl = `${baseUrl}/plugins.json`
      const latestVersionUrl = `${baseUrl}/latest`
      const layoutUrl = `${baseUrl}/layout.yaml`
      const categoriesUrl = `${baseUrl}/categories.json`

      console.log('[Plugins] 从插件市场获取列表...', baseUrl)

      const timestamp = Date.now()

      let latestVersion = ''
      try {
        const versionResponse = await httpGet(`${latestVersionUrl}?t=${timestamp}`)
        latestVersion = versionResponse.data.trim()
        console.log(`发现最新插件列表版本: ${latestVersion}`)
      } catch (error) {
        console.warn('[Plugins] 获取版本号失败，将强制更新:', error)
      }

      const cachedVersion = databaseAPI.dbGet('plugin-market-version')
      if (cachedVersion === latestVersion && latestVersion) {
        const cachedResult = getCachedResult()
        if (cachedResult) {
          console.log('[Plugins] 使用本地缓存的插件市场列表')
          return cachedResult
        }
      }

      console.log('[Plugins] 下载新版本插件列表...')
      const response = await httpGet(`${pluginsJsonUrl}?t=${timestamp}`)
      const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
      const plugins = Array.isArray(json) ? json : []
      const pluginMarketFingerprint = this.getPluginMarketFingerprint(plugins)

      let storefront: PluginMarketStorefront | undefined
      try {
        const [layoutResponse, categoriesResponse] = await Promise.all([
          httpGet(`${layoutUrl}?t=${timestamp}`),
          httpGet(`${categoriesUrl}?t=${timestamp}`)
        ])

        const layoutRaw =
          typeof layoutResponse.data === 'string'
            ? layoutResponse.data
            : String(layoutResponse.data || '')
        const categories =
          typeof categoriesResponse.data === 'string'
            ? JSON.parse(categoriesResponse.data)
            : categoriesResponse.data || []

        storefront = this.buildPluginMarketStorefront(plugins, layoutRaw, categories)
      } catch (error) {
        console.warn('[Plugins] 获取或解析 storefront 数据失败，降级为平铺列表:', error)
      }

      databaseAPI.dbPut('plugin-market-version', latestVersion)
      databaseAPI.dbPut('plugin-market-data', plugins)
      if (storefront) {
        databaseAPI.dbPut(PLUGIN_MARKET_STOREFRONT_CACHE_KEY, storefront)
        databaseAPI.dbPut(PLUGIN_MARKET_STOREFRONT_FINGERPRINT_CACHE_KEY, pluginMarketFingerprint)
      } else {
        databaseAPI.dbPut(PLUGIN_MARKET_STOREFRONT_CACHE_KEY, null)
        databaseAPI.dbPut(PLUGIN_MARKET_STOREFRONT_FINGERPRINT_CACHE_KEY, null)
      }

      return { success: true, data: plugins, ...(storefront ? { storefront } : {}) }
    } catch (error: unknown) {
      console.error('[Plugins] 获取插件市场列表失败:', error)
      try {
        const cachedResult = getCachedResult()
        if (cachedResult) {
          console.log('[Plugins] 获取失败，降级使用本地缓存')
          return cachedResult
        }
      } catch {
        // ignore
      }
      return { success: false, error: error instanceof Error ? error.message : '获取失败' }
    }
  }

  private getPluginMarketFingerprint(plugins: PluginMarketPlugin[]): string {
    return plugins
      .map(
        (plugin) =>
          `${plugin?.name || ''}:${plugin?.version || ''}:${JSON.stringify(plugin?.platform || [])}`
      )
      .sort()
      .join('|')
  }

  private buildPluginMarketStorefront(
    plugins: PluginMarketPlugin[],
    layoutRaw: string,
    categoriesValue: unknown
  ): PluginMarketStorefront {
    const layoutParsed = yaml.parse(layoutRaw) as Record<string, unknown> | null
    const layoutSections = Array.isArray(layoutParsed?.layout)
      ? (layoutParsed!.layout as PluginMarketLayoutSectionConfig[])
      : []
    const categoriesList = Array.isArray(categoriesValue) ? categoriesValue : []

    // 按当前平台过滤插件
    const currentPlatform = process.platform
    const filteredPlugins = plugins.filter((plugin) => {
      if (!plugin?.platform || !Array.isArray(plugin.platform)) return true
      return plugin.platform.includes(currentPlatform)
    })

    const pluginMap = new Map<string, PluginMarketPlugin>()
    for (const plugin of filteredPlugins) {
      if (plugin?.name) {
        pluginMap.set(plugin.name, plugin)
      }
    }

    const categories: Record<string, PluginMarketStorefrontCategory> = {}
    for (const category of categoriesList as PluginMarketCategoryConfig[]) {
      if (!category?.key) {
        continue
      }
      const categoryPlugins = Array.isArray(category.list)
        ? category.list
            .map((pluginName) => pluginMap.get(pluginName))
            .filter((plugin): plugin is PluginMarketPlugin => !!plugin)
        : []

      categories[category.key] = {
        key: category.key,
        title: category.title || category.key,
        description: category.description,
        icon: category.icon,
        plugins: categoryPlugins
      }
    }

    // 解析 categoryLayouts：从 yaml 根级键提取 (default, 以及各 category key)
    const categoryLayouts: Record<string, PluginMarketCategoryLayoutSection[]> = {}
    if (layoutParsed) {
      for (const [key, value] of Object.entries(layoutParsed)) {
        if (key === 'layout') continue
        if (Array.isArray(value)) {
          categoryLayouts[key] = (value as PluginMarketCategoryLayoutSection[]).filter(
            (section) => section && typeof section.type === 'string'
          )
        }
      }
    }

    const usedPluginNames = new Set<string>()
    const sections: PluginMarketStorefrontSection[] = []
    let sectionIndex = 0

    const pushUniquePlugins = (pluginNames: string[]): PluginMarketPlugin[] => {
      const result: PluginMarketPlugin[] = []
      for (const pluginName of pluginNames) {
        const plugin = pluginMap.get(pluginName)
        if (!plugin || usedPluginNames.has(pluginName)) {
          continue
        }
        usedPluginNames.add(pluginName)
        result.push(plugin)
      }
      return result
    }

    for (const section of layoutSections) {
      const sectionKey = `${section.type || 'section'}-${sectionIndex++}`

      if (section.type === 'banner') {
        const items = Array.isArray(section.children)
          ? section.children.filter(
              (item): item is PluginMarketBannerItem =>
                typeof item?.image === 'string' && !!item.image
            )
          : []
        if (items.length > 0) {
          sections.push({
            type: 'banner',
            key: sectionKey,
            items,
            height: section.height
          })
        }
        continue
      }

      if (section.type === 'navigation') {
        const categoryKeys = Array.isArray(section.categories) ? section.categories : []
        const navCategories: Array<{
          key: string
          title: string
          description?: string
          icon?: string
          showDescription: boolean
          pluginCount: number
        }> = []

        for (const categoryKey of categoryKeys) {
          const category = categories[categoryKey]
          if (!category || category.plugins.length === 0) {
            continue
          }
          navCategories.push({
            key: category.key,
            title: category.title,
            description: category.description,
            icon: category.icon,
            showDescription: section.showDescription !== false,
            pluginCount: category.plugins.length
          })
        }

        if (navCategories.length > 0) {
          sections.push({
            type: 'navigation',
            key: sectionKey,
            title: section.title,
            categories: navCategories
          })
        }
        continue
      }

      if (section.type === 'fixed') {
        const pluginNames = Array.isArray(section.plugins) ? section.plugins : []
        const fixedPlugins = pushUniquePlugins(pluginNames)
        if (fixedPlugins.length > 0) {
          sections.push({
            type: 'fixed',
            key: sectionKey,
            title: section.title,
            plugins: fixedPlugins
          })
        }
        continue
      }

      if (section.type === 'random') {
        const count = typeof section.count === 'number' && section.count > 0 ? section.count : 0
        const availablePlugins = filteredPlugins.filter(
          (plugin) => plugin?.name && !usedPluginNames.has(plugin.name)
        )
        if (count > 0 && availablePlugins.length > 0) {
          const randomPlugins = shuffleArray(availablePlugins).slice(0, count)
          for (const plugin of randomPlugins) {
            usedPluginNames.add(plugin.name)
          }
          sections.push({
            type: 'random',
            key: sectionKey,
            title: section.title,
            plugins: randomPlugins
          })
        }
      }
    }
    return { sections, categories, categoryLayouts }
  }

  /**
   * 从市场安装插件
   * 流程：下载 .zpx 文件 → _installPluginFromZpx() → 清理临时文件
   */
  private async installPluginFromMarket(plugin: any): Promise<any> {
    try {
      console.log('[Plugins] 开始从市场安装插件:', plugin.name)
      const downloadUrl = plugin.downloadUrl
      if (!downloadUrl) {
        return { success: false, error: '无效的下载链接' }
      }

      console.log('[Plugins] 插件下载链接:', downloadUrl)

      const tempDir = path.join(app.getPath('temp'), 'ztools-plugin-download')
      await fs.mkdir(tempDir, { recursive: true })
      // 下载为 .zpx 后缀
      const tempFilePath = path.join(tempDir, `${plugin.name}-${Date.now()}.zpx`)

      let retryCount = 0
      const maxRetries = 3
      while (retryCount < maxRetries) {
        try {
          await downloadFile(downloadUrl, tempFilePath)
          break
        } catch (error) {
          retryCount++
          console.error(`下载失败，重试第 ${retryCount} 次:`, error)
          if (retryCount >= maxRetries) throw error
          await sleep(500)
        }
      }

      console.log('[Plugins] 插件下载完成:', tempFilePath)
      // 自动检测格式：ZPX（gzip）或 ZIP（旧格式兼容）
      const isZpx = await isValidZpx(tempFilePath)
      const result = isZpx
        ? await this._installPluginFromZpx(tempFilePath)
        : await this._installPluginFromZip(tempFilePath)
      console.log(`[Plugins] 市场插件格式: ${isZpx ? 'ZPX' : 'ZIP（兼容）'}`)

      try {
        await fs.unlink(tempFilePath)
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (e) {
        console.error('[Plugins] 清理下载临时文件失败:', e)
      }

      return result
    } catch (error: unknown) {
      console.error('[Plugins] 从市场安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }

  /**
   * 打包开发中插件为 ZPX 文件
   * 流程：插件目录 → packZpx() → .zpx 文件
   * @param pluginPath 插件目录路径
   */
  public async packagePlugin(pluginPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      const plugins = this.readInstalledPlugins()
      const normalizedPluginPath = path.resolve(pluginPath)
      const pluginInfo = plugins.find(
        (plugin) =>
          typeof plugin.path === 'string' && path.resolve(plugin.path) === normalizedPluginPath
      )
      if (pluginInfo) {
        if (!pluginInfo.isDevelopment) {
          return { success: false, error: '仅支持打包开发中的插件' }
        }
        return this.packageDevProject(pluginInfo.name)
      }

      const state = await this.readDevProjectState()
      const projectName = this.resolveDevProjectName(
        pluginPath,
        state.registry,
        state.localBindings,
        plugins
      )
      if (!projectName) {
        return { success: false, error: '插件不存在' }
      }
      return this.packageDevProject(projectName)
    } catch (error: unknown) {
      console.error('[Plugins] 打包插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '打包失败' }
    }
  }

  public async exportAllPlugins(): Promise<{
    success: boolean
    exportPath?: string
    count?: number
    error?: string
  }> {
    try {
      const plugins: any = databaseAPI.dbGet('plugins')
      if (!plugins || !Array.isArray(plugins)) {
        return { success: false, error: '插件列表不存在' }
      }

      const exportablePlugins = plugins.filter(
        (p: any) => !p.isDevelopment && !isBundledInternalPlugin(p.name)
      )

      if (exportablePlugins.length === 0) {
        return { success: false, error: '没有可导出的插件' }
      }

      const now = new Date()
      const pad = (n: number): string => String(n).padStart(2, '0')
      const timestamp =
        `${now.getFullYear()}` +
        `${pad(now.getMonth() + 1)}` +
        `${pad(now.getDate())}` +
        `${pad(now.getHours())}` +
        `${pad(now.getMinutes())}` +
        `${pad(now.getSeconds())}`

      const downloadsDir = app.getPath('downloads')
      const exportDir = path.join(downloadsDir, `ztools-plugins-${timestamp}`)

      await fs.mkdir(exportDir, { recursive: true })

      let successCount = 0
      for (const plugin of exportablePlugins) {
        const pluginPath: string = plugin.path
        const baseName: string = plugin.name || path.basename(pluginPath)
        const folderName: string = plugin.version ? `${baseName}-v${plugin.version}` : baseName
        const destPath = path.join(exportDir, folderName)
        try {
          await fs.cp(pluginPath, destPath, { recursive: true })
          successCount++
        } catch (err) {
          console.error(`[Plugins] 导出插件失败: ${folderName}`, err)
        }
      }

      shell.showItemInFolder(exportDir)

      console.log('[Plugins] 插件导出完成:', exportDir)
      return { success: true, exportPath: exportDir, count: successCount }
    } catch (error: unknown) {
      console.error('[Plugins] 导出所有插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '导出失败' }
    }
  }

  // 获取插件 README.md 内容
  private async getPluginReadme(
    pluginPathOrName: string,
    pluginName?: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      // 如果 pluginPathOrName 是一个路径（包含 / 或 \），则读取本地文件
      if (pluginPathOrName.includes('/') || pluginPathOrName.includes('\\')) {
        return await this.getLocalPluginReadme(pluginPathOrName)
      }

      // 否则当作插件名称，从远程加载
      const name = pluginName || pluginPathOrName
      return await this.getRemotePluginReadme(name)
    } catch (error: unknown) {
      console.error('[Plugins] 读取插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '读取失败' }
    }
  }

  // 读取本地插件 README
  private async getLocalPluginReadme(
    pluginPath: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      // 尝试不同的 README 文件名（大小写不敏感）
      const possibleReadmeFiles = ['README.md', 'readme.md', 'Readme.md', 'README.MD']

      for (const filename of possibleReadmeFiles) {
        const readmePath = path.join(pluginPath, filename)
        try {
          let content = await fs.readFile(readmePath, 'utf-8')

          // 将插件路径转换为 file:// URL（跨平台兼容）
          const pluginPathUrl = pathToFileURL(pluginPath).href

          // 替换 Markdown 图片语法：![alt](path)
          content = content.replace(
            /!\[([^\]]*)\]\((?!http|file:)([^)]+)\)/g,
            (_match, alt, imgPath) => {
              const cleanPath = imgPath.replace(/^\.\//, '')
              return `![${alt}](${pluginPathUrl}/${cleanPath})`
            }
          )

          // 替换 HTML img 标签的 src 属性
          content = content.replace(
            /<img([^>]*?)src=["'](?!http|file:)([^"']+)["']([^>]*?)>/gi,
            (_match, before, src, after) => {
              const cleanSrc = src.replace(/^\.\//, '')
              return `<img${before}src="${pluginPathUrl}/${cleanSrc}"${after}>`
            }
          )

          // 替换 Markdown 链接语法（排除锚点链接 #）
          content = content.replace(
            /\[([^\]]+)\]\((?!http|file:|#)([^)]+)\)/g,
            (_match, text, linkPath) => {
              const cleanPath = linkPath.replace(/^\.\//, '')
              return `[${text}](${pluginPathUrl}/${cleanPath})`
            }
          )

          // 替换 HTML a 标签的 href 属性（排除锚点链接和外部链接）
          content = content.replace(
            /<a([^>]*?)href=["'](?!http|file:|#)([^"']+)["']([^>]*?)>/gi,
            (_match, before, href, after) => {
              const cleanHref = href.replace(/^\.\//, '')
              return `<a${before}href="${pluginPathUrl}/${cleanHref}"${after}>`
            }
          )

          return { success: true, content }
        } catch {
          // 继续尝试下一个文件名
          continue
        }
      }

      // 所有文件名都不存在
      return { success: false, error: '暂无详情' }
    } catch (error: unknown) {
      console.error('[Plugins] 读取本地插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '读取失败' }
    }
  }

  // 从远程加载插件 README
  private async getRemotePluginReadme(
    pluginName: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const baseUrl = `https://raw.githubusercontent.com/ZToolsCenter/ZTools-plugins/main/plugins/${pluginName}`
      const readmeUrl = `${baseUrl}/README.md`

      console.log('[Plugins] 从远程加载 README:', readmeUrl)

      // 使用 httpGet 获取 README 内容（走系统代理）
      const response = await httpGet(readmeUrl, {
        validateStatus: (status) => status >= 200 && status < 400
      })
      if (response.status >= 300) {
        return { success: false, error: '暂无详情' }
      }

      let content =
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data)

      // 替换 Markdown 图片语法：![alt](path)
      content = content.replace(/!\[([^\]]*)\]\((?!http)([^)]+)\)/g, (_match, alt, path) => {
        const cleanPath = path.replace(/^\.\//, '')
        return `![${alt}](${baseUrl}/${cleanPath})`
      })

      // 替换 HTML img 标签的 src 属性
      content = content.replace(
        /<img([^>]*?)src=["'](?!http)([^"']+)["']([^>]*?)>/gi,
        (_match, before, src, after) => {
          const cleanSrc = src.replace(/^\.\//, '')
          return `<img${before}src="${baseUrl}/${cleanSrc}"${after}>`
        }
      )

      // 替换 Markdown 链接语法（排除锚点链接 #）
      content = content.replace(/\[([^\]]+)\]\((?!http|#)([^)]+)\)/g, (_match, text, path) => {
        const cleanPath = path.replace(/^\.\//, '')
        return `[${text}](${baseUrl}/${cleanPath})`
      })

      // 替换 HTML a 标签的 href 属性（排除锚点链接和外部链接）
      content = content.replace(
        /<a([^>]*?)href=["'](?!http|#)([^"']+)["']([^>]*?)>/gi,
        (_match, before, href, after) => {
          const cleanHref = href.replace(/^\.\//, '')
          return `<a${before}href="${baseUrl}/${cleanHref}"${after}>`
        }
      )

      return { success: true, content }
    } catch (error: unknown) {
      console.error('[Plugins] 从远程加载插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '加载失败' }
    }
  }

  // 获取插件存储的数据库数据
  private getPluginDbData(pluginRef: PluginVariantRef | string): {
    success: boolean
    data?: any
    error?: string
  } {
    try {
      if (pluginRef === 'ZTOOLS') {
        const allData = lmdbInstance.allDocs('ZTOOLS/')
        return {
          success: true,
          data: allData.map((item: any) => ({
            id: item._id.substring('ZTOOLS/'.length),
            data: item.data,
            rev: item._rev,
            updatedAt: item.updatedAt || item._updatedAt
          }))
        }
      }

      const normalizedRef = normalizePluginVariantRef(pluginRef)
      if (!normalizedRef) {
        return { success: false, error: '插件标识无效' }
      }

      const prefix = getPluginDataPrefix(normalizedRef.pluginName, normalizedRef.source)
      const allData = lmdbInstance.allDocs(prefix)

      if (!allData || allData.length === 0) {
        return { success: true, data: [] }
      }

      // 过滤并格式化数据
      const formattedData = allData.map((item: any) => ({
        id: item._id.substring(prefix.length), // 去除前缀
        data: item.data,
        rev: item._rev,
        updatedAt: item.updatedAt || item._updatedAt
      }))

      return { success: true, data: formattedData }
    } catch (error: unknown) {
      console.error('[Plugins] 获取插件数据失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '获取失败' }
    }
  }

  /**
   * 从 npm 安装插件
   * @param packageName npm 包名（支持作用域包，如 @ztools/example）
   * @param useChinaMirror 是否使用国内镜像（默认 false）
   */
  private async installPluginFromNpm(packageName: string, useChinaMirror = false): Promise<any> {
    try {
      console.log('[Plugins] 开始从 npm 安装插件:', packageName)

      // 1. 从 npm registry 获取包信息
      const registryBase = useChinaMirror
        ? 'https://registry.npmmirror.com'
        : 'https://registry.npmjs.org'
      const registryUrl = `${registryBase}/${packageName}`
      console.log('[Plugins] 获取包信息:', registryUrl, useChinaMirror ? '(国内镜像)' : '')

      let packageInfo: any
      try {
        const response = await httpGet(registryUrl)
        packageInfo = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
      } catch (error) {
        console.error('[Plugins] 获取包信息失败:', error)
        return { success: false, error: '无法获取包信息，请检查包名是否正确' }
      }

      // 2. 获取最新版本的 tarball URL
      const latestVersion = packageInfo['dist-tags']?.latest
      if (!latestVersion) {
        return { success: false, error: '无法获取最新版本信息' }
      }

      const versionInfo = packageInfo.versions?.[latestVersion]
      if (!versionInfo) {
        return { success: false, error: '无法获取版本详情' }
      }

      const tarballUrl = versionInfo.dist?.tarball
      if (!tarballUrl) {
        return { success: false, error: '无法获取下载链接' }
      }

      console.log('[Plugins] 最新版本:', latestVersion)
      console.log('[Plugins] Tarball URL:', tarballUrl)

      // 3. 创建临时目录并下载 tarball
      const tempDir = path.join(app.getPath('temp'), 'ztools-npm-download')
      await fs.mkdir(tempDir, { recursive: true })

      const tarballPath = path.join(tempDir, `${Date.now()}.tgz`)
      console.log('[Plugins] 下载 tarball 到:', tarballPath)

      let retryCount = 0
      const maxRetries = 3
      while (retryCount < maxRetries) {
        try {
          await downloadFile(tarballUrl, tarballPath)
          break
        } catch (error) {
          retryCount++
          console.error(`下载失败，重试第 ${retryCount} 次:`, error)
          if (retryCount >= maxRetries) throw error
          await sleep(500)
        }
      }

      // 4. 解压 tarball 到临时目录
      const extractDir = path.join(tempDir, `extract-${Date.now()}`)
      await fs.mkdir(extractDir, { recursive: true })

      console.log('[Plugins] 解压 tarball 到:', extractDir)
      await tar.extract({
        file: tarballPath,
        cwd: extractDir
      })

      // 5. npm tarball 的内容在 package/ 目录下
      const packageDir = path.join(extractDir, 'package')
      const pluginJsonPath = path.join(packageDir, 'plugin.json')

      // 6. 检查 plugin.json 是否存在
      try {
        await fs.access(pluginJsonPath)
      } catch {
        // 清理临时文件
        await fs.rm(tempDir, { recursive: true, force: true })
        return { success: false, error: '这不是一个有效的 ZTools 插件包（缺少 plugin.json）' }
      }

      // 7. 读取并验证 plugin.json
      const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8')
      let pluginConfig: any
      try {
        pluginConfig = JSON.parse(pluginJsonContent)
      } catch {
        await fs.rm(tempDir, { recursive: true, force: true })
        return { success: false, error: 'plugin.json 格式错误' }
      }

      if (!pluginConfig.name) {
        await fs.rm(tempDir, { recursive: true, force: true })
        return { success: false, error: 'plugin.json 缺少 name 字段' }
      }

      const pluginName = pluginConfig.name
      const targetPath = path.join(PLUGIN_DIR, pluginName)

      // 8. 检查是否已安装（覆盖安装逻辑）
      const existingPlugins: any[] = databaseAPI.dbGet('plugins') || []
      const existingIndex = existingPlugins.findIndex((p: any) => p.name === pluginName)

      if (existingIndex !== -1) {
        console.log('[Plugins] 插件已存在，执行覆盖安装:', pluginName)

        // 终止正在运行的插件
        try {
          await this.pluginManager?.killPluginByName?.(pluginName)
        } catch {
          // 忽略终止错误
        }

        // 从数据库中移除旧记录
        existingPlugins.splice(existingIndex, 1)
        databaseAPI.dbPut('plugins', existingPlugins)

        // 删除旧目录
        try {
          await fs.rm(targetPath, { recursive: true, force: true })
          console.log('[Plugins] 已删除旧插件目录:', targetPath)
        } catch {
          // 忽略删除错误
        }
      }

      // 9. 移动到插件目录
      await fs.mkdir(PLUGIN_DIR, { recursive: true })
      await fs.rename(packageDir, targetPath)

      console.log('[Plugins] 插件已安装到:', targetPath)

      // 10. 验证插件配置
      const validation = this.validatePluginConfig(pluginConfig, existingPlugins)
      if (!validation.valid) {
        // 安装失败，清理目录
        await fs.rm(targetPath, { recursive: true, force: true })
        await fs.rm(tempDir, { recursive: true, force: true })
        return { success: false, error: validation.error }
      }

      // 11. 保存到数据库
      const pluginInfo = {
        name: pluginConfig.name,
        title: pluginConfig.title,
        version: pluginConfig.version,
        description: pluginConfig.description || '',
        author: pluginConfig.author || '',
        homepage: pluginConfig.homepage || '',
        logo: pluginConfig.logo ? pathToFileURL(path.join(targetPath, pluginConfig.logo)).href : '',
        main: pluginConfig.main,
        preload: pluginConfig.preload,
        features: pluginConfig.features,
        path: targetPath,
        isDevelopment: false,
        installedAt: new Date().toISOString(),
        installedFrom: 'npm'
      }

      let plugins: any = databaseAPI.dbGet('plugins')
      if (!plugins) plugins = []
      plugins.push(pluginInfo)
      databaseAPI.dbPut('plugins', plugins)

      // 12. 清理临时文件
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (e) {
        console.error('[Plugins] 清理临时文件失败:', e)
      }

      // 13. 输出新增的指令
      console.log('[Plugins] \n=== 从 npm 安装插件成功 ===')
      console.log(`npm 包名: ${packageName}`)
      console.log(`插件名称: ${pluginConfig.name}`)
      console.log(`插件版本: ${pluginConfig.version}`)
      console.log('[Plugins] 新增指令列表:')
      pluginConfig.features?.forEach((feature: any, index: number) => {
        console.log(`  [${index + 1}] ${feature.code} - ${feature.explain || '无说明'}`)

        const formattedCmds = feature.cmds
          .map((cmd: any) => {
            if (typeof cmd === 'string') {
              return cmd
            } else if (typeof cmd === 'object' && cmd !== null) {
              const type = cmd.type || 'unknown'
              const label = cmd.label || type
              return `[${type}] ${label}`
            }
            return String(cmd)
          })
          .join(', ')

        console.log(`      关键词: ${formattedCmds}`)
      })
      console.log('[Plugins] =========================\n')

      this.mainWindow?.webContents.send('plugins-changed')
      return { success: true, plugin: pluginInfo }
    } catch (error: unknown) {
      console.error('[Plugins] 从 npm 安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }
}

export default new PluginsAPI()
