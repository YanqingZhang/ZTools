<template>
  <div class="settings-container">
    <!-- 左侧菜单 -->
    <div class="settings-sidebar">
      <div
        v-for="item in menuItems"
        :key="item.id"
        class="menu-item"
        :class="{ active: activeMenu === item.id }"
        @click="activeMenu = item.id"
      >
        <Icon :name="item.icon" :size="18" class="menu-icon" />
        <span class="menu-label">{{ item.label }}</span>
      </div>
    </div>

    <!-- 右侧内容区 -->
    <div class="settings-content">
      <!-- 通用设置 -->
      <GeneralSettings v-if="activeMenu === 'general'" />

      <!-- 插件中心 -->
      <PluginCenter
        v-if="activeMenu === 'plugins'"
        :search-query="props.searchQuery"
        :add-dev-plugin-file-path="localAddDevPluginFilePath"
        :auto-open-plugin-name="localAutoOpenPluginName"
        @auto-open-consumed="handleAutoOpenConsumed"
        @add-dev-consumed="handleAddDevConsumed"
        @navigate="handleNavigateFromPluginCenter"
      />

      <!-- 插件市场 -->
      <PluginMarket v-if="activeMenu === 'market'" :search-query="props.searchQuery" />

      <!-- 我的数据 -->
      <DataManagement v-if="activeMenu === 'data'" :search-query="props.searchQuery" />

      <!-- 全局快捷键 -->
      <GlobalShortcuts
        v-if="activeMenu === 'shortcuts'"
        :search-query="props.searchQuery"
        :auto-add-target="shortcutAutoAddTarget"
        @auto-add-consumed="shortcutAutoAddTarget = ''"
      />

      <!-- WebDAV 同步 -->
      <SyncSettings v-if="activeMenu === 'sync'" />

      <!-- 所有指令 -->
      <AllCommands
        v-if="activeMenu === 'all-commands'"
        :search-query="props.searchQuery"
        @navigate="handleNavigate"
      />

      <!-- 本地启动 -->
      <LocalLaunch v-if="activeMenu === 'local-launch'" :search-query="props.searchQuery" />

      <!-- AI 模型管理 -->
      <AiModels v-if="activeMenu === 'ai-models'" :search-query="props.searchQuery" />

      <!-- 网页快开 -->
      <WebSearch v-if="activeMenu === 'web-search'" :search-query="props.searchQuery" />

      <!-- 安装插件 -->
      <PluginInstaller
        v-if="activeMenu === 'install-plugin'"
        :file-path="props.installPluginFilePath || ''"
        @installed="handlePluginInstalled"
      />

      <!-- 关于 -->
      <AboutPage v-if="activeMenu === 'about'" />

      <!-- HTTP 服务 -->
      <HttpService v-if="activeMenu === 'http-service'" />

      <!-- 调试日志 -->
      <DebugConsole v-if="activeMenu === 'debug'" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '../common/Icon.vue'
import AiModels from './AiModels.vue'
import AllCommands from './AllCommands.vue'
import DataManagement from './DataManagement.vue'
import DebugConsole from './DebugConsole.vue'
import GeneralSettings from './GeneralSettings.vue'
import GlobalShortcuts from './GlobalShortcuts.vue'
import HttpService from './HttpService.vue'
import LocalLaunch from './LocalLaunch.vue'
import PluginCenter from './PluginCenter.vue'
import PluginInstaller from './PluginInstaller.vue'
import PluginMarket from './PluginMarket.vue'
import SyncSettings from './SyncSettings.vue'
import WebSearch from './WebSearch.vue'
import AboutPage from './AboutPage.vue'

// Props
interface Props {
  activePage: string
  searchQuery?: string
  installPluginFilePath?: string
  addDevPluginFilePath?: string
  autoOpenPluginName?: string
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'update:activePage': [value: string]
  'auto-open-consumed': []
  'add-dev-consumed': []
  'update:installPluginFilePath': [value: string]
}>()

// 菜单项类型
interface MenuItem {
  id: string
  icon:
    | 'settings'
    | 'plugin'
    | 'keyboard'
    | 'store'
    | 'database'
    | 'list'
    | 'cloud'
    | 'folder'
    | 'brain'
    | 'info'
    | 'terminal'
    | 'search'
    | 'monitor'
  label: string
}

