import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { select } from '@inquirer/prompts'
import { ChannelType, DiscordAPIError, REST, Routes } from 'discord.js'
import { setChannelDirectory } from './db.js'
import { findGitRepos } from './git-repos.js'

function toDiscordChannelName(directory: string): string {
  const slug = path
    .basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return slug || 'project'
}

function displayPath(directory: string): string {
  const home = os.homedir()
  return directory.startsWith(home) ? `~${directory.slice(home.length)}` : directory
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

export async function addProject(directoryFlag?: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN || process.env.KIMAKI_BOT_TOKEN
  if (!token) {
    throw new Error('Set DISCORD_BOT_TOKEN')
  }
  const categoryId = process.env.DISCORD_CATEGORY_ID
  if (!categoryId) {
    throw new Error('Set DISCORD_CATEGORY_ID')
  }

  let directory = directoryFlag
  if (!directory) {
    process.stderr.write('Scanning git repositories in home...\n')
    const repos = await findGitRepos()
    if (repos.length === 0) {
      throw new Error('No git repositories found in home directory')
    }
    directory = await select({
      message: 'Select project directory',
      choices: repos.map((repo) => ({
        name: displayPath(repo),
        value: repo,
      })),
    })
  }

  directory = path.resolve(directory)
  if (!fs.existsSync(directory)) {
    throw new Error(`Directory does not exist: ${directory}`)
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

  await setChannelDirectory({
    channelId: created.id,
    directory,
    guildId,
  })
  process.stderr.write(`Created #${created.name} (${created.id}) -> ${directory}\n`)
}
