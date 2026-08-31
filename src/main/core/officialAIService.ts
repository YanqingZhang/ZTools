import {
  loadOfficialAccountSession,
  refreshOfficialAccountTokens
} from './account/officialAccountService.js'
import { OFFICIAL_SYNC_SERVER_URL } from '../../shared/syncServerUrl.js'
import {
  DEFAULT_AI_CONTEXT_WINDOW,
  type AiInputModality,
  type AiModelChoice,
  type AiProvider,
  type AiProviderModel,
  type AiReasoningCapability,
  type AiReasoningEffort,
  type AiTemperatureCapability,
  type OfficialAiModel,
  type OfficialAiModelCatalog,
  type OfficialAiProviderStatus,
  type OfficialAiCreditAccount,
  type OfficialAiCheckinStatus,
  type OfficialAiRechargeOrder
} from '../../shared/aiProviderShared.js'

const OFFICIAL_PROVIDER_ID = 'ztools-official'
const OFFICIAL_PROVIDER_NAME = 'ZTools 官方模型'
const OFFICIAL_MODEL_REF_PREFIX = 'official:'
const CATALOG_CACHE_TTL = 5 * 60 * 1000

/**
 * 生成与本地供应商一致的插件公开模型 ID。
 * @param providerName 供应商展示名称
 * @param modelId 远端模型 ID
 * @returns 格式为“供应商 - 模型 ID”的公开值
 */
function buildOfficialModelPublicId(providerName: string, modelId: string): string {
  return `${providerName} - ${modelId}`
}

/** 官方模型调用所需的内存供应商和模型。 */
export interface ResolvedOfficialAiModel {
  provider: AiProvider
  model: AiProviderModel
}

/**
 * 将官方 WebSocket 地址转换为 HTTP API 地址。
 * @param serverUrl 官方同步服务地址
 * @returns 对应的 HTTP API 地址
 */
function syncServerUrlToHttp(serverUrl: string): string {
  return serverUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
}

/**
 * 读取 JWT 过期时间并判断是否应提前刷新。
 * @param token 当前官方账号访问令牌
 * @returns 无法解析或将在一分钟内过期时返回 true
 */
function shouldRefreshToken(token: string): boolean {
  try {
    const payload = token.split('.')[1]
    if (!payload) return true
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as {
      exp?: number
    }
    return !decoded.exp || decoded.exp * 1000 <= Date.now() + 60_000
  } catch {
    return true
  }
}

/**
 * 把服务端官方模型能力转换为宿主内部模型配置。
 * @param model 服务端官方模型
 * @returns 可交给现有 OpenAI Chat 适配器的模型配置
 */
export function toProviderModel(model: OfficialAiModel): AiProviderModel {
  const effortMap: Partial<Record<AiReasoningEffort, string | null>> = {}
  for (const effort of model.capabilities.reasoning.efforts) {
    const configured = model.capabilities.reasoning.effortMappings?.[effort.id]
    effortMap[effort.id] = configured === undefined ? effort.id : configured
  }
  const reasoning: AiReasoningCapability = model.capabilities.reasoning.supported
    ? {
        protocol: model.capabilities.reasoning.requestMode || 'openai-compatible',
        efforts: effortMap,
        defaultEffort: model.capabilities.reasoning.defaultEffort,
        responseField: model.capabilities.reasoning.responseField || 'reasoning_content'
      }
    : false
  const temperature: AiTemperatureCapability =
    model.capabilities.temperature?.mode === 'fixed'
      ? { mode: 'fixed', value: model.capabilities.temperature.value }
      : model.capabilities.temperature?.mode === 'range'
        ? {
            mode: 'range',
            min: model.capabilities.temperature.min,
            max: model.capabilities.temperature.max,
            default: model.capabilities.temperature.default
          }
        : false
  const modalities = model.capabilities.inputModalities.filter(
    (item): item is AiInputModality => item === 'text' || item === 'image'
  )
  return {
    ref: `${OFFICIAL_MODEL_REF_PREFIX}${model.id}`,
    modelId: model.id,
    icon: model.icon,
    description: `${model.family || 'GLM'} · ZTools 官方 AI`,
    contextWindow: model.capabilities.contextWindow || DEFAULT_AI_CONTEXT_WINDOW,
    inputModalities: modalities.length ? modalities : ['text'],
    reasoning,
    temperature
  }
}

/**
 * 管理官方模型目录、登录凭据和只读虚拟供应商。
 */
