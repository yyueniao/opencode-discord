import {
  ChannelType,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  type Message,
  type ThreadChannel,
} from 'discord.js'
import type { Logger } from '../logger.js'
import { DiscordMarkdown } from './markdown.js'

export class DiscordMessaging {
  static readonly SILENT_FLAGS = 4 | 4096
  static readonly NOTIFY_FLAGS = 4

  constructor(
    private readonly markdown: DiscordMarkdown,
    private readonly logger: Logger,
  ) {}

  stripMentions(text: string): string {
    return text
      .replace(/<@!?\d+>/g, '')
      .replace(/<@&\d+>/g, '')
      .replace(/<#\d+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  isThreadChannelType(type: number): boolean {
    return [
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ].includes(type)
  }

  async sendThreadMessage(
    thread: ThreadChannel,
    content: string,
    options?: { flags?: number },
  ): Promise<Message> {
    const MAX_LENGTH = 2000
    const sendFlags = options?.flags ?? DiscordMessaging.SILENT_FLAGS
    let text = this.markdown.limitHeadingDepth(content)
    text = this.markdown.escapeBackticksInCodeBlocks(text)
    if (!text.trim()) {
      throw new Error('Refusing to send empty Discord message')
    }
    const chunks = this.markdown.splitForDiscord({ content: text, maxLength: MAX_LENGTH })
    let firstMessage: Message | undefined
    for (let chunk of chunks) {
      if (!chunk.trim()) continue
      if (chunk.length > MAX_LENGTH) {
        chunk = chunk.slice(0, MAX_LENGTH - 4) + '...'
      }
      const message = await thread.send({ content: chunk, flags: sendFlags })
      if (!firstMessage) firstMessage = message
    }
    if (!firstMessage) {
      throw new Error('Failed to send Discord message')
    }
    return firstMessage
  }

  async sendSessionPartMessage(
    thread: ThreadChannel,
    content: string,
    options?: {
      leadWithSeparator?: boolean
      flags?: number
    },
  ): Promise<Message> {
    if (options?.leadWithSeparator === true) {
      const baseFlags = options.flags ?? DiscordMessaging.SILENT_FLAGS
      await thread.send({
        components: leadingSeparatorComponents(),
        flags: MessageFlags.IsComponentsV2 | baseFlags,
      })
    }
    return this.sendThreadMessage(thread, content, { flags: options?.flags })
  }

  async sendErrorToThread(thread: ThreadChannel, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      1900,
    )
    this.logger.error(message)
    await this.sendThreadMessage(thread, `Error: ${message}`, {
      flags: DiscordMessaging.NOTIFY_FLAGS,
    }).catch((sendError: unknown) => {
      this.logger.error('Failed to send error to thread', sendError)
    })
  }
}

function leadingSeparatorComponents() {
  return [
    {
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacingSize.Small,
    },
  ]
}
