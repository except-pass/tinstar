import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from './configRoot'

const LOG_DIR = getConfigRoot()
const LOG_FILE = join(LOG_DIR, 'server.log')

/** Rotate before the active file exceeds this size. */
const MAX_LOG_BYTES = 32 * 1024 * 1024
/** How many rotated siblings to keep (`server.log.1` … `server.log.N`). */
const KEEP_ROTATED = 3

mkdirSync(LOG_DIR, { recursive: true })

type Level = 'info' | 'warn' | 'error' | 'debug'

function formatLine(level: Level, tag: string, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const extra = data ? ' ' + JSON.stringify(data) : ''
  return `${ts} [${level.toUpperCase()}] [${tag}] ${msg}${extra}\n`
}

/** Size-cap rotation. Best-effort: a failed rotate must never drop the log line. */
function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return
    const size = statSync(LOG_FILE).size
    if (size < MAX_LOG_BYTES) return

    // Shift older slots up, then move the active file into `.1`.
    const oldest = `${LOG_FILE}.${KEEP_ROTATED}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let i = KEEP_ROTATED - 1; i >= 1; i--) {
      const src = `${LOG_FILE}.${i}`
      if (existsSync(src)) renameSync(src, `${LOG_FILE}.${i + 1}`)
    }
    renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    // best effort
  }
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
    rotateIfNeeded()
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
  /** Test/ops hooks — not part of the public logging API. */
  _rotation: { maxBytes: MAX_LOG_BYTES, keep: KEEP_ROTATED, rotateIfNeeded },
}
