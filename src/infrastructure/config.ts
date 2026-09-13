import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { xdgData } from 'xdg-basedir'
import { Verbosity } from '../domain/verbosity.js'

export class AppConfig {
  private dataDir = path.join(xdgData || os.homedir(), 'opencode-discord')
  private verbosity = Verbosity.TextAndEssentialTools

  setDataDir(dir: string): void {
    this.dataDir = path.resolve(dir)
  }

  getDataDir(): string {
    return this.dataDir
  }

  ensureDataDir(): string {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    return this.dataDir
  }

  getDbPath(): string {
    return path.join(this.getDataDir(), 'sessions.db')
  }

  getLogPath(): string {
    return path.join(this.getDataDir(), 'opencode-discord.log')
  }

  setVerbosity(value: Verbosity): void {
    this.verbosity = value
  }

  getVerbosity(): Verbosity {
    return this.verbosity
  }

  getDiscordBotToken(): string | undefined {
    return process.env.DISCORD_BOT_TOKEN || process.env.KIMAKI_BOT_TOKEN
  }

  getDiscordCategoryId(): string | undefined {
    return process.env.DISCORD_CATEGORY_ID
  }

  getOpencodePort(): number | undefined {
    const port = Number(process.env.OPENCODE_PORT)
    return port || undefined
  }

  getOpencodeAuthHeaders(): Record<string, string> {
    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD
    if (!serverPassword) return {}
    const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
    const encoded = Buffer.from(`${username}:${serverPassword}`).toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }
}
