import fs from 'node:fs'
import { createClient, type Client } from '@libsql/client'
import { ChannelProject } from '../domain/channel-project.js'
import type {
  ChannelProjectRepository,
  PartMessageRepository,
  ThreadSessionRepository,
} from '../domain/repositories.js'
import type { AppConfig } from './config.js'
import type { Logger } from './logger.js'

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

export class Database {
  private client: Client | null = null

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    this.config.ensureDataDir()
    const dbPath = this.config.getDbPath()
    if (!fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, '')
    }
    this.client = createClient({ url: `file:${dbPath}` })
    for (const statement of SCHEMA) {
      await this.client.execute(statement)
    }
    this.logger.log(`Opened ${dbPath}`)
  }

  getClient(): Client {
    if (!this.client) {
      throw new Error('Database not initialized')
    }
    return this.client
  }

  async close(): Promise<void> {
    this.client?.close()
    this.client = null
  }
}

export class SqliteChannelProjectRepository implements ChannelProjectRepository {
  constructor(private readonly database: Database) {}

  async findByChannelId(channelId: string): Promise<ChannelProject | undefined> {
    const result = await this.database.getClient().execute({
      sql: 'SELECT directory, guild_id FROM channel_directories WHERE channel_id = ?',
      args: [channelId],
    })
    const row = result.rows[0]
    if (!row) return undefined
    const directory = row.directory
    if (typeof directory !== 'string') return undefined
    return new ChannelProject(
      channelId,
      directory,
      typeof row.guild_id === 'string' ? row.guild_id : null,
    )
  }

  async save(project: ChannelProject): Promise<void> {
    await this.database.getClient().execute({
      sql: `INSERT INTO channel_directories (channel_id, directory, guild_id)
            VALUES (?, ?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET directory = excluded.directory, guild_id = excluded.guild_id`,
      args: [project.channelId, project.directory, project.guildId],
    })
  }

  async delete(channelId: string): Promise<boolean> {
    const result = await this.database.getClient().execute({
      sql: 'DELETE FROM channel_directories WHERE channel_id = ?',
      args: [channelId],
    })
    return result.rowsAffected > 0
  }

  async list(): Promise<ChannelProject[]> {
    const result = await this.database.getClient().execute(
      'SELECT channel_id, directory, guild_id FROM channel_directories',
    )
    return result.rows.map(
      (row) =>
        new ChannelProject(
          String(row.channel_id),
          String(row.directory),
          typeof row.guild_id === 'string' ? row.guild_id : null,
        ),
    )
  }
}

export class SqliteThreadSessionRepository implements ThreadSessionRepository {
  constructor(private readonly database: Database) {}

  async findSessionId(threadId: string): Promise<string | undefined> {
    const result = await this.database.getClient().execute({
      sql: 'SELECT session_id FROM thread_sessions WHERE thread_id = ?',
      args: [threadId],
    })
    const sessionId = result.rows[0]?.session_id
    return typeof sessionId === 'string' ? sessionId : undefined
  }

  async save(threadId: string, sessionId: string): Promise<void> {
    await this.database.getClient().execute({
      sql: `INSERT INTO thread_sessions (thread_id, session_id, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      args: [threadId, sessionId, Date.now()],
    })
  }
}

export class SqlitePartMessageRepository implements PartMessageRepository {
  constructor(private readonly database: Database) {}

  async save({
    partId,
    messageId,
    threadId,
  }: {
    partId: string
    messageId: string
    threadId: string
  }): Promise<void> {
    await this.database.getClient().execute({
      sql: `INSERT INTO part_messages (part_id, message_id, thread_id)
            VALUES (?, ?, ?)
            ON CONFLICT(part_id) DO UPDATE SET message_id = excluded.message_id`,
      args: [partId, messageId, threadId],
    })
  }

  async exists(partId: string): Promise<boolean> {
    const result = await this.database.getClient().execute({
      sql: 'SELECT 1 FROM part_messages WHERE part_id = ? LIMIT 1',
      args: [partId],
    })
    return Boolean(result.rows[0])
  }
}
