import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LOG_DIR = join(homedir(), '.config', 'tinstar')
const LOG_FILE = join(LOG_DIR, 'server.log')

mkdirSync(LOG_DIR, { recursive: true })

type Level = 'info' | 'warn' | 'error' | 'debug'

function formatLine(level: Level, tag: string, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const extra = data ? ' ' + JSON.stringify(data) : ''
  return `${ts} [${level.toUpperCase()}] [${tag}] ${msg}${extra}\n`
}

function write(level: Level, tag: string, msg: string, data?: Record<string, unknown>): void {
  const line = formatLine(level, tag, msg, data)
  // Write to both console and file
  if (level === 'error') {
    process.stderr.write(line)
  } else {
    process.stdout.write(line)
  }
  try {
    appendFileSync(LOG_FILE, line)
  } catch {
    // best effort
  }
}

export const log = {
  info: (tag: string, msg: string, data?: Record<string, unknown>) => write('info', tag, msg, data),
  warn: (tag: string, msg: string, data?: Record<string, unknown>) => write('warn', tag, msg, data),
  error: (tag: string, msg: string, data?: Record<string, unknown>) => write('error', tag, msg, data),
  debug: (tag: string, msg: string, data?: Record<string, unknown>) => write('debug', tag, msg, data),
  file: LOG_FILE,
}
