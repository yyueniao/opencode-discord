import {
  ChannelType,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  type Message,
  type ThreadChannel,
} from 'discord.js'
import { createLogger, LogPrefix } from './logger.js'
import {
  escapeBackticksInCodeBlocks,
  limitHeadingDepth,
  splitMarkdownForDiscord,
} from './markdown.js'
import type { SessionPartKind } from './format.js'

const logger = createLogger(LogPrefix.DISCORD)

export const SILENT_MESSAGE_FLAGS = 4 | 4096
export const NOTIFY_MESSAGE_FLAGS = 4

export function stripMentions(text: string): string {
  return text
    .replace(/<@!?\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isThreadChannelType(type: number): boolean {
  return [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(type)
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

export async function sendThreadMessage(
  thread: ThreadChannel,
  content: string,
  options?: { flags?: number },
): Promise<Message> {
  const MAX_LENGTH = 2000
  const sendFlags = options?.flags ?? SILENT_MESSAGE_FLAGS
  let text = limitHeadingDepth(content)
  text = escapeBackticksInCodeBlocks(text)
  if (!text.trim()) {
    throw new Error('Refusing to send empty Discord message')
  }
  const chunks = splitMarkdownForDiscord({ content: text, maxLength: MAX_LENGTH })
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

export async function sendSessionPartMessage(
  thread: ThreadChannel,
  content: string,
  options?: {
    leadWithSeparator?: boolean
    flags?: number
  },
): Promise<Message> {
  if (options?.leadWithSeparator === true) {
    const baseFlags = options.flags ?? SILENT_MESSAGE_FLAGS
    await thread.send({
      components: leadingSeparatorComponents(),
      flags: MessageFlags.IsComponentsV2 | baseFlags,
    })
  }
  return sendThreadMessage(thread, content, { flags: options?.flags })
}

export function shouldLeadWithSeparatorKind({
  previousKind,
  nextKind,
}: {
  previousKind: SessionPartKind | undefined
  nextKind: SessionPartKind
}): boolean {
  return previousKind === 'text' && nextKind === 'tool'
}

export async function sendErrorToThread(
  thread: ThreadChannel,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    1900,
  )
  logger.error(message)
  await sendThreadMessage(thread, `Error: ${message}`, {
    flags: NOTIFY_MESSAGE_FLAGS,
  }).catch((sendError: unknown) => {
    logger.error('Failed to send error to thread', sendError)
  })
}
