<template>
  <div class="startup-dialog-window" tabindex="0" @keydown="handleKeydown">
    <div class="header window-drag-region">
      <img :src="logo" class="header-icon" draggable="false" />
      <div class="header-info">
        <div class="title">检测到旧版本 ZTools 数据</div>
        <div class="subtitle">ZTools 3.0 数据初始化</div>
      </div>
    </div>

    <main class="content">
      <div class="message">
        <p>选择要从 ZTools 2.x 迁移的数据范围。</p>
      </div>

      <div class="mode-options" role="radiogroup" aria-label="迁移模式">
        <label class="mode-option" :class="{ selected: mode === 'full' }">
          <input v-model="mode" type="radio" value="full" :disabled="isImporting" />
          <span class="mode-copy">
            <span class="mode-title">完整迁移 <span class="recommended">推荐</span></span>
            <span class="mode-description"
              >迁移设置、插件数据、快捷键、固定项、历史和插件行为配置。</span
            >
          </span>
        </label>

        <label class="mode-option" :class="{ selected: mode === 'compact' }">
          <input v-model="mode" type="radio" value="compact" :disabled="isImporting" />
          <span class="mode-copy">
            <span class="mode-title">精简迁移</span>
            <span class="mode-description">只迁移通用设置、插件安装与私有数据、AI 模型。</span>
          </span>
        </label>
      </div>

      <div class="migration-details">
        <div class="details-title">{{ mode === 'full' ? '完整迁移内容' : '精简迁移内容' }}</div>
        <ul v-if="mode === 'full'">
          <li>通用设置、插件安装状态、插件文件与私有数据、AI 模型</li>
          <li>固定指令、超级面板布局、本地启动项、快捷键和指令别名</li>
          <li>使用历史、推荐排序、搜索偏好和上次匹配状态</li>
          <li>插件自动启动、自动分离、退出关闭、mainPush 和窗口尺寸</li>
          <li>开发插件项目注册表和 MCP 插件权限</li>
        </ul>
        <ul v-else>
          <li>通用设置与界面偏好</li>
          <li>插件安装清单、禁用状态、插件文件、私有数据和附件</li>
          <li>AI 模型配置</li>
        </ul>
        <p class="excluded">不迁移同步账号、服务密钥、可重建缓存和浏览器会话。旧数据不会被删除。</p>
      </div>
    </main>

    <footer class="footer">
      <button class="btn cancel" :disabled="isImporting" @click="chooseFresh">全新开始</button>
      <button class="btn confirm" :disabled="isImporting" @click="chooseImport">
        <span v-if="isImporting" class="loading-spinner"></span>
        <span>{{ isImporting ? '导入中...' : '导入旧数据' }}</span>
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import logo from '../../assets/logo.png'

const isImporting = ref(false)
const mode = ref<'full' | 'compact'>('full')

function waitNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

async function chooseImport(): Promise<void> {
  if (isImporting.value) return
  isImporting.value = true
  await waitNextFrame()
  window.electron?.ipcRenderer.send('legacy-import:choose', { action: 'import', mode: mode.value })
}

function chooseFresh(): void {
  if (isImporting.value) return
  window.electron?.ipcRenderer.send('legacy-import:choose', { action: 'fresh' })
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    chooseImport()
  } else if (event.key === 'Escape') {
    chooseFresh()
  }
}

onMounted(() => {
  document.querySelector<HTMLElement>('.startup-dialog-window')?.focus()
})
</script>

<style src="../startupDialog.css"></style>
<style scoped>
.content {
  overflow-y: auto;
}

.mode-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 14px;
}

.mode-option {
  min-height: 94px;
  padding: 14px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  cursor: pointer;
  box-sizing: border-box;
}

.mode-option.selected {
  border-color: #2563eb;
  background: rgba(37, 99, 235, 0.07);
}

.mode-option input {
  margin: 3px 0 0;
}

.mode-copy,
.mode-title,
.mode-description {
  display: block;
}

.mode-title {
  font-size: 14px;
  font-weight: 600;
}

.recommended {
  margin-left: 4px;
  color: #2563eb;
  font-size: 12px;
  font-weight: 500;
}

.mode-description {
  margin-top: 6px;
  color: #666;
  font-size: 12px;
  line-height: 1.5;
}

.migration-details {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  font-size: 12px;
  line-height: 1.55;
}

.details-title {
  font-weight: 600;
}

.migration-details ul {
  margin: 8px 0 0;
  padding-left: 18px;
}

.migration-details li + li {
  margin-top: 3px;
}

.excluded {
  margin: 10px 0 0;
  color: #777;
}

@media (prefers-color-scheme: dark) {
  .mode-option {
    border-color: rgba(255, 255, 255, 0.14);
  }

  .mode-option.selected {
    border-color: #60a5fa;
    background: rgba(96, 165, 250, 0.1);
  }

  .recommended {
    color: #60a5fa;
  }

  .mode-description,
  .excluded {
    color: #aaa;
  }

  .migration-details {
    border-top-color: rgba(255, 255, 255, 0.08);
  }
}
</style>
