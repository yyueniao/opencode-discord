import type { Event as OpenCodeEvent, GlobalEvent } from '@opencode-ai/sdk/v2'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.SESSION)

type EventCallback = (event: OpenCodeEvent) => void

const callbacks = new Map<string, EventCallback>()
let loopRunning = false
let disposed = false
let controller: AbortController | null = null
let connected = false
const connectionWaiters = new Set<() => void>()

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}

export function registerEventListener(
  threadId: string,
  callback: EventCallback,
): void {
  if (disposed) disposed = false
  callbacks.set(threadId, callback)
  ensureListenerRunning()
}

export function unregisterEventListener(threadId: string): void {
  callbacks.delete(threadId)
}

export function disposeGlobalEventListener(): void {
  disposed = true
  loopRunning = false
  connected = false
  controller?.abort()
  controller = null
  callbacks.clear()
}

export function restartGlobalEventListener(): void {
  if (disposed) return
  connected = false
  controller?.abort()
}

export function waitForGlobalEventListener(): Promise<void> {
  if (callbacks.size === 0 || connected) return Promise.resolve()
  ensureListenerRunning()
  return new Promise((resolve) => {
    connectionWaiters.add(resolve)
  })
}

let _getBaseUrl: (() => string | null) | null = null
let _getAuthHeaders: (() => Record<string, string>) | null = null

async function resolveOpencodeFns() {
  if (_getBaseUrl && _getAuthHeaders) {
    return { getBaseUrl: _getBaseUrl, getAuthHeaders: _getAuthHeaders }
  }
  const mod = await import('./opencode.js')
  _getBaseUrl = mod.getOpencodeServerBaseUrl
  _getAuthHeaders = mod.getOpencodeServerAuthHeaders
  return { getBaseUrl: _getBaseUrl, getAuthHeaders: _getAuthHeaders }
}

function createGlobalClient(
  baseUrl: string,
  headers: Record<string, string>,
): OpencodeClient {
  return createOpencodeClient({ baseUrl, headers })
}

function dispatchEvent(globalEvent: GlobalEvent): void {
  const payload = globalEvent.payload as OpenCodeEvent
  for (const callback of callbacks.values()) {
    callback(payload)
  }
}

function ensureListenerRunning(): void {
  if (loopRunning || disposed) return
  loopRunning = true
  void runEventLoop()
}

async function runEventLoop(): Promise<void> {
  const { getBaseUrl, getAuthHeaders } = await resolveOpencodeFns()
  let backoffMs = 500
  const maxBackoffMs = 30_000

  while (!disposed) {
    controller = new AbortController()
    const signal = controller.signal
    const baseUrl = getBaseUrl()
    if (!baseUrl) {
      if (callbacks.size === 0) {
        loopRunning = false
        return
      }
      logger.warn(`No OpenCode server available, retrying in ${backoffMs}ms`)
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    const client = createGlobalClient(baseUrl, getAuthHeaders())
    let subscribeResult: Awaited<ReturnType<OpencodeClient['global']['event']>> | Error
    try {
      subscribeResult = await client.global.event({ signal })
    } catch (error) {
      subscribeResult = error instanceof Error ? error : new Error(String(error))
    }

    if (subscribeResult instanceof Error) {
      if (isAbortError(subscribeResult)) {
        if (disposed) return
        backoffMs = 500
        continue
      }
      logger.warn(`Subscribe failed, retrying in ${backoffMs}ms:`, subscribeResult.message)
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    connected = true
    for (const resolve of connectionWaiters) resolve()
    connectionWaiters.clear()
    logger.log('Connected to global event stream')

    let receivedAnyEvent = false
    let iterError: Error | undefined
    try {
      for await (const event of subscribeResult.stream) {
        receivedAnyEvent = true
        dispatchEvent(event)
      }
    } catch (error) {
      iterError = error instanceof Error ? error : new Error(String(error))
    }

    connected = false
    if (receivedAnyEvent) backoffMs = 500

    if (iterError) {
      if (isAbortError(iterError)) {
        if (disposed) return
        backoffMs = 500
        continue
      }
      logger.warn(`Stream broke, reconnecting in ${backoffMs}ms:`, iterError.message)
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    if (signal.aborted) {
      backoffMs = 500
      continue
    }
    logger.log(`Stream ended normally, reconnecting in ${backoffMs}ms`)
    await delay(backoffMs, signal)
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
  }
}
