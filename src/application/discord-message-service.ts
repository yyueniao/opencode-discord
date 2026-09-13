import fs from 'node:fs'
import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Client,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type {
  ChannelProjectRepository,
  ThreadSessionRepository,
} from '../domain/repositories.js'
import { DiscordMessaging } from '../infrastructure/discord/messaging.js'
import type { Logger } from '../infrastructure/logger.js'
import type { MessagePreprocessor } from './message-preprocessor.js'
import type { SessionRuntimeRegistry } from './session-runtime-registry.js'

const MISSING_MESSAGE_CONTENT_REPLY =
  'Message content is empty. Enable the Message Content Intent for this bot in the Discord Developer Portal.'

export class DiscordMessageService {
  constructor(
    private readonly channelProjects: ChannelProjectRepository,
    private readonly threadSessions: ThreadSessionRepository,
    private readonly runtimes: SessionRuntimeRegistry,
    private readonly preprocessor: MessagePreprocessor,
    private readonly messaging: DiscordMessaging,
    private readonly logger: Logger,
  ) {}

  async handle(discordClient: Client, message: Message): Promise<void> {
    if (discordClient.user && message.author?.id === discordClient.user.id) return
    if (message.author?.bot) return

    if (message.partial) {
      await message.fetch()
    }

    const channel = message.channel
    const owningChannelId = this.messaging.isThreadChannelType(channel.type)
      ? (channel as ThreadChannel).parentId || undefined
      : channel.id
    if (!owningChannelId) return

    const channelConfig = await this.channelProjects.findByChannelId(owningChannelId)
    if (!channelConfig) return

    if (this.messaging.isThreadChannelType(channel.type)) {
      await this.handleThreadMessage({
        discordClient,
        message,
        thread: channel as ThreadChannel,
        projectDirectory: channelConfig.directory,
      })
      return
    }

    if (channel.type === ChannelType.GuildText) {
      await this.handleChannelMessage({
        message,
        channel,
        projectDirectory: channelConfig.directory,
      })
    }
  }

  private async handleThreadMessage({
    discordClient,
    message,
    thread,
    projectDirectory,
  }: {
    discordClient: Client
    message: Message
    thread: ThreadChannel
    projectDirectory: string
  }): Promise<void> {
    const hasExistingSession = await this.threadSessions.findSessionId(thread.id)
    const botMentioned =
      discordClient.user && message.mentions.has(discordClient.user.id)
    const botCreatedThread =
      discordClient.user && thread.ownerId === discordClient.user.id
    if (!hasExistingSession && !botMentioned && !botCreatedThread) {
      this.logger.log(`Ignoring thread ${thread.id}: no existing session and bot not mentioned`)
      return
    }

    if (!fs.existsSync(projectDirectory)) {
      await message.reply({
        content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
        flags: DiscordMessaging.NOTIFY_FLAGS,
      })
      return
    }

    if (isMissingReadableMessageContent(message)) {
      await message.reply({
        content: MISSING_MESSAGE_CONTENT_REPLY,
        flags: DiscordMessaging.SILENT_FLAGS,
      })
      return
    }

    const parentId = thread.parentId
    if (!parentId) return
    const prompt = await this.preprocessor.preprocess(message)
    if (prompt.isEmpty()) return

    const runtime = this.runtimes.getOrCreate({
      threadId: thread.id,
      thread,
      projectDirectory,
      channelId: parentId,
    })
    await runtime.enqueueIncoming({
      prompt,
      userId: message.author.id,
      username: message.member?.displayName || message.author.displayName,
      sourceMessageId: message.id,
    })
  }

  private async handleChannelMessage({
    message,
    channel,
    projectDirectory,
  }: {
    message: Message
    channel: TextChannel
    projectDirectory: string
  }): Promise<void> {
    if (!fs.existsSync(projectDirectory)) {
      await message.reply({
        content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
        flags: DiscordMessaging.NOTIFY_FLAGS,
      })
      return
    }

    if (isMissingReadableMessageContent(message)) {
      await message.reply({
        content: MISSING_MESSAGE_CONTENT_REPLY,
        flags: DiscordMessaging.SILENT_FLAGS,
      })
      return
    }

    const baseThreadName =
      this.messaging.stripMentions(message.content || '').replace(/\s+/g, ' ').trim() ||
      'opencode thread'
    const thread = await message.startThread({
      name: baseThreadName.slice(0, 80),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'Start OpenCode session',
    })
    await thread.members.add(message.author.id)
    this.logger.log(`Created thread "${thread.name}" (${thread.id})`)

    const prompt = await this.preprocessor.preprocess(message)
    const runtime = this.runtimes.getOrCreate({
      threadId: thread.id,
      thread,
      projectDirectory,
      channelId: channel.id,
    })
    await runtime.enqueueIncoming({
      prompt,
      userId: message.author.id,
      username: message.member?.displayName || message.author.displayName,
      sourceMessageId: message.id,
    })
  }
}

function isMissingReadableMessageContent(message: Message): boolean {
  return (
    !message.content &&
    message.attachments.size === 0 &&
    message.embeds.length === 0 &&
    !message.poll &&
    message.messageSnapshots.size === 0
  )
}
