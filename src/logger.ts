import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import pc from 'picocolors'
import { getLogPath } from './config.js'

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

let logFilePath: string | null = null

export function initLogFile(dataDir: string): void {
  logFilePath = path.join(dataDir, 'opencode-discord.log')
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
  fs.writeFileSync(logFilePath, '')
}

function writeFile(line: string): void {
  if (!logFilePath) {
    logFilePath = getLogPath()
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
  }
  fs.appendFileSync(logFilePath, `${line}\n`)
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

export function createLogger(prefix: LogPrefixType) {
  const padded = prefix.padEnd(MAX_PREFIX_LENGTH)
  return {
    log(...args: unknown[]) {
      const body = formatArgs(args)
      const line = `${new Date().toISOString()} ${padded} ${body}`
      process.stderr.write(`${pc.dim(padded)} ${body}\n`)
      writeFile(line)
    },
    warn(...args: unknown[]) {
      const body = formatArgs(args)
      const line = `${new Date().toISOString()} ${padded} WARN ${body}`
      process.stderr.write(`${pc.yellow(padded)} ${body}\n`)
      writeFile(line)
    },
    error(...args: unknown[]) {
      const body = formatArgs(args)
      const line = `${new Date().toISOString()} ${padded} ERROR ${body}`
      process.stderr.write(`${pc.red(padded)} ${body}\n`)
      writeFile(line)
    },
  }
}
