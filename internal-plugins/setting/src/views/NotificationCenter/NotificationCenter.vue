<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { DetailPanel, useToast } from '@/components'
import { jumpFunctionPluginMarketSetting } from '@/views/PluginMarketSetting/PluginMarketSetting'
import { useNotificationCenter, type NotificationItem } from '@/composables'

const router = useRouter()
const { warning, error: showError } = useToast()
const selectedAnnouncement = ref<NotificationItem | null>(null)
const {
  items,
  unreadCount,
  hasMore,
  loading,
  loadingMore,
  error,
  activeFilter,
  loadNotifications,
  loadMoreNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  archiveNotification
} = useNotificationCenter()

onMounted(() => {
  void loadNotifications(activeFilter.value)
  window.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown, true)
})

/**
 * 在公告详情打开时响应 Esc，并按二级页面返回规则关闭详情。
 * @param event 窗口键盘事件。
 * @returns 无返回值。
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !selectedAnnouncement.value) return
  event.stopPropagation()
  closeAnnouncement()
}

/**
 * 切换全部或未读消息列表。
 * @param filter 目标筛选条件。
 * @returns 无返回值。
 */
function changeFilter(filter: 'all' | 'unread'): void {
  if (activeFilter.value === filter && items.value.length > 0) return
  void loadNotifications(filter)
}

/**
 * 处理消息点击并执行对应的内部或外部跳转。
 * @param item 被点击的消息。
 * @returns 跳转处理完成后的 Promise。
 */
async function openNotification(item: NotificationItem): Promise<void> {
  if (!(await markNotificationRead(item))) return
  if (item.type === 'comment_reply') {
    const pluginName = stringPayload(item, 'pluginName')
    const commentId = numberPayload(item, 'commentId')
    if (!pluginName) {
      warning('该回复缺少插件信息')
      return
    }
    jumpFunctionPluginMarketSetting({
      type: 'detail',
      payload: pluginName,
      tab: 'comments',
      commentId
    })
    return
  }

  if (item.type === 'system_announcement') {
    selectedAnnouncement.value = item
    return
  }

  await executeNotificationAction(item)
}

/**
 * 执行公告或兼容消息中配置的跳转动作。
 * @param item 包含跳转参数的消息。
 * @returns 跳转处理完成后的 Promise。
 */
async function executeNotificationAction(item: NotificationItem): Promise<void> {
  const actionType = stringPayload(item, 'actionType')
  const actionValue = stringPayload(item, 'actionValue')
  if (!actionType || actionType === 'none' || !actionValue) return
  if (actionType === 'plugin') {
    jumpFunctionPluginMarketSetting({ type: 'detail', payload: actionValue })
    return
  }
  if (actionType === 'internal') {
    if (!actionValue.startsWith('/')) {
      warning('公告跳转地址无效')
      return
    }
    await router.replace(actionValue)
    return
  }
  if (actionType === 'external') {
    if (!actionValue.startsWith('https://')) {
      warning('公告外部地址无效')
      return
    }
    window.ztools.shellOpenExternal(actionValue)
  }
}

/**
 * 关闭系统公告详情并返回消息列表。
 * @returns 无返回值。
 */
function closeAnnouncement(): void {
  selectedAnnouncement.value = null
}

/**
 * 执行当前系统公告配置的后续操作。
 * @returns 跳转处理完成后的 Promise。
 */
async function openAnnouncementAction(): Promise<void> {
  if (!selectedAnnouncement.value) return
  await executeNotificationAction(selectedAnnouncement.value)
}

/**
 * 根据公告跳转类型生成清晰的按钮文案。
 * @param item 系统公告消息。
 * @returns 操作按钮文案；没有有效操作时返回空字符串。
 */
function announcementActionLabel(item: NotificationItem): string {
  const actionType = stringPayload(item, 'actionType')
  const actionValue = stringPayload(item, 'actionValue')
  if (!actionValue) return ''
  if (actionType === 'plugin') return '查看插件'
  if (actionType === 'internal') return '前往查看'
  if (actionType === 'external') return '打开链接'
  return ''
}

/**
 * 归档一条消息并阻止触发消息主体跳转。
 * @param item 需要归档的消息。
 * @returns 归档完成后的 Promise。
 */
async function archive(item: NotificationItem): Promise<void> {
  if (!(await archiveNotification(item))) {
    showError(error.value || '归档消息失败')
  }
}

/**
 * 将当前账号消息全部标记为已读。
 * @returns 操作完成后的 Promise。
 */
async function markAllRead(): Promise<void> {
  if (!(await markAllNotificationsRead())) {
    showError(error.value || '全部标记已读失败')
  }
}

/**
 * 读取字符串类型的消息业务参数。
 * @param item 消息对象。
 * @param key 参数名。
 * @returns 字符串参数；不存在时返回空字符串。
 */
