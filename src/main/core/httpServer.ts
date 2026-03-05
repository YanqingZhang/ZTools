import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { randomBytes } from 'crypto'
import windowManager from '../managers/windowManager'
import databaseAPI from '../api/shared/database'

interface HttpServerConfig {
  enabled: boolean
  port: number
  apiKey: string
}

interface ApiResponse {
  code: number
  message: string
  data?: unknown
}

const DB_KEY = 'settings-http-server'
const DEFAULT_PORT = 36578

class HttpServer {
  private server: Server | null = null
  private config: HttpServerConfig = {
    enabled: false,
    port: DEFAULT_PORT,
    apiKey: ''
  }

  public async init(): Promise<void> {
    await this.loadConfig()
    if (this.config.enabled) {
      this.start()
    }
  }

  public async loadConfig(): Promise<HttpServerConfig> {
    try {
      const saved = databaseAPI.dbGet(DB_KEY)
      if (saved) {
        this.config = {
          enabled: saved.enabled ?? false,
          port: saved.port ?? DEFAULT_PORT,
          apiKey: saved.apiKey || this.generateApiKey()
        }
      }
    } catch (error) {
      console.error('[HttpServer] 加载配置失败:', error)
    }
    return this.config
  }

  public async saveConfig(config: Partial<HttpServerConfig>): Promise<HttpServerConfig> {
    this.config = { ...this.config, ...config }
    databaseAPI.dbPut(DB_KEY, {
      enabled: this.config.enabled,
      port: this.config.port,
      apiKey: this.config.apiKey
    })
    return this.config
  }

  public getConfig(): HttpServerConfig {
    if (!this.config.apiKey) {
      this.config.apiKey = this.generateApiKey()
      this.saveConfig({ apiKey: this.config.apiKey })
    }
    return { ...this.config }
  }

  public generateApiKey(): string {
    return randomBytes(16).toString('hex')
  }

  public start(): boolean {
    if (this.server) {
      this.stop()
    }

    try {
      this.server = createServer((req, res) => this.handleRequest(req, res))

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        console.error('[HttpServer] 服务器错误:', error)
        if (error.code === 'EADDRINUSE') {
          console.error(`[HttpServer] 端口 ${this.config.port} 已被占用`)
        }
        this.server = null
      })

      this.server.listen(this.config.port, '127.0.0.1', () => {
        console.log(`[HttpServer] 服务已启动: http://127.0.0.1:${this.config.port}`)
      })

      return true
    } catch (error) {
      console.error('[HttpServer] 启动失败:', error)
      this.server = null
      return false
    }
  }

  public stop(): void {
    if (this.server) {
      this.server.close(() => {
        console.log('[HttpServer] 服务已停止')
      })
      this.server = null
    }
  }

  public isRunning(): boolean {
    return this.server !== null && this.server.listening
  }

  private sendJson(res: ServerResponse, statusCode: number, body: ApiResponse): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    })
    res.end(JSON.stringify(body))
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      })
      res.end()
      return
    }

    const url = req.url || '/'

    // GET / 无需认证，返回欢迎信息
    if (req.method === 'GET' && url === '/') {
      this.sendJson(res, 200, { code: 0, message: 'Hello ZTools' })
      return
    }

    if (req.method !== 'POST') {
      this.sendJson(res, 405, { code: 405, message: '仅支持 POST 请求' })
      return
    }

    const authHeader = req.headers['authorization']
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token || token !== this.config.apiKey) {
      this.sendJson(res, 401, { code: 401, message: 'API 密钥无效' })
      return
    }

    try {
      const body = await this.readBody(req)
      const result = await this.routeRequest(url, body)
      this.sendJson(res, 200, result)
    } catch (error) {
      console.error('[HttpServer] 请求处理失败:', error)
      this.sendJson(res, 500, {
        code: 500,
        message: error instanceof Error ? error.message : '内部服务器错误'
      })
    }
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      const MAX_BODY_SIZE = 1024 * 1024 // 1MB

      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_SIZE) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        if (!raw) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new Error('无效的 JSON 格式'))
        }
      })

      req.on('error', reject)
    })
  }

  private async routeRequest(
    url: string,
    body: Record<string, unknown>
  ): Promise<ApiResponse> {
    switch (url) {
      case '/api/window/show':
        return this.handleShowWindow(body)
      case '/api/window/hide':
        return this.handleHideWindow()
      case '/api/window/toggle':
        return this.handleToggleWindow()
      default:
        return { code: 404, message: `未知接口: ${url}` }
    }
  }

  private handleShowWindow(body: Record<string, unknown>): ApiResponse {
    try {
      windowManager.showWindow()

      const text = typeof body.text === 'string' ? body.text : undefined
      if (text !== undefined) {
        const mainWindow = windowManager.getMainWindow()
        setTimeout(() => {
          mainWindow?.webContents.send('set-search-text', text)
        }, 100)
      }

      return { code: 0, message: '操作成功' }
    } catch (error) {
      return {
        code: 500,
        message: error instanceof Error ? error.message : '显示窗口失败'
      }
    }
  }

  private handleHideWindow(): ApiResponse {
    try {
      windowManager.hideWindow(false)
      return { code: 0, message: '操作成功' }
    } catch (error) {
      return {
        code: 500,
        message: error instanceof Error ? error.message : '隐藏窗口失败'
      }
    }
  }

  private handleToggleWindow(): ApiResponse {
    try {
      const mainWindow = windowManager.getMainWindow()
      if (mainWindow?.isVisible()) {
        windowManager.hideWindow(false)
      } else {
        windowManager.showWindow()
      }
      return { code: 0, message: '操作成功' }
    } catch (error) {
      return {
        code: 500,
        message: error instanceof Error ? error.message : '切换窗口失败'
      }
    }
  }
}

export default new HttpServer()
