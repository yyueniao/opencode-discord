import fs from 'node:fs'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import { getChannelDirectory, getThreadSession } from './db.js'
import {
  NOTIFY_MESSAGE_FLAGS,
  SILENT_MESSAGE_FLAGS,
  isThreadChannelType,
  stripMentions,
} from './discord-utils.js'
import { createLogger, LogPrefix } from './logger.js'
import { ensureOpencodeServer, stopOpencodeServer } from './opencode.js'
import { disposeAllRuntimes, getOrCreateRuntime, preprocessMessage } from './runtime.js'
import { disposeGlobalEventListener } from './events.js'
import { closeDatabase } from './db.js'

const logger = createLogger(LogPrefix.DISCORD)

const MISSING_MESSAGE_CONTENT_REPLY =
  'Message content is empty. Enable the Message Content Intent for this bot in the Discord Developer Portal.'

function isMissingReadableMessageContent(message: Message): boolean {
  return (
    !message.content &&
    message.attachments.size === 0 &&
    message.embeds.length === 0 &&
    !message.poll &&
    message.messageSnapshots.size === 0
  )
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
  })
}

export async function startDiscordBot({
  token,
  discordClient,
}: {
  token: string
  discordClient: Client
}): Promise<void> {
  void ensureOpencodeServer().catch((error: unknown) => {
    logger.error('Failed to start OpenCode server:', error)
  })

  discordClient.on(Events.ClientReady, (readyClient) => {
    logger.log(`Logged in as ${readyClient.user.tag}`)
  })

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    try {
      await handleMessageCreate(discordClient, message)
    } catch (error) {
      logger.error('MessageCreate handler error:', error)
      const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 1900)
      await message
        .reply({ content: `Error: ${errMsg}`, flags: NOTIFY_MESSAGE_FLAGS })
        .catch((sendError: unknown) => {
          logger.error('Failed to send handler error:', sendError)
        })
    }
  })

  if (!discordClient.isReady()) {
    await discordClient.login(token)
  }

  const shutdown = async () => {
    logger.log('Shutting down')
    disposeAllRuntimes()
    disposeGlobalEventListener()
    await stopOpencodeServer()
    await closeDatabase()
    discordClient.destroy()
    process.exit(0)
  }
  process.once('SIGINT', () => {
    void shutdown()
  })
  process.once('SIGTERM', () => {
    void shutdown()
  })
}

async function handleMessageCreate(discordClient: Client, message: Message): Promise<void> {
  if (discordClient.user && message.author?.id === discordClient.user.id) return
  if (message.author?.bot) return

  if (message.partial) {
    await message.fetch()
  }

  const channel = message.channel
  const owningChannelId = isThreadChannelType(channel.type)
    ? (channel as ThreadChannel).parentId || undefined
    : channel.id
  if (!owningChannelId) return

  const channelConfig = await getChannelDirectory(owningChannelId)
  if (!channelConfig) return

  if (isThreadChannelType(channel.type)) {
    await handleThreadMessage({
      discordClient,
      message,
      thread: channel as ThreadChannel,
      projectDirectory: channelConfig.directory,
    })
    return
  }

  if (channel.type === ChannelType.GuildText) {
    await handleChannelMessage({
      message,
      channel,
      projectDirectory: channelConfig.directory,
    })
  }
}

async function handleThreadMessage({
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
  const hasExistingSession = await getThreadSession(thread.id)
  const botMentioned =
    discordClient.user && message.mentions.has(discordClient.user.id)
  const botCreatedThread =
    discordClient.user && thread.ownerId === discordClient.user.id
  if (!hasExistingSession && !botMentioned && !botCreatedThread) {
    logger.log(`Ignoring thread ${thread.id}: no existing session and bot not mentioned`)
    return
  }

  if (!fs.existsSync(projectDirectory)) {
    await message.reply({
      content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
      flags: NOTIFY_MESSAGE_FLAGS,
    })
    return
  }

  if (isMissingReadableMessageContent(message)) {
    await message.reply({
      content: MISSING_MESSAGE_CONTENT_REPLY,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const parentId = thread.parentId
  if (!parentId) return
  const { prompt, images = [] } = await preprocessMessage(message)
  if (!prompt.trim() && images.length === 0) return

  const runtime = getOrCreateRuntime({
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
    images,
  })
}

async function handleChannelMessage({
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
      flags: NOTIFY_MESSAGE_FLAGS,
    })
    return
  }

  if (isMissingReadableMessageContent(message)) {
    await message.reply({
      content: MISSING_MESSAGE_CONTENT_REPLY,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const baseThreadName =
    stripMentions(message.content || '').replace(/\s+/g, ' ').trim() || 'opencode thread'
  const thread = await message.startThread({
    name: baseThreadName.slice(0, 80),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: 'Start OpenCode session',
  })
  await thread.members.add(message.author.id)
  logger.log(`Created thread "${thread.name}" (${thread.id})`)

  const { prompt, images } = await preprocessMessage(message)
  const runtime = getOrCreateRuntime({
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
    images,
  })
}