function stringPayload(item: NotificationItem, key: string): string {
  const value = item.payload?.[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 读取数字类型的消息业务参数。
 * @param item 消息对象。
 * @param key 参数名。
 * @returns 数字参数；不存在时返回 0。
 */
function numberPayload(item: NotificationItem, key: string): number {
  return Number(item.payload?.[key] || 0)
}

/**
 * 格式化消息产生时间。
 * @param value 毫秒时间戳。
 * @returns 本地化时间文本。
 */
function formatTime(value: number): string {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * 格式化公告详情中的完整时间。
 * @param value 毫秒时间戳。
 * @returns 包含年份的本地化时间文本。
 */
function formatDetailTime(value: number): string {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <div class="notification-page">
    <Transition name="list-slide">
      <div v-show="!selectedAnnouncement" class="notification-list-page">
        <div class="notification-toolbar">
          <div class="notification-tabs" role="tablist" aria-label="消息筛选">
            <button
              class="tab-btn"
              :class="{ active: activeFilter === 'all' }"
              type="button"
              role="tab"
              :aria-selected="activeFilter === 'all'"
              @click="changeFilter('all')"
            >
              全部
            </button>
            <button
              class="tab-btn"
              :class="{ active: activeFilter === 'unread' }"
              type="button"
              role="tab"
              :aria-selected="activeFilter === 'unread'"
              @click="changeFilter('unread')"
            >
              未读<span v-if="unreadCount > 0" class="tab-count">
                {{ unreadCount > 99 ? '99+' : unreadCount }}
              </span>
            </button>
          </div>
          <button v-if="unreadCount > 0" class="mark-all-button" type="button" @click="markAllRead">
            <div class="i-z-check" />
            <span>全部已读</span>
          </button>
        </div>

        <div class="notification-content">
          <div v-if="loading" class="notification-state">正在加载消息...</div>
          <div v-else-if="error && items.length === 0" class="notification-state error-state">
            <span>{{ error }}</span>
            <button type="button" @click="loadNotifications(activeFilter)">重试</button>
          </div>
          <div v-else-if="items.length === 0" class="notification-state">
            <div class="i-z-bell empty-icon" />
            <span>{{ activeFilter === 'unread' ? '没有未读消息' : '暂时没有消息' }}</span>
          </div>
          <div v-else class="notification-list">
            <article
              v-for="item in items"
              :key="item.id"
              class="notification-item"
              :class="[{ unread: !item.read }, `level-${item.level}`]"
              tabindex="0"
              @click="openNotification(item)"
              @keydown.enter="openNotification(item)"
            >
              <div class="notification-icon">
                <div :class="item.type === 'comment_reply' ? 'i-z-message' : 'i-z-info'" />
              </div>
              <div class="notification-body">
                <div class="notification-title-row">
                  <strong>{{ item.title }}</strong>
                  <time>{{ formatTime(item.createdAt) }}</time>
                </div>
                <p>{{ item.content }}</p>
              </div>
              <span v-if="!item.read" class="unread-dot" aria-label="未读" />
              <button class="archive-button" type="button" title="归档" @click.stop="archive(item)">
                <div class="i-z-trash" />
              </button>
            </article>
            <button
              v-if="hasMore"
              class="load-more-button"
              :disabled="loadingMore"
              type="button"
              @click="loadMoreNotifications"
            >
              {{ loadingMore ? '加载中...' : '加载更多' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="slide">
      <DetailPanel v-if="selectedAnnouncement" title="系统公告" @back="closeAnnouncement">
        <article class="announcement-detail">
          <header class="announcement-detail-header">
            <div class="announcement-detail-icon" :class="`level-${selectedAnnouncement.level}`">
              <div class="i-z-info" />
            </div>
            <div class="announcement-detail-heading">
              <span class="announcement-detail-kind">
                {{ selectedAnnouncement.level === 'important' ? '重要公告' : '系统公告' }}
              </span>
              <h2>{{ selectedAnnouncement.title }}</h2>
              <time>{{ formatDetailTime(selectedAnnouncement.createdAt) }}</time>
            </div>
          </header>

          <div class="announcement-detail-content">{{ selectedAnnouncement.content }}</div>

          <footer
            v-if="announcementActionLabel(selectedAnnouncement)"
            class="announcement-detail-actions"
          >
            <button class="btn btn-primary" type="button" @click="openAnnouncementAction">
              <div class="i-z-play" />
              <span>{{ announcementActionLabel(selectedAnnouncement) }}</span>
            </button>
          </footer>
        </article>
      </DetailPanel>
    </Transition>
  </div>
</template>

<style scoped>
.notification-page {
  position: relative;
  box-sizing: border-box;
  height: 100%;
  overflow: hidden;
  background: var(--bg-color);
  color: var(--text-color);
}

.notification-list-page {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 20px;
  background: var(--bg-color);
  overflow: hidden;
}

.list-slide-enter-active {
  transition:
    transform 0.2s ease-out,
    opacity 0.15s ease;
}

.list-slide-leave-active {
  transition:
    transform 0.2s ease-in,
    opacity 0.15s ease;
}

.list-slide-enter-from {
  transform: translateX(-100%);
  opacity: 0;
}

.list-slide-enter-to {
  transform: translateX(0);
  opacity: 1;
}

.list-slide-leave-from {
  transform: translateX(0);
  opacity: 1;
}

.list-slide-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

.notification-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.mark-all-button,
.load-more-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  background: var(--card-bg, var(--bg-color));
  color: var(--text-color);
  cursor: pointer;
  padding: 8px 12px;
  font-size: 13px;
}

.notification-tabs {
  display: flex;
  gap: 6px;
  width: fit-content;
  border-radius: 8px;
  background: var(--control-bg);
  padding: 3px;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s;
}

.tab-btn:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.tab-btn.active {
  background: var(--active-bg);
  color: var(--primary-color);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.tab-count {
  min-width: 18px;
  border-radius: 10px;
  background: var(--control-bg);
  padding: 2px 6px;
  font-size: 11px;
  text-align: center;
}

.tab-btn.active .tab-count {
  background: var(--primary-light-bg);
  color: var(--primary-color);
}

.notification-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: 14px;
}

.notification-list {
  display: grid;
}

.notification-item {
  position: relative;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 8px 30px;
  align-items: start;
  gap: 12px;
  border-bottom: 1px solid var(--divider-color);
  cursor: pointer;
  padding: 15px 6px;
  outline: none;
}

.notification-item:hover,
.notification-item:focus-visible {
  background: var(--hover-bg);
}

.notification-item.unread strong {
  font-weight: 650;
}

.notification-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: var(--active-bg);
  color: var(--primary-color);
  font-size: 18px;
}

.notification-item.level-warning .notification-icon,
.notification-item.level-important .notification-icon {
  color: var(--warning-color);
  background: color-mix(in srgb, var(--warning-color) 12%, transparent);
}

.notification-body {
  min-width: 0;
}

.notification-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
}

.notification-title-row strong {
  overflow-wrap: anywhere;
  font-size: 14px;
}

.notification-title-row time {
  flex: none;
  color: var(--text-secondary);
  font-size: 11px;
}

.notification-body p {
  display: -webkit-box;
  overflow: hidden;
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.unread-dot {
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--primary-color);
}

.archive-button {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
}

.notification-item:hover .archive-button,
.archive-button:focus-visible {
  opacity: 1;
}

.archive-button:hover {
  background: color-mix(in srgb, var(--danger-color) 10%, transparent);
  color: var(--danger-color);
}

.notification-state {
  height: 100%;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 13px;
}

.notification-state .empty-icon {
  font-size: 38px;
  opacity: 0.5;
}

.notification-state button {
  border: 0;
  background: transparent;
  color: var(--primary-color);
  cursor: pointer;
}

.error-state {
  color: var(--danger-color);
}

.load-more-button {
  width: 120px;
  margin: 16px auto;
}

.announcement-detail {
  box-sizing: border-box;
  width: min(100%, 780px);
  margin: 0 auto;
  padding: 36px 34px 48px;
  color: var(--text-color);
}

.announcement-detail-header {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--divider-color);
}

.announcement-detail-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: var(--active-bg);
  color: var(--primary-color);
  font-size: 21px;
}

.announcement-detail-icon.level-warning,
.announcement-detail-icon.level-important {
  color: var(--warning-color);
  background: color-mix(in srgb, var(--warning-color) 12%, transparent);
}

.announcement-detail-heading {
  min-width: 0;
}

.announcement-detail-kind {
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 600;
}

.announcement-detail-heading h2 {
  margin: 7px 0 9px;
  overflow-wrap: anywhere;
  font-size: 22px;
  line-height: 1.4;
  letter-spacing: 0;
}

.announcement-detail-heading time {
  color: var(--text-secondary);
  font-size: 12px;
}

.announcement-detail-content {
  padding: 28px 0;
  overflow-wrap: anywhere;
  color: var(--text-color);
  font-size: 14px;
  line-height: 1.9;
  white-space: pre-wrap;
}

.announcement-detail-actions {
  display: flex;
  justify-content: flex-start;
  padding-top: 4px;
}

.announcement-detail-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

@media (max-width: 720px) {
  .announcement-detail {
    padding: 28px 22px 40px;
  }

  .announcement-detail-heading h2 {
    font-size: 19px;
  }
}
</style>
