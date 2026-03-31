import path from 'path'

/**
 * 兼容旧版“仅按路径记录开发项目”的存储键。
 */
export const DEV_PLUGIN_PROJECTS_DB_KEY = 'dev-plugin-projects'
/**
 * 开发项目主记录，只保存 name 与最近一次合法配置快照，不落设备路径。
 */
export const DEV_PLUGIN_REGISTRY_DB_KEY = 'dev-plugin-registry'
const DEV_PLUGIN_REGISTRY_VERSION = 2 as const
const DEV_PLUGIN_LOCAL_BINDINGS_VERSION = 1 as const
const BUILT_IN_PLUGIN_NAMES = new Set(['setting', 'system'])
/**
 * 当前设备的本地绑定前缀，真实键格式为 `dev-plugin-local-bindings/<nativeId>`。
 */
export const DEV_PLUGIN_LOCAL_BINDINGS_PREFIX = 'dev-plugin-local-bindings'
const DEV_PROJECT_BINDING_STATUS_SET = new Set<DevProjectBindingStatus>([
  'ready',
  'config_missing',
  'invalid_config',
  'unbound'
])

export type DevProjectBindingStatus = 'ready' | 'config_missing' | 'invalid_config' | 'unbound'

export interface DevProjectRegistryEntry {
  /** 开发项目的稳定 identity，对应 plugin.json.name。 */
  name: string
  /** 最近一次通过校验的配置快照，用于无路径场景下展示项目信息。 */
  configSnapshot: PluginConfigLite
  /** 首次登记时间。 */
  addedAt: string
  /** 最近一次刷新主记录快照的时间。 */
  updatedAt: string
  /** 跨设备共享的展示顺序，数字越小越靠前。 */
  sortOrder: number
}

export interface DevPluginRegistryDoc {
  /** 主记录文档版本号。 */
  version: typeof DEV_PLUGIN_REGISTRY_VERSION
  /** 按项目 name 建立的开发项目主记录。 */
  projects: Record<string, DevProjectRegistryEntry>
}

export interface DevProjectLocalBinding {
  /** 与主记录一致的项目 identity。 */
  name: string
  /** 当前设备绑定的工程目录。 */
  projectPath: string | null
  /** 当前设备绑定的 plugin.json 路径。 */
  configPath: string | null
  /** 当前设备上的配置状态。 */
  status: DevProjectBindingStatus
  /** 最近一次校验当前设备绑定的时间。 */
  lastValidatedAt: string
  /** 最近一次写入该绑定记录的时间。 */
  updatedAt: string
  /** 最近一次校验失败原因。 */
  lastError?: string
}

export interface DevPluginLocalBindingsDoc {
  /** 本地绑定文档版本号。 */
  version: typeof DEV_PLUGIN_LOCAL_BINDINGS_VERSION
  /** 当前设备 ID。 */
  deviceId: string
  /** 最近一次更新当前设备绑定文档的时间。 */
  updatedAt: string
  /** 当前设备上按 name 存储的路径绑定。 */
  bindings: Record<string, DevProjectLocalBinding>
}

export interface DevProjectMigrationOptions {
  /** 旧版开发项目列表。 */
  legacyRecords: DevProjectRecord[]
  /** 已安装插件列表，用于兼容旧版开发模式记录。 */
  installedPlugins: InstalledPluginLite[]
  /** 旧路径对应的 plugin.json 快照。 */
  pluginConfigs: Record<string, PluginConfigLite>
  /** 当前设备 ID。 */
  deviceId: string
  /** 允许注入时钟，便于测试。 */
  now?: () => string
}

export interface UpsertDevProjectFromConfigOptions {
  /** 现有开发项目主记录。 */
  registry: DevPluginRegistryDoc
  /** 当前设备本地绑定。 */
  localBindings: DevPluginLocalBindingsDoc
  /** 导入的工程目录。 */
  pluginPath: string
  /** 读取到的 plugin.json 配置。 */
  pluginConfig: PluginConfigLite
  /** 允许注入时钟，便于测试。 */
  now?: () => string
}

export interface UpsertDevProjectFromConfigResult {
  /** 是否成功完成登记。 */
  success: boolean
  /** 失败时的原因。 */
  reason?: string
  /** 更新后的主记录。 */
  registry: DevPluginRegistryDoc
  /** 更新后的当前设备绑定。 */
  localBindings: DevPluginLocalBindingsDoc
}

