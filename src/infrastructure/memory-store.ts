import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Memory } from '../domain/memory.js'
import type { MemoryRepository } from '../domain/repositories.js'
import type { AppConfig } from './config.js'

const EMPTY = { memories: [] as Memory[] }

export class JsonMemoryStore implements MemoryRepository {
  constructor(private readonly config: AppConfig) {}

  filePath(directory: string): string {
    const dir = this.config.ensureMemoriesDir()
    return path.join(dir, memoryFileName(directory))
  }

  async list(directory: string): Promise<Memory[]> {
    const file = this.filePath(directory)
    try {
      const raw = await fs.promises.readFile(file, 'utf8')
      return normalize(JSON.parse(raw))
    } catch {
      return []
    }
  }

  async ensure(directory: string): Promise<void> {
    const file = this.filePath(directory)
    try {
      await fs.promises.access(file)
    } catch {
      await fs.promises.writeFile(file, `${JSON.stringify(EMPTY, null, 2)}\n`, {
        mode: 0o600,
      })
    }
  }
}

function memoryFileName(directory: string): string {
  const resolved = path.resolve(directory)
  const slug =
    path
      .basename(resolved)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 12)
  return `${slug}-${hash}.json`
}

function normalize(parsed: unknown): Memory[] {
  const items = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { memories?: unknown }).memories)
      ? (parsed as { memories: unknown[] }).memories
      : []
  const memories: Memory[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const fact = typeof record.fact === 'string' ? record.fact.trim() : ''
    if (!fact) continue
    memories.push({
      userId: typeof record.userId === 'string' ? record.userId : '',
      username: typeof record.username === 'string' ? record.username : '',
      fact,
    })
  }
  return memories
}
