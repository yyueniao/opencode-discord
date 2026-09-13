import os from 'node:os'
import { select } from '@inquirer/prompts'
import { Verbosity } from '../domain/verbosity.js'
import type { App } from '../app.js'

export class Cli {
  constructor(private readonly app: App) {}

  async run(argv: string[]): Promise<void> {
    const command = argv[0] || 'help'
    const rest = argv.slice(1)
    const dataDirFlag = getFlag(argv, '--data-dir') || process.env.OPENCODE_DISCORD_DATA_DIR
    if (dataDirFlag) this.app.config.setDataDir(dataDirFlag)
    const dataDir = this.app.config.ensureDataDir()
    await this.app.envLoader.load(dataDir)

    if (command === 'help' || command === '-h' || command === '--help') {
      printHelp()
      return
    }

    await this.app.database.init()

    if (command === 'add') {
      await this.add(getFlag(rest, '--dir'))
      return
    }

    if (command === 'remove') {
      const channelId = requireFlag(rest, '--channel')
      const removed = await this.app.removeProject.execute(channelId)
      process.stderr.write(removed ? `Removed ${channelId}\n` : `No mapping for ${channelId}\n`)
      return
    }

    if (command === 'list') {
      const rows = await this.app.listProjects.execute()
      if (rows.length === 0) {
        process.stderr.write('No project channels configured.\n')
        return
      }
      for (const row of rows) {
        process.stderr.write(`${row.channelId}  ${row.directory}\n`)
      }
      return
    }

    if (command === 'start') {
      this.app.logFile.init(dataDir)
      this.app.config.setVerbosity(Verbosity.parse(getFlag(rest, '--verbosity')))
      const token = getFlag(rest, '--token') || this.app.config.getDiscordBotToken()
      if (!token) {
        throw new Error('Set DISCORD_BOT_TOKEN or pass --token')
      }
      const client = this.app.bot.createClient()
      this.app.cliLogger.log(`Data dir ${dataDir}`)
      await this.app.bot.start({ token, client })
      return
    }

    printHelp()
    process.exitCode = 1
  }

  private async add(directoryFlag?: string): Promise<void> {
    let directory = directoryFlag
    if (!directory) {
      process.stderr.write('Scanning git repositories in home...\n')
      const repos = await this.app.gitRepos.scan()
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
    const created = await this.app.addProject.execute(directory)
    process.stderr.write(
      `Created #${created.channelName} (${created.channelId}) -> ${created.directory}\n`,
    )
  }
}

function printHelp(): void {
  process.stderr.write(`opencode-discord — Discord proxy for OpenCode

Usage:
  opencode-discord start [--token TOKEN] [--data-dir DIR] [--verbosity LEVEL]
  opencode-discord add [--dir PROJECT_DIR]
  opencode-discord remove --channel CHANNEL_ID
  opencode-discord list
  opencode-discord help

Env:
  DISCORD_BOT_TOKEN     bot token (or --token)
  DISCORD_CATEGORY_ID   category to create project channels in
  OPENCODE_DISCORD_DATA_DIR   data directory (default: ~/.local/share/opencode-discord)

Verbosity:
  text_only
  text_and_essential_tools   (default)
  tools_and_text
`)
}

function getFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function requireFlag(args: string[], name: string): string {
  const value = getFlag(args, name)
  if (!value) {
    throw new Error(`Missing required ${name}`)
  }
  return value
}

function displayPath(directory: string): string {
  const home = os.homedir()
  return directory.startsWith(home) ? `~${directory.slice(home.length)}` : directory
}
