import { ipcMain } from 'electron'
import aiProviderService from '../../core/aiProviderService.js'
import officialAIService from '../../core/officialAIService.js'
import type {
  AiProviderInput,
  AiProviderMutationResult,
  AiProviderStore,
  AiRemoteModel,
  OfficialAiProviderStatus
} from '../../../shared/aiProviderShared.js'

/**
 * AI 供应商管理 API，供主渲染进程和内置设置插件复用。
 */
class AiModelsAPI {
  /**
   * 初始化 AI 供应商管理 IPC。
   * @returns 无返回值
   */
  public init(): void {
    this.setupIPC()
  }

  /**
   * 注册主渲染进程使用的 AI 供应商管理通道。
   * @returns 无返回值
   */
  private setupIPC(): void {
    ipcMain.handle('ai-providers:get-all', () => this.getAllProviders())
    ipcMain.handle('ai-providers:get-official', () => this.getOfficialProvider())
    ipcMain.handle('ai-providers:add', (_event, provider: AiProviderInput) =>
      this.addProvider(provider)
    )
    ipcMain.handle('ai-providers:update', (_event, provider: AiProviderInput) =>
      this.updateProvider(provider)
    )
    ipcMain.handle('ai-providers:delete', (_event, providerId: string) =>
      this.deleteProvider(providerId)
    )
    ipcMain.handle('ai-providers:set-enabled', (_event, providerId: string, enabled: boolean) =>
      this.setProviderEnabled(providerId, enabled)
    )
    ipcMain.handle('ai-providers:fetch-models', (_event, apiUrl: string, apiKey: string) =>
      this.fetchModels(apiUrl, apiKey)
    )
  }

  /**
   * 获取完整的 AI 供应商配置。
   * @returns 当前供应商文档
   */
  public getAllProviders(): AiProviderStore {
    return aiProviderService.getStore()
  }

  /**
   * 获取只读的 ZTools 官方模型及当前登录状态。
   * @returns 官方供应商状态
   */
  public async getOfficialProvider(): Promise<OfficialAiProviderStatus> {
    return officialAIService.getProviderStatus()
  }

  /**
   * 添加一个 AI 供应商。
   * @param provider 供应商连接信息和已选模型
   * @returns 操作结果及最新供应商文档
   */
  public addProvider(provider: AiProviderInput): AiProviderMutationResult {
    return aiProviderService.addProvider(provider)
  }

  /**
   * 更新一个 AI 供应商。
   * @param provider 带内部 ID 的供应商配置
   * @returns 操作结果及最新供应商文档
   */
  public updateProvider(provider: AiProviderInput): AiProviderMutationResult {
    return aiProviderService.updateProvider(provider)
  }

  /**
   * 删除供应商及其已选模型。
   * @param providerId 供应商内部 ID
   * @returns 操作结果及最新供应商文档
   */
  public deleteProvider(providerId: string): AiProviderMutationResult {
    return aiProviderService.deleteProvider(providerId)
  }

  /**
   * 开启或关闭指定 AI 供应商。
   * @param providerId 供应商内部 ID
   * @param enabled 是否允许插件发现和调用该供应商
   * @returns 操作结果及最新供应商文档
   */
  public setProviderEnabled(providerId: string, enabled: boolean): AiProviderMutationResult {
    return aiProviderService.setProviderEnabled(providerId, enabled)
  }

  /**
   * 拉取 OpenAI 兼容供应商公开的模型列表。
   * @param apiUrl 供应商接口基础地址
   * @param apiKey 供应商 API 密钥
   * @returns 远端模型摘要列表
   * @throws 供应商拒绝请求、超时或返回异常时抛出错误
   */
  public async fetchModels(apiUrl: string, apiKey: string): Promise<AiRemoteModel[]> {
    return aiProviderService.fetchRemoteModels(apiUrl, apiKey)
  }
}

export default new AiModelsAPI()
