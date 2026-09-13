import path from 'node:path'
import { ChannelType, DiscordAPIError, REST, Routes } from 'discord.js'
import type { AppConfig } from '../config.js'

export class DiscordChannelProvisioner {
  constructor(private readonly config: AppConfig) {}

  async createProjectChannel(directory: string): Promise<{
    channelId: string
    channelName: string
    guildId: string
  }> {
    const token = this.config.getDiscordBotToken()
    if (!token) {
      throw new Error('Set DISCORD_BOT_TOKEN')
    }
    const categoryId = this.config.getDiscordCategoryId()
    if (!categoryId) {
      throw new Error('Set DISCORD_CATEGORY_ID')
    }

    const rest = new REST({ version: '10' }).setToken(token)
    let category: { id: string; type: number; guild_id?: string }
    try {
      category = (await rest.get(Routes.channel(categoryId))) as {
        id: string
        type: number
        guild_id?: string
      }
    } catch (error) {
      rethrowDiscord(error, `fetching category ${categoryId}`)
    }
    if (category.type !== ChannelType.GuildCategory) {
      throw new Error('DISCORD_CATEGORY_ID is not a category')
    }
    const guildId = category.guild_id
    if (!guildId) {
      throw new Error('Could not resolve guild from category')
    }

    let created: { id: string; name: string }
    try {
      created = (await rest.post(Routes.guildChannels(guildId), {
        body: {
          name: toDiscordChannelName(directory),
          type: ChannelType.GuildText,
          parent_id: categoryId,
          topic: directory,
        },
      })) as { id: string; name: string }
    } catch (error) {
      rethrowDiscord(error, 'creating the project channel')
    }

    return {
      channelId: created.id,
      channelName: created.name,
      guildId,
    }
  }
}

function toDiscordChannelName(directory: string): string {
  const slug = path
    .basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return slug || 'project'
}

function rethrowDiscord(error: unknown, action: string): never {
  if (error instanceof DiscordAPIError) {
    if (error.code === 50001) {
      throw new Error(
        `Missing Access while ${action}. Invite the bot to the server and grant View Channel + Manage Channels on DISCORD_CATEGORY_ID.`,
      )
    }
    throw new Error(`Discord API error while ${action}: ${error.message} (${error.code})`)
  }
  throw error
}
