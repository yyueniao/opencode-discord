import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SKIP_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  '__pycache__',
  'venv',
  '.venv',
  '.git',
])

const MAX_DEPTH = 6

export async function findGitRepos(root = os.homedir()): Promise<string[]> {
  const found: string[] = []
  await walk(root, 0, found)
  found.sort((a, b) => a.localeCompare(b))
  return found
}

async function walk(dir: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  if (entries.some((entry) => entry.name === '.git')) {
    found.push(dir)
    return
  }
  const children = entries.filter((entry) => {
    if (entry.isSymbolicLink() || !entry.isDirectory()) return false
    if (entry.name.startsWith('.')) return false
    if (SKIP_NAMES.has(entry.name)) return false
    return true
  })
  await Promise.all(
    children.map((entry) => walk(path.join(dir, entry.name), depth + 1, found)),
  )
}
