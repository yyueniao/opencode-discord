import type { Event as OpenCodeEvent, OpencodeClient, Part } from '@opencode-ai/sdk/v2'
import type { ThreadChannel } from 'discord.js'
import { ChannelType } from 'discord.js'
import { getFileAttachments, getTextAttachments } from './attachments.js'
import { getVerbosity } from './config.js'
import {
  getThreadSession,
  hasPartMessage,
  setPartMessage,
  setThreadSession,
} from './db.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  SILENT_MESSAGE_FLAGS,
  sendErrorToThread,
  sendSessionPartMessage,
  sendThreadMessage,
} from './discord-utils.js'
import {
  registerEventListener,
  unregisterEventListener,
  waitForGlobalEventListener,
} from './events.js'
import {
  formatPart,
  formatTaskToolTitle,
  isEssentialToolPart,
  sessionPartKind,
  shouldLeadWithSeparator,
  type SessionPartKind,
  resolveMentions,
} from './format.js'
import { createLogger, LogPrefix } from './logger.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  getOpencodePromptContext,
  getOpencodeSystemMessage,
} from './system-message.js'

const logger = createLogger(LogPrefix.SESSION)
const discordLogger = createLogger(LogPrefix.DISCORD)

const runtimes = new Map<string, ThreadSessionRuntime>()

export function getRuntime(threadId: string): ThreadSessionRuntime | undefined {
  return runtimes.get(threadId)
}

export function getOrCreateRuntime(input: {
  threadId: string
  thread: ThreadChannel
  projectDirectory: string
  channelId: string
}): ThreadSessionRuntime {
  const existing = runtimes.get(input.threadId)
  if (existing) return existing
  const runtime = new ThreadSessionRuntime(input)
  runtimes.set(input.threadId, runtime)
  return runtime
}

export function disposeRuntime(threadId: string): void {
  const runtime = runtimes.get(threadId)
  if (!runtime) return
  runtime.dispose()
  runtimes.delete(threadId)
}

export function disposeAllRuntimes(): void {
  for (const [threadId, runtime] of runtimes) {
    runtime.dispose()
    runtimes.delete(threadId)
  }
}

type IncomingMessage = {
  prompt: string
  userId: string
  username: string
  sourceMessageId: string
  images?: Array<{
    type: 'file'
    mime: string
    filename?: string
    url: string
    sourceUrl?: string
  }>
}

export class ThreadSessionRuntime {
  readonly threadId: string
  readonly thread: ThreadChannel
  readonly projectDirectory: string
  readonly channelId: string
  private sessionId: string | undefined
  private disposed = false
  private busy = false
  private lastSentPartKind: SessionPartKind | undefined
  private readonly sentPartIds = new Set<string>()
  private readonly partBuffer = new Map<string, Map<string, Part>>()
  private typingKeepaliveTimeout: ReturnType<typeof setTimeout> | null = null
  private ingressQueue: Promise<void> = Promise.resolve()
  private eventQueue: Promise<void> = Promise.resolve()

  constructor(input: {
    threadId: string
    thread: ThreadChannel
    projectDirectory: string
    channelId: string
  }) {
    this.threadId = input.threadId
    this.thread = input.thread
    this.projectDirectory = input.projectDirectory
    this.channelId = input.channelId
    registerEventListener(this.threadId, (event) => {
      this.enqueueEvent(event)
    })
  }

  dispose(): void {
    this.disposed = true
    this.stopTyping()
    unregisterEventListener(this.threadId)
  }