class OfficialAIService {
  private catalogCache: { value: OfficialAiModelCatalog; expiresAt: number } | null = null

  /**
   * 获取官方模型目录，并使用短时缓存降低设置页和插件选择器请求频率。
   * @param force 是否跳过当前缓存
   * @returns 服务端当前启用的官方模型目录
   * @throws 官方模型接口不可访问或响应格式无效时抛出错误
   */
  public async getCatalog(force = false): Promise<OfficialAiModelCatalog> {
    if (process.env.ZTOOLS_E2E === '1') return this.e2eCatalog()
    if (!force && this.catalogCache && this.catalogCache.expiresAt > Date.now()) {
      return this.catalogCache.value
    }
    const response = await fetch(
      `${syncServerUrlToHttp(OFFICIAL_SYNC_SERVER_URL)}/api/ai/official/models`,
      { headers: { Accept: 'application/json' } }
    )
    const data = (await response.json()) as OfficialAiModelCatalog & { error?: string }
    if (!response.ok || !data.provider || !Array.isArray(data.models)) {
      throw new Error(data.error || '获取 ZTools 官方模型失败')
    }
    const catalog = { ...data, models: data.models.filter((model) => model.enabled) }
    this.catalogCache = { value: catalog, expiresAt: Date.now() + CATALOG_CACHE_TTL }
    return catalog
  }

  /**
   * 获取设置页展示的官方模型状态。
   * @returns 登录状态和公开模型目录
   */
  public async getProviderStatus(): Promise<OfficialAiProviderStatus> {
    const [session, catalog] = await Promise.all([loadOfficialAccountSession(), this.getCatalog()])
    return { loggedIn: Boolean(session?.token), catalog }
  }

  /**
   * 获取当前登录账号的官方 AI 积分，并在访问令牌失效时刷新后重试一次。
   * @returns 当前积分账户
   * @throws 未登录、刷新失败或服务端拒绝请求时抛出错误
   */
  public async getCredits(): Promise<OfficialAiCreditAccount> {
    if (process.env.ZTOOLS_E2E === '1') {
      return {
        balance: '128',
        totalRecharged: '128',
        syncedAt: Date.now(),
        provisioned: false,
        syncStatus: 'local'
      }
    }
    return this.requestAuthenticated<OfficialAiCreditAccount>(
      '/api/account/credits',
      { method: 'GET' },
      '获取 AI 积分失败'
    )
  }

  /**
   * 获取当前账号今天的官方 AI 签到状态和活动配置。
   * @returns Server 按北京时间计算的签到状态
   * @throws 未登录、刷新失败或服务端拒绝请求时抛出错误
   */
  public async getCheckinStatus(): Promise<OfficialAiCheckinStatus> {
    if (process.env.ZTOOLS_E2E === '1') return this.e2eCheckinStatus(false)
    return this.requestAuthenticated<OfficialAiCheckinStatus>(
      '/api/account/credits/check-in',
      { method: 'GET' },
      '获取签到状态失败'
    )
  }

  /**
   * 为当前账号执行今天的官方 AI 签到。
   * @returns 最新签到状态及到账后的积分余额
   * @throws 未登录、活动不可用或服务端签到失败时抛出错误
   */
  public async checkin(): Promise<OfficialAiCheckinStatus> {
    if (process.env.ZTOOLS_E2E === '1') return this.e2eCheckinStatus(true)
    return this.requestAuthenticated<OfficialAiCheckinStatus>(
      '/api/account/credits/check-in',
      { method: 'POST' },
      '签到失败'
    )
  }

  /**
   * 创建一笔人民币与积分一比一兑换的爱发电充值订单。
   * @param amount 用户选择的人民币金额
   * @returns 可打开收银台的服务端订单
   * @throws 未登录、金额无效或服务端创建失败时抛出错误
   */
  public async createRechargeOrder(amount: string): Promise<OfficialAiRechargeOrder> {
    if (process.env.ZTOOLS_E2E === '1') return this.e2eRechargeOrder(amount, 'pending')
    return this.requestAuthenticated<OfficialAiRechargeOrder>(
      '/api/account/credits/recharge-orders',
      {
        method: 'POST',
        body: JSON.stringify({ amount }),
        headers: { 'Content-Type': 'application/json' }
      },
      '创建赞助订单失败'
    )
  }

