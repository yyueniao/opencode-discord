import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {
  createOpencodeClient,
  type OpencodeClient,
} from '@opencode-ai/sdk/v2'
import { createLogger, LogPrefix } from './logger.js'
import { restartGlobalEventListener } from './events.js'

const logger = createLogger(LogPrefix.OPENCODE)

let serverProcess: ChildProcess | null = null
let serverPort: number | null = null
let serverBaseUrl: string | null = null
const clients = new Map<string, OpencodeClient>()

function getAuthHeaders(): Record<string, string> {
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD
  if (!serverPassword) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  const encoded = Buffer.from(`${username}:${serverPassword}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

export function getOpencodeServerAuthHeaders(): Record<string, string> {
  return getAuthHeaders()
}

export function getOpencodeServerBaseUrl(): string | null {
  return serverBaseUrl
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

async function requestHealthcheck(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: { connection: 'close', ...getAuthHeaders() },
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

async function waitUntilReady(baseUrl: string): Promise<void> {
  const healthUrl = `${baseUrl}/global/health`
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await requestHealthcheck(healthUrl)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`OpenCode server did not become ready at ${baseUrl}`)
}

export async function ensureOpencodeServer(): Promise<string> {
  if (serverBaseUrl) return serverBaseUrl

  const port = Number(process.env.OPENCODE_PORT) || (await findFreePort())
  const hostname = '127.0.0.1'
  logger.log(`Starting opencode serve on ${hostname}:${port}`)

  const child = spawn(
    'opencode',
    ['serve', '--port', String(port), '--hostname', hostname, '--print-logs', '--log-level', 'WARN'],
    {
      cwd: os.homedir(),
      env: {
        ...process.env,
        OPENCODE_EXPERIMENTAL_WORKSPACES: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) logger.log(text)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) logger.warn(text)
  })
  child.on('exit', (code, signal) => {
    logger.warn(`opencode exited code=${code} signal=${signal}`)
    if (serverProcess === child) {
      serverProcess = null
      serverPort = null
      serverBaseUrl = null
      clients.clear()
    }
  })

  serverProcess = child
  serverPort = port
  serverBaseUrl = `http://${hostname}:${port}`
  await waitUntilReady(serverBaseUrl)
  logger.log(`OpenCode ready on ${serverBaseUrl}`)
  restartGlobalEventListener()
  return serverBaseUrl
}

export function getOrCreateClient(directory: string): OpencodeClient {
  const existing = clients.get(directory)
  if (existing) return existing
  if (!serverBaseUrl) {
    throw new Error('OpenCode server is not running')
  }
  const client = createOpencodeClient({
    baseUrl: serverBaseUrl,
    directory,
    headers: getAuthHeaders(),
  })
  clients.set(directory, client)
  return client
}

export async function initializeOpencodeForDirectory(
  directory: string,
): Promise<() => OpencodeClient> {
  await ensureOpencodeServer()
  return () => getOrCreateClient(directory)
}

export async function stopOpencodeServer(): Promise<void> {
  const child = serverProcess
  serverProcess = null
  serverPort = null
  serverBaseUrl = null
  clients.clear()
  if (!child || child.killed) return
  child.kill('SIGTERM')
}
