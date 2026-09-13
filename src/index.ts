#!/usr/bin/env node
import { App } from './app.js'

const app = new App()
app.run(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