  /**
   * 查询当前账号拥有的一笔充值订单。
   * @param orderId 服务端生成的充值订单编号
   * @returns 最新支付和积分到账状态
   * @throws 未登录、订单不存在或查询失败时抛出错误
   */
  public async getRechargeOrder(orderId: string): Promise<OfficialAiRechargeOrder> {
    const normalized = orderId.trim()
    if (!/^AI[a-f0-9]{32}$/i.test(normalized)) throw new Error('赞助订单编号无效')
    if (process.env.ZTOOLS_E2E === '1') return this.e2eRechargeOrder('10', 'credited')
    return this.requestAuthenticated<OfficialAiRechargeOrder>(
      `/api/account/credits/recharge-orders/${encodeURIComponent(normalized)}`,
      { method: 'GET' },
      '查询赞助订单失败'
    )
  }

  /**
   * 获取插件可发现的官方模型，未登录时不向插件暴露。
   * @returns 当前账号可使用的官方模型选择项
   */
  public async getModelChoices(): Promise<AiModelChoice[]> {
    const session = await this.loadUsableSession()
    if (!session?.token) return []
    const catalog = await this.getCatalog()
    return catalog.models.map((item) => {
      const model = toProviderModel(item)
      return {
        id: buildOfficialModelPublicId(catalog.provider.name || OFFICIAL_PROVIDER_NAME, item.id),
        value: model.ref,
        label: buildOfficialModelPublicId(catalog.provider.name || OFFICIAL_PROVIDER_NAME, item.id),
        providerId: OFFICIAL_PROVIDER_ID,
        providerLabel: catalog.provider.name || OFFICIAL_PROVIDER_NAME,
        modelId: item.id,
        description: model.description || '',
        icon: model.icon || '',
        cost: 0,
        contextWindow: model.contextWindow || DEFAULT_AI_CONTEXT_WINDOW,
        inputModalities: model.inputModalities || ['text'],
        temperature: model.temperature,
        reasoning: item.capabilities.reasoning.supported
          ? {
              efforts: item.capabilities.reasoning.efforts,
              defaultEffort: item.capabilities.reasoning.defaultEffort
            }
          : undefined
      }
    })
  }

  /**
   * 判断选择值是否明确指向官方供应商。
   * @param modelRef 插件提交的模型选择值
   * @returns 是否为官方稳定 ID 或官方公开 ID
   */
  public isOfficialReference(modelRef?: string): boolean {
    return Boolean(
      modelRef?.startsWith(OFFICIAL_MODEL_REF_PREFIX) ||
      modelRef?.startsWith(`${OFFICIAL_PROVIDER_NAME} - `)
    )
  }

  /**
   * 将官方选择值解析为只存在于内存中的调用配置。
   * @param modelRef 插件选择值；缺省时选择首个官方模型
   * @returns 官方调用配置；未登录或未匹配时返回 null
   */
  public async resolveModel(modelRef?: string): Promise<ResolvedOfficialAiModel | null> {
    const session = await this.loadUsableSession()
    if (!session?.token) return null
    const catalog = await this.getCatalog()
    const requested = modelRef?.trim()
    const model = requested
      ? catalog.models.find(
          (item) =>
            `${OFFICIAL_MODEL_REF_PREFIX}${item.id}` === requested ||
            buildOfficialModelPublicId(catalog.provider.name || OFFICIAL_PROVIDER_NAME, item.id) ===
              requested ||
            item.id === requested
        )
      : catalog.models[0]
    if (!model) return null
    return {
      provider: {
        id: OFFICIAL_PROVIDER_ID,
        name: catalog.provider.name || OFFICIAL_PROVIDER_NAME,
        apiUrl: `${syncServerUrlToHttp(OFFICIAL_SYNC_SERVER_URL)}/api/ai/official/v1`,
        apiKey: session.token,
        apiFormat: 'openai-chat',
        enabled: true,
        selectedModels: [toProviderModel(model)]
      },
      model: toProviderModel(model)
    }
  }

  /**
   * 加载可用于模型调用的账号会话，并在 JWT 即将过期时主动刷新。
   * @returns 当前可用会话；未登录或刷新失败时返回 null
   */
  private async loadUsableSession() {
    const session = await loadOfficialAccountSession()
    if (!session?.token || !shouldRefreshToken(session.token) || !session.refreshToken)
      return session
    const refreshed = await refreshOfficialAccountTokens(session.refreshToken)
    return refreshed.status === 'refreshed' || refreshed.status === 'reused'
      ? refreshed.session
      : null
  }

