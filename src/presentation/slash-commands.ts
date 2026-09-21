import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ThreadChannel,
} from 'discord.js'
import type { AddProject } from '../application/add-project.js'
import type { SessionRuntimeRegistry } from '../application/session-runtime-registry.js'
import type {
  ChannelProjectRepository,
  ThreadSessionRepository,
} from '../domain/repositories.js'
import type { GitRepoScanner } from '../infrastructure/git-repo-scanner.js'
import type { Logger } from '../infrastructure/logger.js'
import type { OpencodeServer } from '../infrastructure/opencode-server.js'

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

const ABORT_COMMAND = new SlashCommandBuilder()
  .setName('abort')
  .setDescription('Stop the current OpenCode run in this thread')

const MAX_AUTOCOMPLETE = 25
const MAX_CHOICE = 100

export class SlashCommands {
  readonly definitions = [ADD_PROJECT_COMMAND.toJSON(), ABORT_COMMAND.toJSON()]

  constructor(
    private readonly addProject: AddProject,
    private readonly gitRepos: GitRepoScanner,
    private readonly logger: Logger,
    private readonly runtimes: SessionRuntimeRegistry,
    private readonly threadSessions: ThreadSessionRepository,
    private readonly channelProjects: ChannelProjectRepository,
    private readonly opencode: OpencodeServer,
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
    if (interaction.commandName === ABORT_COMMAND.name) {
      await this.abort(interaction)
      return
    }
  }

  private async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
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

  private async abort(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply()
    try {
      const fetched = interaction.channel
        ? undefined
        : await interaction.client.channels.fetch(interaction.channelId).catch(() => null)
      const channel = (interaction.channel ?? fetched) as unknown as ThreadChannel | null
      if (!channel || typeof channel.isThread !== 'function' || !channel.isThread()) {
        await interaction.editReply('Use /abort inside a session thread to stop its current run.')
        return
      }
      const thread = channel as ThreadChannel
      const threadId = thread.id
      const parentId = thread.parentId
      if (!parentId) {
        await interaction.editReply('Use /abort inside a session thread to stop its current run.')
        return
      }

      const runtime = this.runtimes.get(threadId)
      if (runtime) {
        const aborted = await runtime.abort()
        await interaction.editReply(
          aborted ? '⬦ Aborted current run.' : '⬦ Nothing running – session is idle.',
        )
        return
      }

      const [project, sessionId] = await Promise.all([
        this.channelProjects.findByChannelId(parentId),
        this.threadSessions.findSessionId(threadId),
      ])
      if (!project || !sessionId) {
        await interaction.editReply('⬦ No active session in this thread.')
        return
      }
      const getClient = await this.opencode.initializeForDirectory(project.directory)
      const result = await getClient().session.abort({
        sessionID: sessionId,
        directory: project.directory,
      })
      if (result.error) {
        const message =
          typeof result.error === 'object' && result.error && 'message' in result.error
            ? String(result.error.message)
            : 'abort failed'
        throw new Error(message)
      }
      await interaction.editReply(
        result.data ? '⬦ Aborted current run.' : '⬦ Nothing running – session is idle.',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('abort command error:', error)
      await interaction.editReply(`Error: ${message.slice(0, 1900)}`)
    }
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
