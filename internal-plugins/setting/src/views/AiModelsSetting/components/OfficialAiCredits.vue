<script setup lang="ts">
import { BaseDialog, useToast } from '@/components'
import type {
  OfficialAiCheckinStatus,
  OfficialAiCreditAccount,
  OfficialAiRechargeOrder
} from '@shared/aiProviderShared'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const { success, error, warning } = useToast()
const loadingCredits = ref(true)
const credits = ref<OfficialAiCreditAccount | null>(null)
const loadingCheckin = ref(true)
const checkingIn = ref(false)
const checkin = ref<OfficialAiCheckinStatus | null>(null)
const showRechargeDialog = ref(false)
const rechargeAmount = ref('10')
const creatingRechargeOrder = ref(false)
const pollingRechargeOrder = ref(false)
const rechargeOrder = ref<OfficialAiRechargeOrder | null>(null)
const rechargePaymentWindowClosed = ref(false)
const rechargePresets = ['5', '10', '20', '50', '100']
let rechargePollTimer: ReturnType<typeof setInterval> | null = null

/**
 * 根据当前充值订单生成用户可读状态。
 * @returns 随订单状态更新的展示文本
 */
const rechargeStatusText = computed(() => {
  switch (rechargeOrder.value?.status) {
    case 'crediting':
      return '支付成功，积分入账中'
    case 'paid_pending_credit':
      return '支付成功，正在重试入账'
    case 'credited':
      return '积分已到账'
    case 'amount_mismatch':
      return '支付金额异常，请联系客服'
    case 'failed':
      return '赞助处理失败，请联系客服'
    case 'expired':
      return '订单已过期'
    default:
      return '等待支付'
  }
})

/**
 * 将服务端积分数值格式化为固定两位小数。
 * @param value 服务端返回的积分数值文本
 * @returns 固定保留两位小数的积分文本
 */
function formatCreditAmount(value?: string): string {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00'
}

/**
 * 生成头部积分入口展示的余额文本。
 * @returns 加载状态或固定两位小数的积分余额
 */
const displayCreditBalance = computed(() =>
  loadingCredits.value ? '加载中' : formatCreditAmount(credits.value?.balance)
)

/**
 * 生成签到入口的紧凑展示文本。
 * @returns 根据活动和当日状态变化的签到文案
 */
const checkinButtonText = computed(() => {
  if (loadingCheckin.value) return '签到加载中'
  if (checkingIn.value) return '签到中...'
  if (checkin.value?.status === 'credited') return '今日已签到'
  if (checkin.value?.checkedIn) return '积分发放中'
  return `签到 +${formatCreditAmount(checkin.value?.campaign?.rewardAmount)}积分`
})

/**
 * 生成活动有效期和奖励说明。
 * @returns 可用于按钮悬浮提示的活动说明
 */
const checkinTitle = computed(() => {
  const campaign = checkin.value?.campaign
  if (!campaign) return '当前没有签到活动'
  return `每日签到赠送 ${formatCreditAmount(campaign.rewardAmount)} 积分，活动时间：${campaign.startDate} 至 ${campaign.endDate}`
})

onMounted(() => {
  void Promise.all([loadCredits(), loadCheckinStatus()])
})

onBeforeUnmount(() => {
  stopRechargePolling()
})

/**
 * 加载当前账号的官方 AI 积分余额。
 * @returns 积分加载完成后结束的 Promise
 */
async function loadCredits(): Promise<void> {
  loadingCredits.value = true
  try {
    const result = await window.ztools.internal.syncGetAccountCredits()
    credits.value = result.success && result.credits ? result.credits : null
  } catch (cause) {
    console.error('加载官方 AI 积分失败:', cause)
    credits.value = null
  } finally {
    loadingCredits.value = false
  }
}

/**
 * 加载 Server 按北京时间计算的当前签到活动和当日状态。
 * @returns 签到状态加载完成后结束的 Promise
 */
