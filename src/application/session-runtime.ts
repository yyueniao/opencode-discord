import type { Event as OpenCodeEvent, OpencodeClient, Part } from '@opencode-ai/sdk/v2'
import { ChannelType, type ThreadChannel } from 'discord.js'
import type { IncomingPrompt } from '../domain/incoming-prompt.js'
import { SessionPart, type SessionPartKind } from '../domain/session-part.js'
import type { PartFormatter } from '../domain/part-formatter.js'
import type { PromptBuilder } from '../domain/prompt-builder.js'
import type {
  PartMessageRepository,
  ThreadSessionRepository,
} from '../domain/repositories.js'
import type { AppConfig } from '../infrastructure/config.js'
import { DiscordMessaging } from '../infrastructure/discord/messaging.js'
import {
  eventSessionId,
  type OpencodeEventStream,
} from '../infrastructure/event-stream.js'
import type { Logger } from '../infrastructure/logger.js'
import type { OpencodeServer } from '../infrastructure/opencode-server.js'

export type SessionRuntimeDeps = {
  opencode: OpencodeServer
  threadSessions: ThreadSessionRepository
  partMessages: PartMessageRepository
  eventStream: OpencodeEventStream
  config: AppConfig
  messaging: DiscordMessaging
  promptBuilder: PromptBuilder
  partFormatter: PartFormatter
  logger: Logger
  discordLogger: Logger
}

type IncomingTurn = {
  prompt: IncomingPrompt
  userId: string
  username: string
  sourceMessageId: string
}

export class SessionRuntime {
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

  constructor(
    input: {
      threadId: string
      thread: ThreadChannel
      projectDirectory: string
      channelId: string
    },
    private readonly deps: SessionRuntimeDeps,
  ) {
    this.threadId = input.threadId
    this.thread = input.thread
    this.projectDirectory = input.projectDirectory
    this.channelId = input.channelId
    this.deps.eventStream.register(this.threadId, (event) => {
      this.enqueueEvent(event)
    })
  }

  dispose(): void {
    this.disposed = true
    this.stopTyping()
    this.deps.eventStream.unregister(this.threadId)
  }

  get isBusy(): boolean {
    return this.busy
  }

  async abort(): Promise<boolean> {
    const sessionId =
      this.sessionId || (await this.deps.threadSessions.findSessionId(this.threadId))
    if (!sessionId) return false
    this.sessionId = sessionId
    const getClient = await this.deps.opencode.initializeForDirectory(this.projectDirectory)
    const result = await getClient().session.abort({
      sessionID: sessionId,
      directory: this.projectDirectory,
    })
    if (result.error) {
      const message =
        typeof result.error === 'object' && result.error && 'message' in result.error
          ? String(result.error.message)
          : 'abort failed'
      throw new Error(message)
    }
    this.busy = false
    this.stopTyping()
    return result.data ?? true
  }