// 菜单项
const menuItems: MenuItem[] = [
  { id: 'general', icon: 'settings', label: '通用设置' },
  { id: 'shortcuts', icon: 'keyboard', label: '快捷键' },
  { id: 'plugins', icon: 'plugin', label: '已安装插件' },
  { id: 'market', icon: 'store', label: '插件市场' },
  { id: 'ai-models', icon: 'brain', label: 'AI 模型' },
  { id: 'web-search', icon: 'search', label: '网页快开' },
  { id: 'data', icon: 'database', label: '我的数据' },
  { id: 'all-commands', icon: 'list', label: '所有指令' },
  { id: 'local-launch', icon: 'folder', label: '本地启动' },
  { id: 'sync', icon: 'cloud', label: 'WebDAV 同步' },
  { id: 'debug', icon: 'terminal', label: '调试日志' },
  { id: 'about', icon: 'info', label: '关于' },
  { id: 'http-service', icon: 'monitor', label: 'HTTP 服务' }
]

// 使用 computed 实现双向绑定
const activeMenu = computed({
  get: () => props.activePage,
  set: (value) => emit('update:activePage', value)
})

// 全局快捷键页面的预填目标指令（从 AllCommands 导航过来时使用）
const shortcutAutoAddTarget = ref('')

// 自动打开的插件名称（合并外部传入和内部设置两个来源）
const localAutoOpenPluginName = ref('')

// 添加开发插件文件路径
const localAddDevPluginFilePath = ref('')

// 监听外部传入的 autoOpenPluginName prop
watch(
  () => props.autoOpenPluginName,
  (name) => {
    if (name) {
      localAutoOpenPluginName.value = name
    }
  },
  { immediate: true }
)

// 监听外部传入的 addDevPluginFilePath prop
watch(
  () => props.addDevPluginFilePath,
  (filePath) => {
    if (filePath) {
      localAddDevPluginFilePath.value = filePath
    }
  },
  { immediate: true }
)

// 处理 PluginCenter 消费完 autoOpenPluginName 后的清理
function handleAutoOpenConsumed(): void {
  localAutoOpenPluginName.value = ''
  emit('auto-open-consumed')
}

// 处理 PluginCenter 消费完 addDevPluginFilePath 后的清理
function handleAddDevConsumed(): void {
  localAddDevPluginFilePath.value = ''
  emit('add-dev-consumed')
}

// 处理子组件导航请求
function handleNavigate(page: string, params?: Record<string, string>): void {
  if (page === 'shortcuts' && params?.targetCommand) {
    shortcutAutoAddTarget.value = params.targetCommand
  }
  activeMenu.value = page
}

// 处理 PluginCenter 的导航请求
function handleNavigateFromPluginCenter(page: string, params?: Record<string, string>): void {
  if (page === 'install-plugin' && params?.filePath) {
    // 更新文件路径并切换到安装页面
    emit('update:installPluginFilePath', params.filePath)
    activeMenu.value = page
  }
}

// 插件安装成功后跳转到插件中心并打开详情
function handlePluginInstalled(pluginName: string): void {
  // 清空文件路径
  emit('update:installPluginFilePath', '')
  localAutoOpenPluginName.value = pluginName
  activeMenu.value = 'plugins'
}
</script>

<style scoped>
.settings-container {
  display: flex;
  height: 100%; /* 固定高度 */
  background: var(--bg-color);
  border-top: 1px solid var(--divider-color);
  -webkit-app-region: no-drag; /* 禁止拖动窗口 */
  user-select: none; /* 禁止选取文本 */
}

/* 左侧菜单 */
.settings-sidebar {
  width: 200px;
  border-right: 1px solid var(--divider-color);
  padding: 12px 8px;
  overflow-y: auto;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: all 0.2s;
  color: var(--text-color);
  border-radius: 8px;
}

.menu-item:last-child {
  margin-bottom: 0;
}

.menu-item:hover {
  background: var(--hover-bg);
}

.menu-item.active {
  background: var(--active-bg);
  color: var(--primary-color);
  font-weight: 500;
}

.menu-icon {
  margin-right: 10px;
  color: inherit;
}

.menu-label {
  font-size: 14px;
  font-weight: 500;
}

/* 右侧内容区 */
.settings-content {
  flex: 1;
  overflow: hidden; /* 去除滚动，交给各个子组件处理 */
}
.settings-sidebar::-webkit-scrollbar {
  width: 0px !important;
}
</style>