async function loadCheckinStatus(): Promise<void> {
  loadingCheckin.value = true
  try {
    const result = await window.ztools.internal.syncGetAICheckinStatus()
    checkin.value = result.success && result.checkin ? result.checkin : null
  } catch (cause) {
    console.error('加载官方 AI 签到状态失败:', cause)
    checkin.value = null
  } finally {
    loadingCheckin.value = false
  }
}

/**
 * 执行今日签到，并在积分到账后同步更新头部余额。
 * @returns 签到请求和余额刷新完成后结束的 Promise
 */
async function performCheckin(): Promise<void> {
  if (!checkin.value?.available || checkin.value.checkedIn || checkingIn.value) return
  checkingIn.value = true
  try {
    const result = await window.ztools.internal.syncAICheckin()
    if (!result.success || !result.checkin) throw new Error(result.error || '签到失败')
    checkin.value = result.checkin
    if (result.checkin.status === 'credited') {
      if (result.checkin.balance && credits.value) {
        credits.value = { ...credits.value, balance: result.checkin.balance }
      } else {
        await loadCredits()
      }
      success(
        `签到成功，获得 ${formatCreditAmount(result.checkin.rewardAmount || result.checkin.campaign?.rewardAmount)} 积分`
      )
    } else {
      warning('签到成功，积分正在发放中')
    }
  } catch (cause) {
    error(cause instanceof Error ? cause.message : '签到失败')
  } finally {
    checkingIn.value = false
  }
}

/**
 * 打开充值弹窗并恢复默认金额和初始状态。
 * @returns 无返回值
 */
function openRechargeDialog(): void {
  // 新订单开始前停止遗留轮询，避免旧订单覆盖新状态。
  stopRechargePolling()
  rechargeAmount.value = '10'
  rechargeOrder.value = null
  rechargePaymentWindowClosed.value = false
  showRechargeDialog.value = true
}

/**
 * 使用一个预设金额更新充值输入。
 * @param amount 人民币金额文本
 * @returns 无返回值
 */
function selectRechargeAmount(amount: string): void {
  rechargeAmount.value = amount
}

/**
 * 校验金额、创建服务端订单并使用默认浏览器打开爱发电支付页面。
 * @returns 订单创建与支付页面打开完成后结束的 Promise
 */
async function createRechargeOrder(): Promise<void> {
  const amount = rechargeAmount.value.trim()
  if (
    !/^(?:[1-9]\d{0,3}|10000)(?:\.\d{1,2})?$/.test(amount) ||
    Number(amount) < 5 ||
    Number(amount) > 10000
  ) {
    warning('赞助金额须为 5 至 10000 元，最多两位小数')
    return
  }

  try {
    creatingRechargeOrder.value = true
    const created = await window.ztools.internal.syncCreateAIRechargeOrder(amount)
    if (!created.success || !created.order?.paymentUrl) {
      throw new Error(created.error || '创建赞助订单失败')
    }

    // 保存可信支付链接，并立刻轮询服务端确认支付结果。
    rechargeOrder.value = created.order
    rechargePaymentWindowClosed.value = false
    startRechargePolling(created.order.id)
    const opened = await window.ztools.internal.syncOpenAIRechargeURL(created.order.paymentUrl)
    if (!opened.success) throw new Error(opened.error || '打开支付页面失败')
  } catch (cause) {
    error(cause instanceof Error ? cause.message : '创建赞助订单失败')
  } finally {
    creatingRechargeOrder.value = false
  }
}

/**
 * 在独立支付窗口中重新打开当前订单对应的爱发电支付页面。
 * @returns 支付页面打开完成后结束的 Promise
 */
async function reopenRechargePage(): Promise<void> {
  const paymentUrl = rechargeOrder.value?.paymentUrl
  if (!paymentUrl) return
  const result = await window.ztools.internal.syncOpenAIRechargeURL(paymentUrl)
  if (!result.success) error(result.error || '打开支付页面失败')
}

/**
 * 启动单订单轮询，并先立即读取一次状态。
 * @param orderId 服务端充值订单编号
 * @returns 无返回值
 */
