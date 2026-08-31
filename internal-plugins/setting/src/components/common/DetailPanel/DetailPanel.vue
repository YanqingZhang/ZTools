<script setup lang="ts">
import { useEscapeHandler } from '@/composables'

defineProps<{
  title: string
}>()

const emit = defineEmits<{
  (e: 'back'): void
}>()

/**
 * 返回详情面板的上一级，并消费当前 ESC 事件。
 * @param _event 当前键盘事件
 * @returns 已消费 ESC 事件
 */
function handleEscape(_event: KeyboardEvent): boolean {
  emit('back')
  return true
}

// 详情面板作为低优先级兜底，嵌套弹窗和选择器会先处理 ESC。
useEscapeHandler(handleEscape, { priority: 50 })
</script>
<template>
  <!-- 覆盖内容区的详情面板（无遮罩） -->
  <div class="detail-panel">
    <div class="detail-topbar">
      <button class="icon-btn back-btn" aria-label="返回" title="返回" @click="emit('back')">
        <div class="i-z-back" style="font-size: 18px" />
      </button>
      <div class="topbar-title">{{ title }}</div>
      <div class="topbar-spacer"></div>
      <slot name="header-right" />
    </div>

    <div class="detail-scrollable">
      <slot />
    </div>
  </div>
</template>

<style>
/* 全局过渡动画类（供 Transition 组件使用） */

/* slide: 从右进入，向右离开（用于一级↔二级） */
.slide-enter-active {
  transition:
    transform 0.2s ease-out,
    opacity 0.15s ease;
}

.slide-leave-active {
  transition:
    transform 0.18s ease-in,
    opacity 0s;
}

.slide-enter-from {
  transform: translateX(100%);
  opacity: 0;
}

.slide-enter-to {
  transform: translateX(0);
  opacity: 1;
}

.slide-leave-from {
  transform: translateX(0);
  opacity: 1;
}

.slide-leave-to {
  transform: translateX(100%);
  opacity: 1;
}

/* slide-reverse: 从左进入，向左离开（用于二级↔三级） */
.slide-reverse-enter-active {
  transition:
    transform 0.2s ease-out,
    opacity 0.15s ease;
}

.slide-reverse-leave-active {
  transition:
    transform 0.18s ease-in,
    opacity 0s;
}

.slide-reverse-enter-from {
  transform: translateX(-100%);
  opacity: 0;
}

.slide-reverse-enter-to {
  transform: translateX(0);
  opacity: 1;
}

.slide-reverse-leave-from {
  transform: translateX(0);
  opacity: 1;
}

.slide-reverse-leave-to {
  transform: translateX(-100%);
  opacity: 1;
}
</style>

<style scoped>
/* 覆盖内容区的详情面板 */
.detail-panel {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  background: var(--bg-color);
}

.detail-topbar {
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid var(--divider-color);
}

.topbar-title {
  font-size: 14px;
  color: var(--text-secondary);
}

.topbar-spacer {
  flex: 1;
}

.detail-scrollable {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 图标按钮颜色样式 */
.back-btn {
  color: var(--text-color);
}

.back-btn:hover:not(:disabled) {
  background: var(--hover-bg);
  color: var(--primary-color);
}
</style>