export interface DevProjectRecord {
  /** 旧版记录中的工程目录。 */
  path: string
  /** 旧版记录中的添加时间。 */
  addedAt: string
}

export interface PluginConfigLite {
  /** 插件唯一标识。 */
  name?: string
  /** 用户可见标题。 */
  title?: string
  /** 插件版本号。 */
  version?: string
  /** 插件描述。 */
  description?: string
  /** 作者信息。 */
  author?: string
  /** 插件主页。 */
  homepage?: string
  /** 图标路径。 */
  logo?: string
  /** preload 入口。 */
  preload?: string
  /** 插件 feature 列表。 */
  features?: any[]
  development?: {
    /** 开发模式主入口。 */
    main?: string
  }
}

export interface InstalledPluginLite {
  /** 插件唯一标识。 */
  name?: string
  /** 用户可见标题。 */
  title?: string
  /** 插件版本号。 */
  version?: string
  /** 插件描述。 */
  description?: string
  /** 作者信息。 */
  author?: string
  /** 插件主页。 */
  homepage?: string
  /** 图标路径。 */
  logo?: string
  /** 运行入口。 */
  main?: string
  /** preload 入口。 */
  preload?: string
  /** 插件 feature 列表。 */
  features?: any[]
  /** 已安装插件的实际路径。 */
  path?: string
  /** 是否为开发模式安装。 */
  isDevelopment?: boolean
  /** 安装时间。 */
  installedAt?: string
}

export interface DevelopmentProjectMeta {
  /** 工程目录。 */
  path: string
  /** plugin.json 路径。 */
  pluginJsonPath: string
  /** 开发项目 identity。 */
  name: string
  /** 用户可见标题。 */
  title?: string
  /** 插件版本号。 */
  version?: string
  /** 描述文案。 */
  description: string
  /** 作者信息。 */
  author: string
  /** 插件主页。 */
  homepage: string
  /** 图标路径。 */
  logo: string
  /** preload 入口。 */
  preload?: string
  /** 插件 feature 列表。 */
  features: any[]
  /** development.main。 */
  developmentMain?: string
  /** 首次登记时间。 */
  addedAt: string
  /** 当前是否已安装开发模式。 */
  isDevModeInstalled: boolean
  /** 当前是否正在运行。 */
  isRunning: boolean
}

/**
 * 统一标准化工程路径，避免同一路径因为相对/绝对写法不同而重复登记。
 */
function normalizeProjectPath(pluginPath: string): string {
  return path.resolve(pluginPath)
}

/**
 * 返回当前 ISO 时间字符串。
 */
function nowIsoString(): string {
  return new Date().toISOString()
}

/**
 * 规范化时间戳字段，缺失时回退到传入的默认值。
 */
function normalizeIsoTimestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

/**
 * 规范化本地绑定状态，非法值统一降级为 unbound。
 */
function normalizeBindingStatus(value: unknown): DevProjectBindingStatus {
  if (
    typeof value === 'string' &&
    DEV_PROJECT_BINDING_STATUS_SET.has(value as DevProjectBindingStatus)
  ) {
    return value as DevProjectBindingStatus
  }
  return 'unbound'
}

/**
 * 规范化可选路径字段，空字符串与非字符串统一视为 null。
 */
function normalizeOptionalPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.trim()) return null
  return normalizeProjectPath(value)
}

/**
 * 将旧版原始记录转换为标准化结构。
 */
function normalizeRecord(value: any): DevProjectRecord | null {
  if (!value || typeof value !== 'object') return null
  if (typeof value.path !== 'string' || !value.path) return null
  const normalizedPath = normalizeProjectPath(value.path)
  return {
    path: normalizedPath,
    addedAt: typeof value.addedAt === 'string' && value.addedAt ? value.addedAt : nowIsoString()
  }
}

export function readDevProjectRecords(raw: unknown): DevProjectRecord[] {
  if (!Array.isArray(raw)) return []
  const deduped = new Map<string, DevProjectRecord>()
  for (const item of raw) {
    const normalized = normalizeRecord(item)
    if (!normalized) continue
    if (!deduped.has(normalized.path)) {
      deduped.set(normalized.path, normalized)
    }
  }
  return Array.from(deduped.values())
}

/**
 * 在旧版路径列表中写入一条记录，重复路径只保留第一条。
 */
