import type { Event as OpenCodeEvent, GlobalEvent } from '@opencode-ai/sdk/v2'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from './logger.js'
import type { OpencodeServer } from './opencode-server.js'

type EventCallback = (event: OpenCodeEvent) => void

export class OpencodeEventStream {
  private readonly callbacks = new Map<string, EventCallback>()
  private loopRunning = false
  private disposed = false
  private controller: AbortController | null = null
  private connected = false
  private readonly connectionWaiters = new Set<() => void>()

  constructor(
    private readonly server: OpencodeServer,
    private readonly logger: Logger,
  ) {}

  register(threadId: string, callback: EventCallback): void {
    if (this.disposed) this.disposed = false
    this.callbacks.set(threadId, callback)
    this.ensureListenerRunning()
  }

  unregister(threadId: string): void {
    this.callbacks.delete(threadId)
  }

  dispose(): void {
    this.disposed = true
    this.loopRunning = false
    this.connected = false
    this.controller?.abort()
    this.controller = null
    this.callbacks.clear()
  }

  restart(): void {
    if (this.disposed) return
    this.connected = false
    this.controller?.abort()
  }

  waitUntilConnected(): Promise<void> {
    if (this.callbacks.size === 0 || this.connected) return Promise.resolve()
    this.ensureListenerRunning()
    return new Promise((resolve) => {
      this.connectionWaiters.add(resolve)
    })
  }

  private ensureListenerRunning(): void {
    if (this.loopRunning || this.disposed) return
    this.loopRunning = true
    void this.runEventLoop()
  }

  private dispatchEvent(globalEvent: GlobalEvent): void {
    const payload = globalEvent.payload as OpenCodeEvent
    for (const callback of this.callbacks.values()) {
      callback(payload)
    }
  }

  private async runEventLoop(): Promise<void> {
    let backoffMs = 500
    const maxBackoffMs = 30_000

    while (!this.disposed) {
      this.controller = new AbortController()
      const signal = this.controller.signal
      const baseUrl = this.server.getBaseUrl()
      if (!baseUrl) {
        if (this.callbacks.size === 0) {
          this.loopRunning = false
          return
        }
        this.logger.warn(`No OpenCode server available, retrying in ${backoffMs}ms`)
        await delay(backoffMs, signal)
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
        continue
      }

      const client = createOpencodeClient({
        baseUrl,
        headers: this.server.getAuthHeaders(),
      })
      let subscribeResult: Awaited<ReturnType<OpencodeClient['global']['event']>> | Error
      try {
        subscribeResult = await client.global.event({ signal })
      } catch (error) {
        subscribeResult = error instanceof Error ? error : new Error(String(error))
      }

      if (subscribeResult instanceof Error) {
        if (isAbortError(subscribeResult)) {
          if (this.disposed) return
          backoffMs = 500
          continue
        }
        this.logger.warn(`Subscribe failed, retrying in ${backoffMs}ms:`, subscribeResult.message)
        await delay(backoffMs, signal)
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
        continue
      }

      this.connected = true
      for (const resolve of this.connectionWaiters) resolve()
      this.connectionWaiters.clear()
      this.logger.log('Connected to global event stream')

      let receivedAnyEvent = false
      let iterError: Error | undefined
      try {
        for await (const event of subscribeResult.stream) {
          receivedAnyEvent = true
          this.dispatchEvent(event)
        }
      } catch (error) {
        iterError = error instanceof Error ? error : new Error(String(error))
      }

      this.connected = false
      if (receivedAnyEvent) backoffMs = 500

      if (iterError) {
        if (isAbortError(iterError)) {
          if (this.disposed) return
          backoffMs = 500
          continue
        }
        this.logger.warn(`Stream broke, reconnecting in ${backoffMs}ms:`, iterError.message)
        await delay(backoffMs, signal)
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
        continue
      }

      if (signal.aborted) {
        backoffMs = 500
        continue
      }
      this.logger.log(`Stream ended normally, reconnecting in ${backoffMs}ms`)
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    }
  }
}

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
