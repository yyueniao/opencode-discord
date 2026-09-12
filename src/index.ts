#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseVerbosity, setDataDir, setVerbosity, ensureDataDir } from './config.js'
import { addProject } from './add-project.js'
import {
  deleteChannelDirectory,
  initDatabase,
  listChannelDirectories,
} from './db.js'
import { createDiscordClient, startDiscordBot } from './discord-bot.js'
import { initLogFile } from './logger.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.CLI)

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

async function loadDotEnv(dataDir: string): Promise<void> {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(dataDir, '.env'),
  ]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const text = await fs.promises.readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = value
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0] || 'help'
  const rest = argv.slice(1)
  const dataDirFlag = getFlag(argv, '--data-dir') || process.env.OPENCODE_DISCORD_DATA_DIR
  if (dataDirFlag) setDataDir(dataDirFlag)
  const dataDir = ensureDataDir()
  await loadDotEnv(dataDir)

  if (command === 'help' || command === '-h' || command === '--help') {
    printHelp()
    return
  }

  await initDatabase()

  if (command === 'add') {
    await addProject(getFlag(rest, '--dir'))
    return
  }

  if (command === 'remove') {
    const channelId = requireFlag(rest, '--channel')
    const removed = await deleteChannelDirectory(channelId)
    process.stderr.write(removed ? `Removed ${channelId}\n` : `No mapping for ${channelId}\n`)
    return
  }

  if (command === 'list') {
    const rows = await listChannelDirectories()
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
    initLogFile(dataDir)
    setVerbosity(parseVerbosity(getFlag(rest, '--verbosity')))
    const token =
      getFlag(rest, '--token') ||
      process.env.DISCORD_BOT_TOKEN ||
      process.env.KIMAKI_BOT_TOKEN
    if (!token) {
      throw new Error('Set DISCORD_BOT_TOKEN or pass --token')
    }
    const discordClient = createDiscordClient()
    logger.log(`Data dir ${dataDir}`)
    await startDiscordBot({ token, discordClient })
    return
  }

  printHelp()
  process.exitCode = 1
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
