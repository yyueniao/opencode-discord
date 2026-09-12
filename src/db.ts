import fs from 'node:fs'
import { createClient, type Client } from '@libsql/client'
import { getDbPath, ensureDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.DB)

let client: Client | null = null

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS channel_directories (
    channel_id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    guild_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS thread_sessions (
    thread_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS part_messages (
    part_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL
  )`,
]

export async function initDatabase(): Promise<void> {
  ensureDataDir()
  const dbPath = getDbPath()
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, '')
  }
  client = createClient({ url: `file:${dbPath}` })
  for (const statement of SCHEMA) {
    await client.execute(statement)
  }
  logger.log(`Opened ${dbPath}`)
}

function db(): Client {
  if (!client) {
    throw new Error('Database not initialized')
  }
  return client
}

export async function closeDatabase(): Promise<void> {
  client?.close()
  client = null
}

export async function getChannelDirectory(
  channelId: string,
): Promise<{ directory: string; guildId: string | null } | undefined> {
  const result = await db().execute({
    sql: 'SELECT directory, guild_id FROM channel_directories WHERE channel_id = ?',
    args: [channelId],
  })
  const row = result.rows[0]
  if (!row) return undefined
  const directory = row.directory
  if (typeof directory !== 'string') return undefined
  return {
    directory,
    guildId: typeof row.guild_id === 'string' ? row.guild_id : null,
  }
}

export async function setChannelDirectory({
  channelId,
  directory,
  guildId,
}: {
  channelId: string
  directory: string
  guildId?: string
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO channel_directories (channel_id, directory, guild_id)
          VALUES (?, ?, ?)
          ON CONFLICT(channel_id) DO UPDATE SET directory = excluded.directory, guild_id = excluded.guild_id`,
    args: [channelId, directory, guildId ?? null],
  })
}

export async function deleteChannelDirectory(channelId: string): Promise<boolean> {
  const result = await db().execute({
    sql: 'DELETE FROM channel_directories WHERE channel_id = ?',
    args: [channelId],
  })
  return result.rowsAffected > 0
}

export async function listChannelDirectories(): Promise<
  Array<{
    channelId: string
    directory: string
    guildId: string | null
  }>
> {
  const result = await db().execute(
    'SELECT channel_id, directory, guild_id FROM channel_directories',
  )
  return result.rows.map((row) => ({
    channelId: String(row.channel_id),
    directory: String(row.directory),
    guildId: typeof row.guild_id === 'string' ? row.guild_id : null,
  }))
}

export async function getThreadSession(threadId: string): Promise<string | undefined> {
  const result = await db().execute({
    sql: 'SELECT session_id FROM thread_sessions WHERE thread_id = ?',
    args: [threadId],
  })
  const sessionId = result.rows[0]?.session_id
  return typeof sessionId === 'string' ? sessionId : undefined
}

export async function setThreadSession(
  threadId: string,
  sessionId: string,
): Promise<void> {
  await db().execute({
    sql: `INSERT INTO thread_sessions (thread_id, session_id, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    args: [threadId, sessionId, Date.now()],
  })
}

export async function setPartMessage({
  partId,
  messageId,
  threadId,
}: {
  partId: string
  messageId: string
  threadId: string
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO part_messages (part_id, message_id, thread_id)
          VALUES (?, ?, ?)
          ON CONFLICT(part_id) DO UPDATE SET message_id = excluded.message_id`,
    args: [partId, messageId, threadId],
  })
}

export async function hasPartMessage(partId: string): Promise<boolean> {
  const result = await db().execute({
    sql: 'SELECT 1 FROM part_messages WHERE part_id = ? LIMIT 1',
    args: [partId],
  })
  return Boolean(result.rows[0])
}