function startRechargePolling(orderId: string): void {
  stopRechargePolling()
  void pollRechargeStatus(orderId)
  rechargePollTimer = setInterval(() => void pollRechargeStatus(orderId), 2500)
}

/**
 * 查询订单状态并在到账或终态时停止轮询。
 * @param orderId 服务端充值订单编号
 * @returns 本次状态查询完成后结束的 Promise
 */
async function pollRechargeStatus(orderId: string): Promise<void> {
  if (pollingRechargeOrder.value) return
  pollingRechargeOrder.value = true
  try {
    const result = await window.ztools.internal.syncGetAIRechargeOrder(orderId)
    if (!result.success || !result.order) throw new Error(result.error || '查询赞助状态失败')

    // 查询接口不重复下发支付链接，保留创建订单时得到的可信链接供用户重新打开。
    rechargeOrder.value = {
      ...result.order,
      paymentUrl: rechargeOrder.value?.paymentUrl
    }
    const paymentConfirmed = ['crediting', 'paid_pending_credit', 'credited'].includes(
      result.order.status
    )
    if (paymentConfirmed && !rechargePaymentWindowClosed.value) {
      const closed = await window.ztools.internal.syncCloseAIRechargeWindow()
      if (closed.success) {
        rechargePaymentWindowClosed.value = true
      } else {
        console.warn('关闭赞助窗口失败:', closed.error)
      }
    }
    if (result.order.status === 'credited') {
      // 到账后先停止后台活动，再刷新余额并关闭弹窗。
      stopRechargePolling()
      showRechargeDialog.value = false
      await loadCredits()
      success(`${result.order.creditAmount} 积分已到账`)
      return
    }
    if (['amount_mismatch', 'failed', 'expired'].includes(result.order.status)) {
      stopRechargePolling()
      error(rechargeStatusText.value)
    }
  } catch (cause) {
    // 临时网络错误保留轮询，用户无需重新发起已经支付的订单。
    console.error('查询赞助状态失败:', cause)
  } finally {
    pollingRechargeOrder.value = false
  }
}

/**
 * 停止当前充值订单的状态轮询。
 * @returns 无返回值
 */
function stopRechargePolling(): void {
  if (rechargePollTimer) clearInterval(rechargePollTimer)
  rechargePollTimer = null
}

/**
 * 关闭充值弹窗并清理当前轮询。
 * @returns 无返回值
 */
function closeRechargeDialog(): void {
  if (creatingRechargeOrder.value) return
  showRechargeDialog.value = false
  stopRechargePolling()
}
</script>

