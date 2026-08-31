import { app } from 'electron'
import fsSync from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import api from '../api/index'
import { BUNDLED_INTERNAL_PLUGIN_NAMES, getInternalPluginPath } from './internalPlugins'

/**
 * 加载所有内置插件，并在应用启动时将插件信息写入数据库。
 * @returns 无返回值
 */
export function loadInternalPlugins(): void {
  console.log('[InternalPlugin] 开始加载内置插件...')

  const isDev = !app.isPackaged
  const existingPlugins = api.dbGet('plugins') || []

  // 移除旧的内置插件记录（基于名称判断）
  const filteredPlugins = existingPlugins.filter(
    (p: any) => !BUNDLED_INTERNAL_PLUGIN_NAMES.includes(p.name)
  )

  // 重新加载所有内置插件
  for (const pluginName of BUNDLED_INTERNAL_PLUGIN_NAMES) {
    try {
      const pluginPath = getInternalPluginPath(pluginName)

      // 开发模式：插件路径直接指向 public 目录
      // 生产模式：插件路径指向插件根目录（打包时已将 dist 构建产物复制到此目录）
      const effectivePluginPath = isDev ? path.join(pluginPath, 'public') : pluginPath

      // 读取 plugin.json
      const pluginJsonPath = path.join(effectivePluginPath, 'plugin.json')

      if (!fsSync.existsSync(pluginJsonPath)) {
        console.error(
          `[InternalPlugin] 内置插件 ${pluginName} 的 plugin.json 不存在:`,
          pluginJsonPath
        )
        continue
      }

      const pluginConfig = JSON.parse(fsSync.readFileSync(pluginJsonPath, 'utf-8'))

      // 构建插件信息
      const logoPath = pluginConfig.logo ? path.join(effectivePluginPath, pluginConfig.logo) : ''

      const mainPath = pluginConfig.main
        ? path.join(effectivePluginPath, pluginConfig.main)
        : undefined

      const pluginInfo = {
        name: pluginConfig.name,
        title: pluginConfig.title,
        version: pluginConfig.version,
        description: pluginConfig.description || '',
        logo: logoPath ? pathToFileURL(logoPath).href : '',
        path: effectivePluginPath, // 保存有效路径（开发模式下是 public 目录）
        features: pluginConfig.features || [],
        isDevelopment: isDev,
        main: mainPath
      }

      filteredPlugins.push(pluginInfo)
      console.log(`[InternalPlugin] 已加载内置插件: ${pluginName}`)
    } catch (error) {
      console.error(`[InternalPlugin] 加载内置插件 ${pluginName} 失败:`, error)
    }
  }

  // 保存到数据库
  api.dbPut('plugins', filteredPlugins)
  console.log('[InternalPlugin] 内置插件加载完成')
}
