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
import { parseModelRef } from '../domain/model-selection.js'
import type {
  ChannelProjectRepository,
  ModelSelectionRepository,
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

const MODEL_COMMAND = new SlashCommandBuilder()
  .setName('model')
  .setDescription('Select free model and variant for new sessions')
  .addStringOption((option) =>
    option
      .setName('model')
      .setDescription('provider/model (free models only)')
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName('variant')
      .setDescription('Model variant')
      .setRequired(false)
      .setAutocomplete(true),
  )

const MAX_AUTOCOMPLETE = 25
const MAX_CHOICE = 100

export class SlashCommands {
  readonly definitions = [
    ADD_PROJECT_COMMAND.toJSON(),
    ABORT_COMMAND.toJSON(),
    MODEL_COMMAND.toJSON(),
  ]

  constructor(
    private readonly addProject: AddProject,
    private readonly gitRepos: GitRepoScanner,
    private readonly logger: Logger,
    private readonly runtimes: SessionRuntimeRegistry,
    private readonly threadSessions: ThreadSessionRepository,
    private readonly channelProjects: ChannelProjectRepository,
    private readonly opencode: OpencodeServer,
    private readonly modelSelection: ModelSelectionRepository,
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
    if (interaction.commandName === MODEL_COMMAND.name) {
      await this.model(interaction)
      return
    }
  }

  private async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
      if (interaction.commandName === MODEL_COMMAND.name) {
        await this.autocompleteModel(interaction)
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

  private async autocompleteModel(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true)
    const query = String(focused.value ?? '').toLowerCase()
    try {
      if (focused.name === 'model') {
        const models = await this.opencode.listFreeModels().catch(() => [])
        const choices: { name: string; value: string }[] = []
        for (const m of models) {
          const ref = `${m.providerID}/${m.id}`
          const label = m.name ? `${ref} - ${m.name}` : ref
          if (query && !ref.toLowerCase().includes(query) && !m.name.toLowerCase().includes(query)) {
            continue
          }
          choices.push({ name: label.slice(0, MAX_CHOICE), value: ref.slice(0, MAX_CHOICE) })
          if (choices.length >= MAX_AUTOCOMPLETE) break
        }
        await interaction.respond(choices)
        return
      }
      if (focused.name === 'variant') {
        const modelRef = interaction.options.getString('model')?.trim() ?? ''
        let variants: string[] = []
        if (modelRef) {
          const parsed = parseModelRef(modelRef)
          if (parsed) {
            variants = await this.opencode
              .getFreeModelVariants(parsed.providerID, parsed.modelID)
              .catch(() => [])
          }
        } else {
          // No model selected yet: aggregate distinct variants across free models
          const models = await this.opencode.listFreeModels().catch(() => [])
          const uniq = new Set<string>()
          for (const m of models) for (const v of m.variants) uniq.add(v.id)
          variants = Array.from(uniq)
        }
        const choices = variants
          .filter((v) => !query || v.toLowerCase().includes(query))
          .slice(0, MAX_AUTOCOMPLETE)
          .map((v) => ({ name: v.slice(0, MAX_CHOICE), value: v.slice(0, MAX_CHOICE) }))
        await interaction.respond(choices)
        return
      }
      await interaction.respond([])
    } catch (error) {
      this.logger.error('Model autocomplete error:', error)
      if (!interaction.responded) {
        await interaction.respond([]).catch(() => {})
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

  private async model(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    try {
      const modelArg = interaction.options.getString('model')?.trim() ?? ''
      const variantArg = interaction.options.getString('variant')?.trim() ?? ''

      if (!modelArg) {
        const current = await this.modelSelection.get()
        if (current) {
          const ref = `${current.providerID}/${current.modelID}`
          const variantSuffix = current.variant ? ` variant \`${current.variant}\`` : ' (no variant)'
          let freeCount = ''
          try {
            const free = await this.opencode.listFreeModels()
            freeCount = ` (${free.length} free models available)`
          } catch {}
          await interaction.editReply(
            `Current model: \`${ref}\`${variantSuffix}.${freeCount}\nUse \`/model model:provider/model variant:variant\` to change. Autocomplete shows free models only.`,
          )
        } else {
          let hint = ''
          try {
            const free = await this.opencode.listFreeModels()
            if (free.length > 0) {
              const sample = free
                .slice(0, 5)
                .map((m) => `\`${m.providerID}/${m.id}\``)
                .join(', ')
              hint = `\nAvailable free models include: ${sample}${free.length > 5 ? ` (+${free.length - 5} more)` : ''}`
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            hint = `\nCould not list models: ${msg.slice(0, 200)}`
          }
          await interaction.editReply(
            `No model selected. Use \`/model\` with autocomplete to pick a free model.${hint}`,
          )
        }
        return
      }

      const parsed = parseModelRef(modelArg)
      if (!parsed) {
        await interaction.editReply(
          `Invalid model \`${modelArg}\`. Expected \`provider/model\` (e.g. \`anthropic/claude-sonnet-4\`).`,
        )
        return
      }

      let models: Awaited<ReturnType<OpencodeServer['listFreeModels']>> = []
      try {
        models = await this.opencode.listFreeModels()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        await interaction.editReply(`Failed to list free models: ${msg.slice(0, 1800)}`)
        return
      }

      const match = models.find((m) => m.providerID === parsed.providerID && m.id === parsed.modelID)
      if (!match) {
        const available = models
          .slice(0, 10)
          .map((m) => `${m.providerID}/${m.id}`)
          .join(', ')
        await interaction.editReply(
          `Model \`${modelArg}\` not found among free models. Available: ${available || 'none'}. Use autocomplete.`,
        )
        return
      }

      let variant: string | null = variantArg || null
      const availableVariants = match.variants.map((v) => v.id)
      if (variant) {
        if (availableVariants.length > 0 && !availableVariants.includes(variant)) {
          await interaction.editReply(
            `Variant \`${variant}\` not available for \`${modelArg}\`. Available: ${availableVariants.join(', ') || 'none (omit variant)'}`,
          )
          return
        }
      } else if (availableVariants.length > 0) {
        // Default to first variant if model has variants and none specified
        variant = availableVariants[0] ?? null
      }

      await this.modelSelection.save({
        providerID: parsed.providerID,
        modelID: parsed.modelID,
        variant,
      })

      const variantMsg = variant ? ` variant \`${variant}\`` : ''
      let switchMsg = ''
      // Try to switch active session in this thread if applicable
      try {
        const fetched = interaction.channel
          ? undefined
          : await interaction.client.channels.fetch(interaction.channelId).catch(() => null)
        const channel = (interaction.channel ?? fetched) as unknown as ThreadChannel | null
        if (channel && typeof channel.isThread === 'function' && channel.isThread()) {
          const threadId = channel.id
          const parentId = channel.parentId
          const sessionId = await this.threadSessions.findSessionId(threadId)
          const project = parentId ? await this.channelProjects.findByChannelId(parentId) : undefined
          if (sessionId && project) {
            const getClient = await this.opencode.initializeForDirectory(project.directory)
            const client = getClient()
            const result = await client.v2.session.switchModel({
              sessionID: sessionId,
              model: {
                providerID: parsed.providerID,
                modelID: parsed.modelID,
                variant: variant ?? undefined,
              },
            } as unknown as Parameters<(typeof client)['v2']['session']['switchModel']>[0])
            // Some SDKs use session.switchModel with different shape; try alternative if error
            if (result && typeof result === 'object' && 'error' in result && result.error) {
              this.logger.warn('switchModel failed, will rely on next promptAsync model override:', result.error)
            } else {
              switchMsg = ' Active session switched.'
            }
          }
        }
      } catch (error) {
        this.logger.warn('Failed to switch active session model:', error)
      }

      await interaction.editReply(`✓ Model set to \`${modelArg}\`${variantMsg}. New sessions will use it.${switchMsg}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('model command error:', error)
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