  enqueueIncoming(input: IncomingMessage): Promise<void> {
    const run = this.ingressQueue.then(() => this.submit(input))
    this.ingressQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private enqueueEvent(event: OpenCodeEvent): void {
    const run = this.eventQueue.then(() => this.handleEvent(event))
    this.eventQueue = run.then(
      () => undefined,
      (error: unknown) => {
        logger.error(`Event handler failed:`, error)
      },
    )
  }

  private async submit(input: IncomingMessage): Promise<void> {
    if (this.disposed) return
    try {
      const getClient = await initializeOpencodeForDirectory(this.projectDirectory)
      const session = await this.ensureSession(getClient)
      const channelTopic =
        this.thread.parent?.type === ChannelType.GuildText
          ? this.thread.parent.topic?.trim() || undefined
          : undefined
      const images = input.images || []
      const promptWithImagePaths =
        images.length === 0
          ? input.prompt
          : `${input.prompt}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${images
              .map((img) => `- ${img.sourceUrl || img.filename}`)
              .join('\n')}`
      const syntheticContext = getOpencodePromptContext({
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: this.threadId,
        threadName: this.thread.name || undefined,
      })
      const parts = [
        { type: 'text' as const, text: promptWithImagePaths },
        { type: 'text' as const, text: syntheticContext, synthetic: true },
        ...images,
      ]
      await waitForGlobalEventListener()
      const result = await getClient().session.promptAsync({
        sessionID: session.id,
        directory: this.projectDirectory,
        parts,
        system: getOpencodeSystemMessage({
          sessionId: session.id,
          channelId: this.channelId,
          guildId: this.thread.guildId,
          threadId: this.thread.id,
          channelTopic,
        }),
      })
      if (result.error) {
        const message =
          typeof result.error === 'object' && result.error && 'message' in result.error
            ? String(result.error.message)
            : 'promptAsync failed'
        await sendThreadMessage(this.thread, `✗ OpenCode API error: ${message}`, {
          flags: NOTIFY_MESSAGE_FLAGS,
        })
        return
      }
      logger.log(`promptAsync accepted sessionId=${session.id} threadId=${this.threadId}`)
    } catch (error) {
      await sendErrorToThread(this.thread, error)
    }
  }

  private async ensureSession(
    getClient: () => OpencodeClient,
  ): Promise<{ id: string }> {
    let sessionId = this.sessionId || (await getThreadSession(this.thread.id))
    if (sessionId) {
      try {
        const existing = await getClient().session.get({
          sessionID: sessionId,
          directory: this.projectDirectory,
        })
        if (existing.data) {
          this.sessionId = existing.data.id
          await setThreadSession(this.thread.id, existing.data.id)
          return { id: existing.data.id }
        }
      } catch (error) {
        logger.warn(
          `Failed to reuse session ${sessionId}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }

    const created = await getClient().session.create({
      directory: this.projectDirectory,
    })
    if (!created.data) {
      throw new Error(`Failed to create OpenCode session for thread ${this.thread.id}`)
    }
    this.sessionId = created.data.id
    await setThreadSession(this.thread.id, created.data.id)
    logger.log(`Created session ${created.data.id} for thread ${this.thread.id}`)
    return { id: created.data.id }
  }

  private eventSessionId(event: OpenCodeEvent): string | undefined {
    const properties = event.properties as Record<string, unknown> | undefined
    if (!properties || typeof properties !== 'object') return undefined
    if (typeof properties.sessionID === 'string') return properties.sessionID
    const info = properties.info
    if (info && typeof info === 'object' && 'sessionID' in info) {
      const sessionID = (info as { sessionID?: unknown }).sessionID
      if (typeof sessionID === 'string') return sessionID
    }
    const part = properties.part
    if (part && typeof part === 'object' && 'sessionID' in part) {
      const sessionID = (part as { sessionID?: unknown }).sessionID
      if (typeof sessionID === 'string') return sessionID
    }
    return undefined
  }

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    if (this.disposed) return
    const sessionId = this.sessionId
    if (!sessionId) return
    if (!event.properties) return
    const eventSessionId = this.eventSessionId(event)
    if (eventSessionId && eventSessionId !== sessionId) return

    if (event.type === 'session.status') {
      const status = event.properties.status
      if (status.type === 'busy') {
        this.busy = true
        this.ensureTypingNow()
      } else if (status.type === 'idle') {
        this.busy = false
        this.stopTyping()
      } else if (status.type === 'retry') {
        const remainingMs = Math.max(0, status.next - Date.now())
        const remainingSec = Math.ceil(remainingMs / 1000)
        const duration =
          remainingSec < 60
            ? `${remainingSec}s`
            : `${Math.floor(remainingSec / 60)}m`
        const chunk = `⬦ ${status.message} - retrying in ${duration} (attempt #${status.attempt})`
        await this.thread
          .send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
          .catch((error: unknown) => {
            discordLogger.error('Failed to send retry notice:', error)
          })
      }
      return
    }

    if (event.type === 'session.idle') {
      this.busy = false
      this.stopTyping()
      return
    }

    if (event.type === 'session.error') {
      const error = event.properties.error
      if (error?.name === 'MessageAbortedError') return
      const message =
        error && 'data' in error && error.data && typeof error.data === 'object' && 'message' in error.data
          ? String(error.data.message)
          : error?.name || 'unknown error'
      this.busy = false
      this.stopTyping()
      await sendThreadMessage(this.thread, `✗ opencode session error: ${message}`, {
        flags: NOTIFY_MESSAGE_FLAGS,
      })
      return
    }

    if (event.type === 'message.part.updated') {
      await this.handleMainPart(event.properties.part)
      return
    }

    if (event.type === 'message.updated') {
      const msg = event.properties.info
      if (msg.role !== 'assistant') return
      if (typeof msg.time.completed === 'number') {
        await this.flushBufferedParts({ messageID: msg.id, force: true })
        this.busy = false
        this.stopTyping()
      }
    }
  }

  private storePart(part: Part): void {
    const messageParts = this.partBuffer.get(part.messageID) || new Map<string, Part>()
    messageParts.set(part.id, part)
    this.partBuffer.set(part.messageID, messageParts)
  }

  private getBufferedParts(messageID: string): Part[] {
    return Array.from(this.partBuffer.get(messageID)?.values() ?? [])
  }

  private shouldSendPart({
    part,
    force,
  }: {
    part: Part
    force: boolean
  }): boolean {
    if (part.type === 'step-start' || part.type === 'step-finish') return false
    if (part.type === 'tool' && part.state.status === 'pending') return false
    if (!force && part.type === 'text' && !part.time?.end) return false
    if (!force && part.type === 'tool' && part.state.status === 'completed') return false
    return true
  }

  private async sendPartMessage({ part }: { part: Part }): Promise<void> {
    const verbosity = getVerbosity()
    if (verbosity === 'text_only' && part.type !== 'text') return
    if (verbosity === 'text_and_essential_tools') {
      if (part.type !== 'text' && !(part.type === 'tool' && isEssentialToolPart(part))) {
        return
      }
    }

    const content = formatPart(part)
    if (!content.trim()) return
    if (this.sentPartIds.has(part.id) || (await hasPartMessage(part.id))) return
    this.sentPartIds.add(part.id)

    const kind = sessionPartKind(part)
    try {
      const sent = await sendSessionPartMessage(this.thread, content, {
        leadWithSeparator: shouldLeadWithSeparator({
          previousKind: this.lastSentPartKind,
          nextKind: kind,
        }),
      })
      this.lastSentPartKind = kind
      await setPartMessage({
        partId: part.id,
        messageId: sent.id,
        threadId: this.thread.id,
      })
      this.requestTypingRepulse()
    } catch (error) {
      this.sentPartIds.delete(part.id)
      discordLogger.error(`Failed to send part ${part.id}:`, error)
    }
  }

  private async flushBufferedParts({
    messageID,
    force,
    skipPartId,
  }: {
    messageID: string
    force: boolean
    skipPartId?: string
  }): Promise<void> {
    for (const part of this.getBufferedParts(messageID)) {
      if (skipPartId && part.id === skipPartId) continue
      if (!this.shouldSendPart({ part, force })) continue
      await this.sendPartMessage({ part })
    }
  }

  private async handleMainPart(part: Part): Promise<void> {
    this.storePart(part)

    if (part.type === 'step-start') {
      this.busy = true
      this.ensureTypingNow()
      return
    }

    if (part.type === 'tool' && part.state.status === 'running') {
      await this.flushBufferedParts({
        messageID: part.messageID,
        force: true,
        skipPartId: part.id,
      })
      if (part.tool === 'task') {
        const taskDisplay = formatTaskToolTitle(part)
        if (taskDisplay && getVerbosity() !== 'text_only' && !this.sentPartIds.has(part.id)) {
          this.sentPartIds.add(part.id)
          try {
            const sent = await sendSessionPartMessage(this.thread, taskDisplay, {
              leadWithSeparator: shouldLeadWithSeparator({
                previousKind: this.lastSentPartKind,
                nextKind: 'tool',
              }),
            })
            this.lastSentPartKind = 'tool'
            await setPartMessage({
              partId: part.id,
              messageId: sent.id,
              threadId: this.thread.id,
            })
          } catch (error) {
            this.sentPartIds.delete(part.id)
            discordLogger.error(`Failed to send task part ${part.id}:`, error)
          }
        }
        return
      }
      await this.sendPartMessage({ part })
      return
    }

    if (part.type === 'tool' && part.state.status === 'completed') {
      const output = part.state.output || ''
      const outputTokens = Math.ceil(output.length / 4)
      if (outputTokens >= 3000 && getVerbosity() !== 'text_only') {
        const formattedTokens =
          outputTokens >= 1000 ? `${(outputTokens / 1000).toFixed(1)}k` : String(outputTokens)
        await this.thread
          .send({
            content: `⬦ ${part.tool} returned ${formattedTokens} tokens`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          .catch((error: unknown) => {
            discordLogger.error('Failed to send large output notice:', error)
          })
      }
      return
    }

    if (part.type === 'reasoning') {
      if (getVerbosity() === 'tools_and_text') {
        await this.sendPartMessage({ part })
      }
      return
    }

    if (part.type === 'text' && part.time?.end) {
      await this.sendPartMessage({ part })
      return
    }

    if (part.type === 'step-finish') {
      await this.flushBufferedParts({
        messageID: part.messageID,
        force: true,
      })
      this.ensureTypingKeepalive()
    }
  }

  private shouldTypeNow(): boolean {
    return this.busy && !this.disposed
  }

  private async sendTypingPulse(): Promise<void> {
    try {
      await this.thread.sendTyping()
    } catch (error) {
      discordLogger.log(`Failed to send typing: ${error instanceof Error ? error.message : error}`)
    }
  }

  private clearTypingKeepalive(): void {
    if (!this.typingKeepaliveTimeout) return
    clearTimeout(this.typingKeepaliveTimeout)
    this.typingKeepaliveTimeout = null
  }

  private armTypingKeepalive(delayMs: number): void {
    this.typingKeepaliveTimeout = setTimeout(() => {
      const activeTimer = this.typingKeepaliveTimeout
      if (!activeTimer) return
      void (async () => {
        if (!this.shouldTypeNow()) {
          this.stopTyping()
          return
        }
        await this.sendTypingPulse()
        if (this.typingKeepaliveTimeout !== activeTimer) return
        if (!this.shouldTypeNow()) {
          this.stopTyping()
          return
        }
        this.armTypingKeepalive(7000)
      })()
    }, delayMs)
  }

  private ensureTypingNow(): void {
    if (!this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    if (!this.typingKeepaliveTimeout) {
      this.armTypingKeepalive(0)
    }
  }

  private ensureTypingKeepalive(): void {
    if (!this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    if (this.typingKeepaliveTimeout) return
    this.armTypingKeepalive(7000)
  }

  private requestTypingRepulse(): void {
    if (!this.shouldTypeNow()) return
    this.clearTypingKeepalive()
    this.armTypingKeepalive(0)
  }

  private stopTyping(): void {
    this.clearTypingKeepalive()
  }
}

export async function preprocessMessage(
  message: import('discord.js').Message,
): Promise<{ prompt: string; images: IncomingMessage['images'] }> {
  const resolved = resolveMentions(message)
  const textAttachments = await getTextAttachments(message)
  const images = await getFileAttachments(message)
  const prompt = [resolved, textAttachments].filter(Boolean).join('\n\n')
  return { prompt, images }
}
