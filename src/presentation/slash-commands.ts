import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js'
import type { AddProject } from '../application/add-project.js'
import type { ListMemories } from '../application/list-memories.js'
import type { Memory } from '../domain/memory.js'
import type { GitRepoScanner } from '../infrastructure/git-repo-scanner.js'
import type { Logger } from '../infrastructure/logger.js'

const ADD_PROJECT_COMMAND = new SlashCommandBuilder()
  .setName('add-project')
  .setDescription('Add a git project and create a Discord channel')
  .addStringOption((option) =>
    option
      .setName('project')
      .setDescription('Project directory to add')
      .setRequired(true)
      .setAutocomplete(true),
  )

const MEMORY_COMMAND = new SlashCommandBuilder()
  .setName('memory')
  .setDescription('List saved memories for a project')
  .addStringOption((option) =>
    option
      .setName('project')
      .setDescription('Project to list memories for')
      .setRequired(false)
      .setAutocomplete(true),
  )

const MAX_AUTOCOMPLETE = 25
const MAX_CHOICE = 100

export class SlashCommands {
  readonly definitions = [ADD_PROJECT_COMMAND.toJSON(), MEMORY_COMMAND.toJSON()]

  constructor(
    private readonly addProject: AddProject,
    private readonly listMemories: ListMemories,
    private readonly gitRepos: GitRepoScanner,
    private readonly logger: Logger,
  ) {}

  async ready(): Promise<void> {
    await this.gitRepos.list()
  }

  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.autocomplete(interaction)
      return
    }
    if (!interaction.isChatInputCommand()) return
    if (interaction.commandName === ADD_PROJECT_COMMAND.name) {
      await this.add(interaction)
      return
    }
    if (interaction.commandName === MEMORY_COMMAND.name) {
      await this.memory(interaction)
    }
  }

  private async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
      if (interaction.commandName === MEMORY_COMMAND.name) {
        await this.autocompleteMemory(interaction)
        return
      }
      const query = interaction.options.getFocused().toLowerCase()
      const repos = await this.gitRepos.list()
      const choices: { name: string; value: string }[] = []
      for (const repo of repos) {
        const name = this.gitRepos.displayPath(repo)
        if (query && !name.toLowerCase().includes(query) && !repo.toLowerCase().includes(query)) {
          continue
        }
        const value = autocompleteValue(repo)
        if (!value) continue
        choices.push({ name: name.slice(0, MAX_CHOICE), value })
        if (choices.length >= MAX_AUTOCOMPLETE) break
      }
      await interaction.respond(choices)
    } catch (error) {
      this.logger.error('Autocomplete handler error:', error)
      if (!interaction.responded) {
        await interaction.respond([]).catch((sendError: unknown) => {
          this.logger.error('Failed to send autocomplete response:', sendError)
        })
      }
    }
  }

  private async autocompleteMemory(interaction: AutocompleteInteraction): Promise<void> {
    const query = interaction.options.getFocused().toLowerCase()
    const projects = await this.listMemories.projects()
    const choices: { name: string; value: string }[] = []
    for (const project of projects) {
      const name = this.gitRepos.displayPath(project.directory)
      if (
        query &&
        !name.toLowerCase().includes(query) &&
        !project.directory.toLowerCase().includes(query)
      ) {
        continue
      }
      choices.push({
        name: name.slice(0, MAX_CHOICE),
        value: project.channelId,
      })
      if (choices.length >= MAX_AUTOCOMPLETE) break
    }
    await interaction.respond(choices)
  }

  private async add(interaction: ChatInputCommandInteraction): Promise<void> {
    const raw = interaction.options.getString('project', true)
    const directory = resolveProjectDirectory(raw)
    await interaction.deferReply()
    try {
      const created = await this.addProject.execute(directory)
      await interaction.editReply(
        `Created <#${created.channelId}> (\`${created.channelName}\`) -> ${created.directory}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('add-project command error:', error)
      await interaction.editReply(`Error: ${message.slice(0, 1900)}`)
    }
  }

  private async memory(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const selected = interaction.options.getString('project')
      const channelId = selected || (await owningChannelId(interaction))
      const result = channelId ? await this.listMemories.forChannel(channelId) : undefined
      if (!result) {
        await interaction.reply(
          selected
            ? 'Unknown project.'
            : 'Choose a project with the `project` option.',
        )
        return
      }
      await interaction.reply(
        formatMemories(this.gitRepos.displayPath(result.project.directory), result.memories),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('memory command error:', error)
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(`Error: ${message.slice(0, 1900)}`)
        return
      }
      await interaction.reply(`Error: ${message.slice(0, 1900)}`)
    }
  }
}

function formatMemories(displayPath: string, memories: Memory[]): string {
  const header = `Memories for \`${displayPath}\``
  if (memories.length === 0) return `${header}\n\nNo memories saved yet.`
  const lines = memories.map((memory, index) => {
    const who = memory.username || memory.userId || 'unknown'
    return `${index + 1}. ${who} — ${memory.fact}`
  })
  const body = `${header}\n\n${lines.join('\n')}`
  return body.length > 1900 ? `${body.slice(0, 1900)}\n…` : body
}

async function owningChannelId(
  interaction: ChatInputCommandInteraction,
): Promise<string | undefined> {
  const channel =
    interaction.channel ??
    (interaction.channelId
      ? await interaction.client.channels.fetch(interaction.channelId).catch(() => null)
      : null)
  if (channel?.isThread()) return channel.parentId ?? undefined
  return channel?.id ?? interaction.channelId
}

function autocompleteValue(directory: string): string | undefined {
  if (directory.length <= MAX_CHOICE) return directory
  const home = os.homedir()
  const prefix = home.endsWith(path.sep) ? home : home + path.sep
  if (directory.startsWith(prefix)) {
    const relative = directory.slice(prefix.length)
    if (relative.length <= MAX_CHOICE) return relative
  }
  return undefined
}

function resolveProjectDirectory(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  if (path.isAbsolute(value)) return value
  const fromHome = path.join(os.homedir(), value)
  if (fs.existsSync(fromHome)) return fromHome
  return path.resolve(value)
}