export function upsertDevProjectRecord(
  records: DevProjectRecord[],
  pluginPath: string,
  addedAt: string = nowIsoString()
): DevProjectRecord[] {
  const normalizedPath = normalizeProjectPath(pluginPath)
  const list = readDevProjectRecords(records)
  const exists = list.some((item) => item.path === normalizedPath)
  if (exists) {
    return list
  }
  return [...list, { path: normalizedPath, addedAt }]
}

export function mergeLegacyDevelopmentProjects(
  records: DevProjectRecord[],
  installedPlugins: InstalledPluginLite[]
): DevProjectRecord[] {
  let merged = readDevProjectRecords(records)
  for (const plugin of installedPlugins) {
    if (!plugin?.isDevelopment || typeof plugin.path !== 'string' || !plugin.path) {
      continue
    }
    merged = upsertDevProjectRecord(merged, plugin.path, plugin.installedAt || nowIsoString())
  }
  return merged
}

/**
 * 将工程目录、配置快照、运行态与安装态整合为开发项目展示模型。
 */
export function normalizeDevelopmentProject(
  pluginPath: string,
  pluginConfig: PluginConfigLite,
  installedPlugins: InstalledPluginLite[],
  runningPluginPaths: string[],
  addedAt: string = nowIsoString()
): DevelopmentProjectMeta {
  const normalizedPath = normalizeProjectPath(pluginPath)
  const installedSet = new Set(
    installedPlugins
      .filter((item) => item?.isDevelopment && typeof item.path === 'string')
      .map((item) => normalizeProjectPath(item.path!))
  )
  const runningSet = new Set(runningPluginPaths.map((item) => normalizeProjectPath(item)))

  return {
    path: normalizedPath,
    pluginJsonPath: path.join(normalizedPath, 'plugin.json'),
    name: pluginConfig.name || path.basename(normalizedPath),
    title: pluginConfig.title,
    version: pluginConfig.version,
    description: pluginConfig.description || '',
    author: pluginConfig.author || '',
    homepage: pluginConfig.homepage || '',
    logo: pluginConfig.logo || '',
    preload: pluginConfig.preload,
    features: Array.isArray(pluginConfig.features) ? pluginConfig.features : [],
    developmentMain: pluginConfig.development?.main,
    addedAt,
    isDevModeInstalled: installedSet.has(normalizedPath),
    isRunning: runningSet.has(normalizedPath)
  }
}

export function buildInstalledDevelopmentPlugin(
  pluginPath: string,
  pluginConfig: PluginConfigLite
): InstalledPluginLite {
  const normalizedPath = normalizeProjectPath(pluginPath)
  return {
    name: pluginConfig.name || path.basename(normalizedPath),
    title: pluginConfig.title,
    version: pluginConfig.version,
    description: pluginConfig.description || '',
    author: pluginConfig.author || '',
    homepage: pluginConfig.homepage || '',
    logo: pluginConfig.logo || '',
    main: pluginConfig.development?.main,
    preload: pluginConfig.preload,
    features: Array.isArray(pluginConfig.features) ? pluginConfig.features : [],
    path: normalizedPath,
    isDevelopment: true,
    installedAt: nowIsoString()
  }
}

/**
 * 基于设备 ID 生成本地绑定存储键，确保路径只在当前设备生效。
 */
export function getDevPluginLocalBindingsKey(deviceId: string): string {
  return `${DEV_PLUGIN_LOCAL_BINDINGS_PREFIX}/${deviceId}`
}

/**
 * 创建空的开发项目主记录文档。
 */
export function createEmptyDevPluginRegistryDoc(): DevPluginRegistryDoc {
  return {
    version: DEV_PLUGIN_REGISTRY_VERSION,
    projects: {}
  }
}

/**
 * 读取当前主记录中的项目名顺序，优先使用 sortOrder，缺失时按 addedAt 倒序兜底。
 */
function getOrderedProjectNames(projects: Record<string, DevProjectRegistryEntry>): string[] {
  return Object.values(projects)
    .sort((a, b) => {
      const orderA = Number.isFinite(a.sortOrder) ? a.sortOrder : Number.MAX_SAFE_INTEGER
      const orderB = Number.isFinite(b.sortOrder) ? b.sortOrder : Number.MAX_SAFE_INTEGER
      if (orderA !== orderB) {
        return orderA - orderB
      }

      const timeA = a.addedAt ? new Date(a.addedAt).getTime() : 0
      const timeB = b.addedAt ? new Date(b.addedAt).getTime() : 0
      return timeB - timeA
    })
    .map((item) => item.name)
}