  /**
   * 使用官方账号访问需要登录的 Server API，并在 401 时刷新令牌后重试一次。
   * @param path 相对于官方 Server 的 API 路径
   * @param init 请求方法、请求体和附加请求头
   * @param fallbackError 服务端没有返回错误说明时使用的提示
   * @returns 服务端解析后的 JSON 数据
   * @throws 未登录、刷新失败、网络异常或非成功响应时抛出错误
   */
  private async requestAuthenticated<T>(
    path: string,
    init: RequestInit,
    fallbackError: string
  ): Promise<T> {
    let session = await this.loadUsableSession()
    if (!session?.token) throw new Error('未登录')
    const endpoint = `${syncServerUrlToHttp(OFFICIAL_SYNC_SERVER_URL)}${path}`
    const request = (token: string): Promise<Response> =>
      fetch(endpoint, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...init.headers,
          Authorization: `Bearer ${token}`
        }
      })
    let response = await request(session.token)
    if (response.status === 401 && session.refreshToken) {
      // 只在认证失败时刷新一次，避免失败请求形成重试循环。
      const refreshed = await refreshOfficialAccountTokens(session.refreshToken)
      if (refreshed.status === 'refreshed' || refreshed.status === 'reused') {
        session = refreshed.session
        response = await request(session.token)
      }
    }
    const data = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(data.error || fallbackError)
    return data
  }

  /**
   * 返回完全隔离于线上服务的 E2E 官方模型目录。
   * @returns E2E 固定官方模型目录
   */
  private e2eCatalog(): OfficialAiModelCatalog {
    return {
      provider: { id: OFFICIAL_PROVIDER_ID, name: OFFICIAL_PROVIDER_NAME },
      models: [
        {
          id: 'glm-5.3',
          choiceId: 'official:glm-5.3',
          name: 'GLM-5.3',
          family: 'GLM',
          enabled: true,
          capabilities: {
            chat: true,
            tools: true,
            stream: true,
            contextWindow: 131072,
            inputModalities: ['text'],
            reasoning: {
              supported: true,
              requestMode: 'openai-compatible',
              efforts: [
                { id: 'high', label: '高' },
                { id: 'max', label: '最高' }
              ],
              effortMappings: { high: 'high', max: 'max' },
              defaultEffort: 'high',
              responseField: 'reasoning_content'
            }
          },
          pricing: { unit: 'credits_per_million_tokens', input: '0', output: '0', cacheRead: '0' }
        }
      ]
    }
  }

  /**
   * 返回完全隔离于线上支付服务的 E2E 充值订单。
   * @param amount 模拟人民币充值金额
   * @param status 模拟订单状态
   * @returns E2E 固定充值订单
   */
  private e2eRechargeOrder(
    amount: string,
    status: OfficialAiRechargeOrder['status']
  ): OfficialAiRechargeOrder {
    const now = Date.now()
    return {
      id: 'AI0123456789abcdef0123456789abcdef',
      amount,
      creditAmount: amount,
      status,
      paymentUrl: `https://ifdian.net/order/create?user_id=b49700e209c011f1869452540025c377&fr=afcom&custom_price=${encodeURIComponent(amount)}&month=1&custom_order_id=AI0123456789abcdef0123456789abcdef`,
      expiresAt: now + 60 * 60 * 1000,
      paidAt: status === 'credited' ? now : undefined,
      creditedAt: status === 'credited' ? now : undefined,
      createdAt: now,
      updatedAt: now
    }
  }

  /**
   * 返回完全隔离于线上服务的 E2E 每日签到状态。
   * @param checkedIn 是否模拟已经完成签到
   * @returns E2E 固定签到活动和状态
   */
  private e2eCheckinStatus(checkedIn: boolean): OfficialAiCheckinStatus {
    return {
      available: true,
      serverDate: '2026-08-28',
      campaign: {
        id: 1,
        name: '每日签到',
        rewardAmount: '1',
        startDate: '2026-08-01',
        endDate: '2026-09-30',
        enabled: true,
        status: 'active'
      },
      checkedIn,
      status: checkedIn ? 'credited' : undefined,
      rewardAmount: checkedIn ? '1' : undefined,
      creditedAt: checkedIn ? Date.now() : undefined,
      balance: checkedIn ? '129' : undefined
    }
  }
}

export default new OfficialAIService()
