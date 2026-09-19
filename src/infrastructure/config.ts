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

  getOpencodeModel(): { providerID: string; modelID: string } {
    const raw = process.env.OPENCODE_DISCORD_MODEL
    if (!raw) {
      throw new Error('Set OPENCODE_DISCORD_MODEL')
    }
    const slash = raw.indexOf('/')
    if (slash <= 0 || slash === raw.length - 1) {
      throw new Error(
        `OPENCODE_DISCORD_MODEL must be provider/model, got ${JSON.stringify(raw)}`,
      )
    }
    return {
      providerID: raw.slice(0, slash),
      modelID: raw.slice(slash + 1),
    }
  }

  getOpencodeVariant(): string {
    const variant = process.env.OPENCODE_DISCORD_VARIANT
    if (!variant) {
      throw new Error('Set OPENCODE_DISCORD_VARIANT')
    }
    return variant
  }

  getOpencodeAuthHeaders(): Record<string, string> {
    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD
    if (!serverPassword) return {}
    const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
    const encoded = Buffer.from(`${username}:${serverPassword}`).toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }
}