/**
 * 根据传入顺序重写主记录中的 sortOrder。
 * 未出现在请求中的项目会按当前顺序追加到末尾，避免陈旧客户端覆盖掉新项目。
 */
export function applyDevProjectsOrderUpdate(
  registry: DevPluginRegistryDoc,
  pluginNames: string[]
): DevPluginRegistryDoc {
  const currentNames = getOrderedProjectNames(registry.projects)
  const currentNameSet = new Set(currentNames)

  for (const name of pluginNames) {
    if (!currentNameSet.has(name)) {
      throw new Error(`Unknown dev project: ${name}`)
    }
  }

  const mergedNames = [
    ...pluginNames,
    ...currentNames.filter((name) => !pluginNames.includes(name))
  ]
  const nextProjects: Record<string, DevProjectRegistryEntry> = {}

  for (const [index, name] of mergedNames.entries()) {
    const current = registry.projects[name]
    if (!current) {
      continue
    }
    nextProjects[name] = {
      ...current,
      sortOrder: index
    }
  }

  return {
    version: registry.version,
    projects: nextProjects
  }
}

/**
 * 将指定项目提升到共享顺序的顶部。
 */
export function insertDevProjectAtTop(
  registry: DevPluginRegistryDoc,
  projectName: string
): DevPluginRegistryDoc {
  const orderedNames = getOrderedProjectNames(registry.projects).filter(
    (name) => name !== projectName
  )
  const nextProjects: Record<string, DevProjectRegistryEntry> = {
    ...registry.projects
  }

  if (!nextProjects[projectName]) {
    return registry
  }

  const nextOrder = [projectName, ...orderedNames]

  for (const [index, name] of nextOrder.entries()) {
    const current = nextProjects[name]
    if (!current) {
      continue
    }
    nextProjects[name] = {
      ...current,
      sortOrder: index
    }
  }

  return {
    version: registry.version,
    projects: nextProjects
  }
}

/**
 * 创建空的当前设备本地绑定文档。
 */
export function createEmptyDevPluginLocalBindingsDoc(deviceId: string): DevPluginLocalBindingsDoc {
  return {
    version: DEV_PLUGIN_LOCAL_BINDINGS_VERSION,
    deviceId,
    updatedAt: nowIsoString(),
    bindings: {}
  }
}

/**
 * 读取并规范化开发项目主记录文档。
 */
export function readDevPluginRegistryDoc(raw: unknown): DevPluginRegistryDoc {
  const emptyDoc = createEmptyDevPluginRegistryDoc()
  if (!raw || typeof raw !== 'object') return emptyDoc
  const doc = raw as { version?: unknown; projects?: unknown }
  if (doc.version !== DEV_PLUGIN_REGISTRY_VERSION) return emptyDoc
  if (!doc.projects || typeof doc.projects !== 'object' || Array.isArray(doc.projects))
    return emptyDoc

  const projects: Record<string, DevProjectRegistryEntry> = {}
  const pendingSortOrders = new Map<string, number | null>()
  const fallbackTimestamp = nowIsoString()
  for (const [name, entry] of Object.entries(doc.projects as Record<string, any>)) {
    if (!name || BUILT_IN_PLUGIN_NAMES.has(name)) continue
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.name !== 'string' || entry.name !== name) continue
    if (
      !entry.configSnapshot ||
      typeof entry.configSnapshot !== 'object' ||
      Array.isArray(entry.configSnapshot)
    ) {
      continue
    }

    projects[name] = {
      name,
      configSnapshot: { ...(entry.configSnapshot as PluginConfigLite) },
      addedAt: normalizeIsoTimestamp(entry.addedAt, fallbackTimestamp),
      updatedAt: normalizeIsoTimestamp(entry.updatedAt, fallbackTimestamp),
      sortOrder: -1
    }
    pendingSortOrders.set(name, Number.isFinite(entry.sortOrder) ? Number(entry.sortOrder) : null)
  }

  const fallbackOrderedNames = Object.values(projects)
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime())
    .map((item) => item.name)
  const fallbackSortOrder = new Map(fallbackOrderedNames.map((name, index) => [name, index]))

  for (const [name, project] of Object.entries(projects)) {
    const explicitOrder = pendingSortOrders.get(name)
    project.sortOrder = explicitOrder ?? fallbackSortOrder.get(name) ?? Number.MAX_SAFE_INTEGER
  }

  return {
    version: DEV_PLUGIN_REGISTRY_VERSION,
    projects
  }
}

