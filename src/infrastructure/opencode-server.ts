import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import {
  createOpencodeClient,
  type OpencodeClient,
} from '@opencode-ai/sdk/v2'
import type { AppConfig } from './config.js'
import type { Logger } from './logger.js'

export class OpencodeServer {
  private serverProcess: ChildProcess | null = null
  private serverPort: number | null = null
  private serverBaseUrl: string | null = null
  private readonly clients = new Map<string, OpencodeClient>()
  private onReady: (() => void) | undefined

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  setOnReady(callback: () => void): void {
    this.onReady = callback
  }

  getBaseUrl(): string | null {
    return this.serverBaseUrl
  }

  getAuthHeaders(): Record<string, string> {
    return this.config.getOpencodeAuthHeaders()
  }

  async ensure(): Promise<string> {
    if (this.serverBaseUrl) return this.serverBaseUrl

    const port = this.config.getOpencodePort() || (await findFreePort())
    const hostname = '127.0.0.1'
    this.logger.log(`Starting opencode serve on ${hostname}:${port}`)

    const child = spawn(
      'opencode',
      ['serve', '--port', String(port), '--hostname', hostname, '--print-logs', '--log-level', 'WARN'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCODE_EXPERIMENTAL_WORKSPACES: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.logger.log(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.logger.warn(text)
    })
    child.on('exit', (code, signal) => {
      this.logger.warn(`opencode exited code=${code} signal=${signal}`)
      if (this.serverProcess === child) {
        this.serverProcess = null
        this.serverPort = null
        this.serverBaseUrl = null
        this.clients.clear()
      }
    })

    this.serverProcess = child
    this.serverPort = port
    this.serverBaseUrl = `http://${hostname}:${port}`
    await this.waitUntilReady(this.serverBaseUrl)
    this.logger.log(`OpenCode ready on ${this.serverBaseUrl}`)
    this.onReady?.()
    return this.serverBaseUrl
  }

  getOrCreateClient(directory: string): OpencodeClient {
    const existing = this.clients.get(directory)
    if (existing) return existing
    if (!this.serverBaseUrl) {
      throw new Error('OpenCode server is not running')
    }
    const client = createOpencodeClient({
      baseUrl: this.serverBaseUrl,
      directory,
      headers: this.getAuthHeaders(),
    })
    this.clients.set(directory, client)
    return client
  }

  async initializeForDirectory(directory: string): Promise<() => OpencodeClient> {
    await this.ensure()
    return () => this.getOrCreateClient(directory)
  }

  async stop(): Promise<void> {
    const child = this.serverProcess
    this.serverProcess = null
    this.serverPort = null
    this.serverBaseUrl = null
    this.clients.clear()
    if (!child || child.killed) return
    child.kill('SIGTERM')
  }

  private async waitUntilReady(baseUrl: string): Promise<void> {
    const healthUrl = `${baseUrl}/global/health`
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await this.requestHealthcheck(healthUrl)) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`OpenCode server did not become ready at ${baseUrl}`)
  }

  private async requestHealthcheck(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        url,
        {
          method: 'GET',
          headers: { connection: 'close', ...this.getAuthHeaders() },
        },
        (res) => {
          res.resume()
          resolve((res.statusCode || 0) < 500)
        },
      )
      req.on('error', () => resolve(false))
      req.setTimeout(2000, () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}
