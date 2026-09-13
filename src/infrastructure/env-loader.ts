import fs from 'node:fs'
import path from 'node:path'

export class EnvLoader {
  async load(dataDir: string): Promise<void> {
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
}
