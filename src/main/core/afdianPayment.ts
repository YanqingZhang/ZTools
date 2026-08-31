const AFDIAN_CHECKOUT_HOST = 'ifdian.net'
const AFDIAN_CHECKOUT_PATH = '/order/create'

/**
 * 支付方式异步渲染脚本：展开“更多支付”后默认选中微信。
 * 仅操作爱发电收银台自身的 DOM，不读取或写入 ZTools 数据。
 */
export const AFDIAN_PAYMENT_SELECT_WECHAT_SCRIPT = `
(() => {
  let openedMorePayments = false

  const selectWechat = () => {
    const wechat = document.querySelector('.vm-icon-pay.wpy:not(.disable)')
    if (wechat instanceof HTMLElement) {
      if (!wechat.classList.contains('on')) wechat.click()
      // click 触发 Vue 状态更新是异步的，确认 DOM 已反映选中状态后再结束观察。
      return wechat.classList.contains('on')
    }

    // 登录状态下微信可能被收进“更多支付”，先展开菜单再等待微信节点渲染。
    if (!openedMorePayments) {
      const morePayments = document.querySelector('.vm-icon-pay-group .item')
      if (morePayments instanceof HTMLElement) {
        openedMorePayments = true
        morePayments.click()
      }
    }
    return false
  }

  const observer = new MutationObserver(() => {
    if (selectWechat()) observer.disconnect()
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  })
  if (selectWechat()) observer.disconnect()
  window.setTimeout(() => observer.disconnect(), 15000)
})()
`

/**
 * 校验仅供官方 AI 充值使用的爱发电收银台链接。
 * @param value 服务端返回的待打开链接
 * @returns 链接是否满足固定域名、路径和订单参数约束
 */
export function isAllowedAfdianCheckoutURL(value: string): boolean {
  try {
    const parsed = new URL(value)
    const amount = parsed.searchParams.get('custom_price') || ''
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === AFDIAN_CHECKOUT_HOST &&
      parsed.port === '' &&
      parsed.pathname === AFDIAN_CHECKOUT_PATH &&
      parsed.username === '' &&
      parsed.password === '' &&
      /^[a-f0-9]{32}$/i.test(parsed.searchParams.get('user_id') || '') &&
      parsed.searchParams.get('fr') === 'afcom' &&
      parsed.searchParams.get('month') === '1' &&
      /^AI[a-f0-9]{32}$/i.test(parsed.searchParams.get('custom_order_id') || '') &&
      /^(?:[1-9]\d{0,3}|10000)(?:\.\d{1,2})?$/.test(amount) &&
      Number(amount) >= 5 &&
      Number(amount) <= 10000
    )
  } catch {
    return false
  }
}