  enqueueIncoming(input: IncomingTurn): Promise<void> {
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
        this.deps.logger.error(`Event handler failed:`, error)
      },
    )
  }

  private async submit(input: IncomingTurn): Promise<void> {
    if (this.disposed) return
    try {
      const getClient = await this.deps.opencode.initializeForDirectory(this.projectDirectory)
      const session = await this.ensureSession(getClient)
      const channelTopic =
        this.thread.parent?.type === ChannelType.GuildText
          ? this.thread.parent.topic?.trim() || undefined
          : undefined
      const images = input.prompt.images
      const promptWithImagePaths = input.prompt.withImagePaths()
      const syntheticContext = this.deps.promptBuilder.context({
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
      await this.deps.eventStream.waitUntilConnected()
      const model = this.deps.config.getOpencodeModel()
      const result = await getClient().session.promptAsync({
        sessionID: session.id,
        directory: this.projectDirectory,
        parts,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
        },
        variant: this.deps.config.getOpencodeVariant(),
        system: this.deps.promptBuilder.systemMessage({
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
        await this.deps.messaging.sendThreadMessage(
          this.thread,
          `✗ OpenCode API error: ${message}`,
          { flags: DiscordMessaging.NOTIFY_FLAGS },
        )
        return
      }
      this.deps.logger.log(
        `promptAsync accepted sessionId=${session.id} threadId=${this.threadId}`,
      )
    } catch (error) {
      await this.deps.messaging.sendErrorToThread(this.thread, error)
    }
  }

  private async ensureSession(
    getClient: () => OpencodeClient,
  ): Promise<{ id: string }> {
    let sessionId =
      this.sessionId || (await this.deps.threadSessions.findSessionId(this.thread.id))
    if (sessionId) {
      try {
        const existing = await getClient().session.get({
          sessionID: sessionId,
          directory: this.projectDirectory,
        })
        if (existing.data) {
          this.setSessionId(existing.data.id)
          await this.deps.threadSessions.save(this.thread.id, existing.data.id)
          return { id: existing.data.id }
        }
      } catch (error) {
        this.deps.logger.warn(
          `Failed to reuse session ${sessionId}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }

    const model = this.deps.config.getOpencodeModel()
    const created = await getClient().session.create({
      directory: this.projectDirectory,
      model: {
        id: model.modelID,
        providerID: model.providerID,
        variant: this.deps.config.getOpencodeVariant(),
      },
    })
    if (!created.data) {
      throw new Error(`Failed to create OpenCode session for thread ${this.thread.id}`)
    }
    this.setSessionId(created.data.id)
    await this.deps.threadSessions.save(this.thread.id, created.data.id)
    this.deps.logger.log(`Created session ${created.data.id} for thread ${this.thread.id}`)
    return { id: created.data.id }
  }

  private setSessionId(sessionId: string): void {
    this.sessionId = sessionId
    this.deps.eventStream.bindSession(this.threadId, sessionId)
  }

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    if (this.disposed) return
    const sessionId = this.sessionId
    if (!sessionId) return
    if (!event.properties) return
    const incomingSessionId = eventSessionId(event)
    if (incomingSessionId && incomingSessionId !== sessionId) return

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
          .send({ content: chunk, flags: DiscordMessaging.SILENT_FLAGS })
          .catch((error: unknown) => {
            this.deps.discordLogger.error('Failed to send retry notice:', error)
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
      await this.deps.messaging.sendThreadMessage(
        this.thread,
        `✗ opencode session error: ${message}`,
        { flags: DiscordMessaging.NOTIFY_FLAGS },
      )
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
        this.forgetMessage(msg.id)
        this.busy = false
        this.stopTyping()
      }
    }
  }

  private storePart(part: Part): void {
    if (part.type === 'step-start' || part.type === 'step-finish') return
    const messageParts = this.partBuffer.get(part.messageID) || new Map<string, Part>()
    messageParts.set(part.id, part)
    this.partBuffer.set(part.messageID, messageParts)
  }

  private forgetPart(part: { id: string; messageID: string }): void {
    const messageParts = this.partBuffer.get(part.messageID)
    if (!messageParts) return
    messageParts.delete(part.id)
    if (messageParts.size === 0) this.partBuffer.delete(part.messageID)
  }

  private forgetMessage(messageID: string): void {
    this.partBuffer.delete(messageID)
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
    const verbosity = this.deps.config.getVerbosity()
    if (verbosity.isTextOnly && part.type !== 'text') {
      this.forgetPart(part)
      return
    }
    if (verbosity.isTextAndEssentialTools) {
      if (part.type !== 'text' && !(part.type === 'tool' && SessionPart.isEssentialTool(part))) {
        this.forgetPart(part)
        return
      }
    }

    const content = this.deps.partFormatter.format(part)
    if (!content.trim()) {
      this.forgetPart(part)
      return
    }
    if (this.sentPartIds.has(part.id) || (await this.deps.partMessages.exists(part.id))) {
      this.forgetPart(part)
      return
    }
    this.sentPartIds.add(part.id)

    const kind = SessionPart.kind(part)
    try {
      const sent = await this.deps.messaging.sendSessionPartMessage(this.thread, content, {
        leadWithSeparator: SessionPart.shouldLeadWithSeparator({
          previousKind: this.lastSentPartKind,
          nextKind: kind,
        }),
      })
      this.lastSentPartKind = kind
      await this.deps.partMessages.save({
        partId: part.id,
        messageId: sent.id,
        threadId: this.thread.id,
      })
      this.forgetPart(part)
      this.requestTypingRepulse()
    } catch (error) {
      this.sentPartIds.delete(part.id)
      this.deps.discordLogger.error(`Failed to send part ${part.id}:`, error)
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
        const taskDisplay = this.deps.partFormatter.formatTaskToolTitle(part)
        if (
          taskDisplay &&
          !this.deps.config.getVerbosity().isTextOnly &&
          !this.sentPartIds.has(part.id)
        ) {
          this.sentPartIds.add(part.id)
          try {
            const sent = await this.deps.messaging.sendSessionPartMessage(
              this.thread,
              taskDisplay,
              {
                leadWithSeparator: SessionPart.shouldLeadWithSeparator({
                  previousKind: this.lastSentPartKind,
                  nextKind: 'tool',
                }),
              },
            )
            this.lastSentPartKind = 'tool'
            await this.deps.partMessages.save({
              partId: part.id,
              messageId: sent.id,
              threadId: this.thread.id,
            })
            this.forgetPart(part)
          } catch (error) {
            this.sentPartIds.delete(part.id)
            this.deps.discordLogger.error(`Failed to send task part ${part.id}:`, error)
          }
        } else if (this.sentPartIds.has(part.id)) {
          this.forgetPart(part)
        }
        return
      }
      await this.sendPartMessage({ part })
      return
    }

    if (part.type === 'tool' && part.state.status === 'completed') {
      const output = part.state.output || ''
      const outputTokens = Math.ceil(output.length / 4)
      if (outputTokens >= 3000 && !this.deps.config.getVerbosity().isTextOnly) {
        const formattedTokens =
          outputTokens >= 1000 ? `${(outputTokens / 1000).toFixed(1)}k` : String(outputTokens)
        await this.thread
          .send({
            content: `⬦ ${part.tool} returned ${formattedTokens} tokens`,
            flags: DiscordMessaging.SILENT_FLAGS,
          })
          .catch((error: unknown) => {
            this.deps.discordLogger.error('Failed to send large output notice:', error)
          })
      }
      if (this.sentPartIds.has(part.id)) this.forgetPart(part)
      return
    }

    if (part.type === 'reasoning') {
      if (this.deps.config.getVerbosity().isToolsAndText) {
        await this.sendPartMessage({ part })
      } else {
        this.forgetPart(part)
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
      this.deps.discordLogger.log(
        `Failed to send typing: ${error instanceof Error ? error.message : error}`,
      )
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
