import type { ThreadChannel } from 'discord.js'
import { SessionRuntime, type SessionRuntimeDeps } from './session-runtime.js'

export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>()

  constructor(private readonly deps: SessionRuntimeDeps) {}

  get(threadId: string): SessionRuntime | undefined {
    return this.runtimes.get(threadId)
  }

  getOrCreate(input: {
    threadId: string
    thread: ThreadChannel
    projectDirectory: string
    channelId: string
  }): SessionRuntime {
    const existing = this.runtimes.get(input.threadId)
    if (existing) return existing
    const runtime = new SessionRuntime(input, this.deps)
    this.runtimes.set(input.threadId, runtime)
    return runtime
  }

  dispose(threadId: string): void {
    const runtime = this.runtimes.get(threadId)
    if (!runtime) return
    runtime.dispose()
    this.runtimes.delete(threadId)
  }

  disposeAll(): void {
    for (const [threadId, runtime] of this.runtimes) {
      runtime.dispose()
      this.runtimes.delete(threadId)
    }
  }
}
