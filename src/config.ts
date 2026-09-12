import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { xdgData } from 'xdg-basedir'

let dataDir = path.join(xdgData || os.homedir(), 'opencode-discord')

export function setDataDir(dir: string): void {
  dataDir = path.resolve(dir)
}

export function getDataDir(): string {
  return dataDir
}

export function ensureDataDir(): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return dataDir
}

export function getDbPath(): string {
  return path.join(getDataDir(), 'sessions.db')
}

export function getLogPath(): string {
  return path.join(getDataDir(), 'opencode-discord.log')
}

export type Verbosity = 'text_only' | 'text_and_essential_tools' | 'tools_and_text'

let verbosity: Verbosity = 'text_and_essential_tools'

export function setVerbosity(value: Verbosity): void {
  verbosity = value
}

export function getVerbosity(): Verbosity {
  return verbosity
}

export function parseVerbosity(value: string | undefined): Verbosity {
  if (
    value === 'text_only' ||
    value === 'text_and_essential_tools' ||
    value === 'tools_and_text'
  ) {
    return value
  }
  return 'text_and_essential_tools'
}
