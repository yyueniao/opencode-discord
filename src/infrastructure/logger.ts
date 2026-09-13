import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import pc from 'picocolors'
import type { AppConfig } from './config.js'

export const LogPrefix = {
  CLI: 'CLI',
  DB: 'DB',
  DISCORD: 'DISCORD',
  FORMAT: 'FORMAT',
  OPENCODE: 'OPENCODE',
  SESSION: 'SESSION',
} as const

export type LogPrefixType = (typeof LogPrefix)[keyof typeof LogPrefix]

const MAX_PREFIX_LENGTH = Math.max(
  ...Object.values(LogPrefix).map((prefix) => prefix.length),
)

export class LogFile {
  private logFilePath: string | null = null

  constructor(private readonly config: AppConfig) {}

  init(dataDir: string): void {
    this.logFilePath = path.join(dataDir, 'opencode-discord.log')
    fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true })
    fs.writeFileSync(this.logFilePath, '')
  }

  write(line: string): void {
    if (!this.logFilePath) {
      this.logFilePath = this.config.getLogPath()
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true })
    }
    fs.appendFileSync(this.logFilePath, `${line}\n`)
  }
}

export class Logger {
  constructor(
    private readonly prefix: LogPrefixType,
    private readonly logFile: LogFile,
  ) {}

  log(...args: unknown[]): void {
    const padded = this.prefix.padEnd(MAX_PREFIX_LENGTH)
    const body = formatArgs(args)
    const line = `${new Date().toISOString()} ${padded} ${body}`
    process.stderr.write(`${pc.dim(padded)} ${body}\n`)
    this.logFile.write(line)
  }

  warn(...args: unknown[]): void {
    const padded = this.prefix.padEnd(MAX_PREFIX_LENGTH)
    const body = formatArgs(args)
    const line = `${new Date().toISOString()} ${padded} WARN ${body}`
    process.stderr.write(`${pc.yellow(padded)} ${body}\n`)
    this.logFile.write(line)
  }

  error(...args: unknown[]): void {
    const padded = this.prefix.padEnd(MAX_PREFIX_LENGTH)
    const body = formatArgs(args)
    const line = `${new Date().toISOString()} ${padded} ERROR ${body}`
    process.stderr.write(`${pc.red(padded)} ${body}\n`)
    this.logFile.write(line)
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack || arg.message
      return util.inspect(arg, { depth: 4, colors: false })
    })
    .join(' ')
}