/**
 * 读取并规范化当前设备的本地绑定文档。
 */
export function readDevPluginLocalBindingsDoc(
  raw: unknown,
  deviceId: string
): DevPluginLocalBindingsDoc {
  const emptyDoc = createEmptyDevPluginLocalBindingsDoc(deviceId)
  if (!raw || typeof raw !== 'object') return emptyDoc
  const doc = raw as {
    version?: unknown
    deviceId?: unknown
    updatedAt?: unknown
    bindings?: unknown
  }
  if (doc.version !== DEV_PLUGIN_LOCAL_BINDINGS_VERSION) return emptyDoc
  if (doc.deviceId !== deviceId) return emptyDoc
  if (!doc.bindings || typeof doc.bindings !== 'object' || Array.isArray(doc.bindings))
    return emptyDoc

  const bindings: Record<string, DevProjectLocalBinding> = {}
  const fallbackTimestamp = nowIsoString()
  for (const [name, entry] of Object.entries(doc.bindings as Record<string, any>)) {
    if (!name || BUILT_IN_PLUGIN_NAMES.has(name)) continue
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.name !== 'string' || entry.name !== name) continue
    const status = normalizeBindingStatus(entry.status)
    let projectPath = normalizeOptionalPath(entry.projectPath)
    let configPath = normalizeOptionalPath(entry.configPath)
    if (status !== 'unbound') {
      if (!projectPath && configPath) {
        projectPath = normalizeProjectPath(path.dirname(configPath))
      }
      if (!configPath && projectPath) {
        configPath = normalizeProjectPath(path.join(projectPath, 'plugin.json'))
      }
      if (!projectPath || !configPath) continue
    }

    bindings[name] = {
      name,
      projectPath,
      configPath,
      status,
      lastValidatedAt: normalizeIsoTimestamp(entry.lastValidatedAt, fallbackTimestamp),
      updatedAt: normalizeIsoTimestamp(entry.updatedAt, fallbackTimestamp),
      ...(typeof entry.lastError === 'string' && entry.lastError
        ? { lastError: entry.lastError }
        : {})
    }
  }

  return {
    version: DEV_PLUGIN_LOCAL_BINDINGS_VERSION,
    deviceId,
    updatedAt: normalizeIsoTimestamp(doc.updatedAt, fallbackTimestamp),
    bindings
  }
}

/**
 * 将旧版“按路径登记”的开发项目迁移为“主记录 + 当前设备路径绑定”的双层结构。
 */
export function migrateLegacyDevProjects(options: DevProjectMigrationOptions): {
  registry: DevPluginRegistryDoc
  localBindings: DevPluginLocalBindingsDoc
} {
  const clock = options.now ?? nowIsoString
  const operationTimestamp = clock()
  const normalizedConfigs: Record<string, PluginConfigLite> = {}
  const registerConfig = (configPath: string, pluginConfig: PluginConfigLite) => {
    const resolved = normalizeProjectPath(configPath)
    const isPluginJson = path.basename(resolved).toLowerCase() === 'plugin.json'
    const dirPath = isPluginJson ? path.dirname(resolved) : resolved
    const pluginJsonPath = isPluginJson ? resolved : path.join(resolved, 'plugin.json')
    normalizedConfigs[dirPath] = pluginConfig
    normalizedConfigs[pluginJsonPath] = pluginConfig
  }

  for (const [configPath, pluginConfig] of Object.entries(options.pluginConfigs)) {
    registerConfig(configPath, pluginConfig)
  }

  // 旧数据里同一项目可能既出现在开发项目列表，又出现在已安装列表，这里先按路径去重。
  const addPathEntries = new Map<string, { path: string; addedAt: string }>()
  const addPath = (pluginPath: string | undefined, addedAt?: string) => {
    if (!pluginPath) return
    const resolved = normalizeProjectPath(pluginPath)
    if (addPathEntries.has(resolved)) return
    addPathEntries.set(resolved, {
      path: resolved,
      addedAt: addedAt && typeof addedAt === 'string' ? addedAt : operationTimestamp
    })
  }

  for (const record of options.legacyRecords) {
    addPath(record.path, record.addedAt)
  }

  for (const plugin of options.installedPlugins) {
    if (!plugin?.isDevelopment || typeof plugin.path !== 'string') continue
    addPath(plugin.path, plugin.installedAt)
  }

  // 主记录按 name 建立 identity；本地绑定只保存当前设备的路径与状态。
  const registryProjects: Record<string, DevProjectRegistryEntry> = {}
  const bindingProjects: Record<string, DevProjectLocalBinding> = {}

  for (const entry of addPathEntries.values()) {
    const config = normalizedConfigs[entry.path]
    if (!config?.name) continue
    const name = config.name
    if (BUILT_IN_PLUGIN_NAMES.has(name)) continue
    if (registryProjects[name]) continue

    registryProjects[name] = {
      name,
      configSnapshot: { ...config },
      addedAt: entry.addedAt,
      updatedAt: operationTimestamp,
      sortOrder: Object.keys(registryProjects).length
    }

    bindingProjects[name] = {
      name,
      projectPath: entry.path,
      configPath: path.join(entry.path, 'plugin.json'),
      status: 'ready',
      lastValidatedAt: operationTimestamp,
      updatedAt: operationTimestamp
    }
  }

  return {
    registry: {
      version: DEV_PLUGIN_REGISTRY_VERSION,
      projects: registryProjects
    },
    localBindings: {
      version: DEV_PLUGIN_LOCAL_BINDINGS_VERSION,
      deviceId: options.deviceId,
      updatedAt: operationTimestamp,
      bindings: bindingProjects
    }
  }
}