<template>
  <div class="official-credit-actions">
    <button
      v-if="checkin?.campaign && (checkin.available || checkin.checkedIn)"
      type="button"
      class="official-checkin-trigger"
      :class="{ completed: checkin.status === 'credited' }"
      :title="checkinTitle"
      :disabled="checkingIn || checkin.checkedIn"
      @click="performCheckin"
    >
      {{ checkinButtonText }}
    </button>
    <div class="official-credit-summary" aria-label="AI 积分余额">
      <span>余额</span>
      <span v-if="loadingCredits" class="official-credit-loading">加载中</span>
      <button
        v-else
        type="button"
        class="official-credit-trigger"
        title="赞助送积分"
        :aria-label="`AI 积分余额 ${displayCreditBalance}，赞助送积分`"
        @click="openRechargeDialog"
      >
        {{ displayCreditBalance }}
      </button>
      <span v-if="!loadingCredits">积分</span>
    </div>
  </div>

  <BaseDialog
    v-model:visible="showRechargeDialog"
    title="赞助送积分"
    subtitle="每赞助 1 元赠送 1 积分"
    max-width="440px"
    :close-on-overlay="!creatingRechargeOrder"
    @close="closeRechargeDialog"
  >
    <div v-if="!rechargeOrder" class="recharge-form">
      <div class="recharge-presets" aria-label="赞助金额">
        <button
          v-for="amount in rechargePresets"
          :key="amount"
          type="button"
          :class="{ active: rechargeAmount === amount }"
          @click="selectRechargeAmount(amount)"
        >
          {{ amount }} 元
        </button>
      </div>
      <label class="recharge-custom-field">
        <span>自定义金额</span>
        <div>
          <input
            v-model="rechargeAmount"
            type="text"
            inputmode="decimal"
            maxlength="8"
            placeholder="5 - 10000"
            @keyup.enter="createRechargeOrder"
          />
          <span>元</span>
        </div>
      </label>
      <div class="recharge-actions">
        <button
          type="button"
          class="dialog-button secondary"
          :disabled="creatingRechargeOrder"
          @click="closeRechargeDialog"
        >
          取消
        </button>
        <button
          type="button"
          class="dialog-button primary"
          :disabled="creatingRechargeOrder"
          @click="createRechargeOrder"
        >
          {{ creatingRechargeOrder ? '创建中...' : '前往支付' }}
        </button>
      </div>
    </div>
    <div v-else class="recharge-waiting">
      <div>
        <span>赞助金额</span>
        <strong>{{ rechargeOrder.amount }} 元</strong>
      </div>
      <p>{{ rechargeStatusText }}</p>
      <div class="recharge-actions">
        <button type="button" class="dialog-button secondary" @click="closeRechargeDialog">
          稍后查看
        </button>
        <button type="button" class="dialog-button primary" @click="reopenRechargePage">
          重新打开支付页
        </button>
      </div>
    </div>
  </BaseDialog>
</template>

<style scoped>
.official-credit-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.official-credit-summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.official-checkin-trigger {
  border: 1px solid color-mix(in srgb, var(--primary-color) 45%, var(--divider-color));
  border-radius: 999px;
  padding: 3px 8px;
  background: color-mix(in srgb, var(--primary-color) 8%, transparent);
  color: var(--primary-color);
  cursor: pointer;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
}

.official-checkin-trigger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--primary-color) 15%, transparent);
}

.official-checkin-trigger.completed,
.official-checkin-trigger:disabled {
  cursor: default;
  opacity: 0.68;
}

.official-credit-trigger,
.official-credit-loading {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--primary-color);
  font-size: 13px;
  font-weight: 700;
}

.official-credit-trigger {
  cursor: pointer;
}

.official-credit-trigger:hover,
.official-credit-trigger:focus-visible {
  outline: none;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.dialog-button {
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.recharge-form,
.recharge-waiting {
  display: grid;
  gap: 18px;
}

.recharge-presets {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.recharge-presets button {
  min-width: 0;
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  padding: 9px 4px;
  background: var(--control-bg);
  color: var(--text-color);
  cursor: pointer;
  font-size: 13px;
}

.recharge-presets button.active {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.recharge-custom-field {
  display: grid;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
}

.recharge-custom-field > div {
  display: flex;
  align-items: center;
  gap: 10px;
}

.recharge-custom-field input {
  min-width: 0;
  flex: 1;
  box-sizing: border-box;
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  outline: none;
  padding: 9px 10px;
  background: var(--control-bg);
  color: var(--text-color);
  font-size: 14px;
}

.recharge-custom-field input:focus {
  border-color: var(--primary-color);
}

.recharge-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.dialog-button {
  padding: 9px 16px;
  font-size: 13px;
}

.dialog-button.primary {
  background: var(--primary-color);
  color: var(--text-on-primary);
}

.dialog-button.secondary {
  background: var(--control-bg);
  color: var(--text-color);
}

.dialog-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.recharge-waiting > div:first-child {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  color: var(--text-secondary);
  font-size: 13px;
}

.recharge-waiting strong {
  color: var(--text-color);
  font-size: 20px;
}

.recharge-waiting p {
  margin: 0;
  border-top: 1px solid var(--divider-color);
  border-bottom: 1px solid var(--divider-color);
  padding: 14px 0;
  color: var(--primary-color);
  font-size: 13px;
  text-align: center;
}
</style>