/**
 * 根据导入的 plugin.json 更新开发项目。
 * 同名项目只允许绑定到当前设备上的同一工程目录，避免 name identity 被错误覆盖。
 */
export function upsertDevProjectFromConfig(
  options: UpsertDevProjectFromConfigOptions
): UpsertDevProjectFromConfigResult {
  const clock = options.now ?? nowIsoString
  const normalizedPath = normalizeProjectPath(options.pluginPath)
  const projectName = options.pluginConfig.name
  if (!projectName) {
    return {
      success: false,
      reason: 'Project config requires a name',
      registry: options.registry,
      localBindings: options.localBindings
    }
  }

  if (BUILT_IN_PLUGIN_NAMES.has(projectName)) {
    return {
      success: false,
      reason: `Project name ${projectName} is not allowed`,
      registry: options.registry,
      localBindings: options.localBindings
    }
  }

  const existing = options.registry.projects[projectName]
  const existingBinding = options.localBindings.bindings[projectName]
  if (
    existingBinding?.projectPath &&
    normalizeProjectPath(existingBinding.projectPath) !== normalizedPath
  ) {
    return {
      success: false,
      reason: `Project name ${projectName} is already registered at ${existingBinding.projectPath}`,
      registry: options.registry,
      localBindings: options.localBindings
    }
  }

  const operationTimestamp = clock()
  const nextProjects = {
    ...options.registry.projects,
    [projectName]: {
      name: projectName,
      configSnapshot: { ...options.pluginConfig },
      addedAt: existing?.addedAt ?? operationTimestamp,
      updatedAt: operationTimestamp,
      sortOrder: existing?.sortOrder ?? Object.keys(options.registry.projects).length
    }
  }
  const nextBindings: Record<string, DevProjectLocalBinding> = {
    ...options.localBindings.bindings,
    [projectName]: {
      name: projectName,
      projectPath: normalizedPath,
      configPath: path.join(normalizedPath, 'plugin.json'),
      status: 'ready',
      lastValidatedAt: operationTimestamp,
      updatedAt: operationTimestamp
    }
  }

  return {
    success: true,
    registry: {
      version: DEV_PLUGIN_REGISTRY_VERSION,
      projects: nextProjects
    },
    localBindings: {
      version: DEV_PLUGIN_LOCAL_BINDINGS_VERSION,
      deviceId: options.localBindings.deviceId,
      updatedAt: operationTimestamp,
      bindings: nextBindings
    }
  }
}

/**
 * 打包只依赖本地绑定状态为 ready，不要求项目已经安装为开发模式。
 */
export function canPackageDevProject(binding?: DevProjectLocalBinding): boolean {
  return binding?.status === 'ready'
}

/**
 * 修复配置时必须继续沿用原项目的 name identity，避免误把另一个工程绑定进来。
 */
export function validateRepairConfigSelection(
  registryItem: DevProjectRegistryEntry,
  pluginConfig: PluginConfigLite
): boolean {
  if (!pluginConfig.name) return false
  return pluginConfig.name === registryItem.name
}
