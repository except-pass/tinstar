import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { readTail } from './transcript-parser'
import type { RecapEntry } from '../../types'

/** Resolve at call time so tests and managed launches honor a changed CODEX_HOME. */
export function codexHomeDir(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CODEX_HOME?.trim()
  return configured || join(homedir(), '.codex')
}

export function codexSessionsDir(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(codexHomeDir(environment), 'sessions')
}

// --- Utilities ---

/** Read the last N bytes of a file and return as string. */
function tailBytes(filePath: string, bytes: number): string {
  const size = statSync(filePath).size
  if (size === 0) return ''
  const fd = openSync(filePath, 'r')
  try {
    const readFrom = Math.max(0, size - bytes)
    const buf = Buffer.alloc(Math.min(bytes, size))
    readSync(fd, buf, 0, buf.length, readFrom)
    return buf.toString('utf-8')
  } finally {
    closeSync(fd)
  }
}

/** Extract agent message text from JSONL lines. */
function extractAgentMessages(jsonlText: string): string[] {
  const messages: string[] = []
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type !== 'event_msg') continue
      const p = obj.payload
      if (p?.type === 'agent_message' && p.message) {
        messages.push(p.message)
      } else if (p?.type === 'task_complete' && p.last_agent_message) {
        messages.push(p.last_agent_message)
      }
    } catch { /* skip malformed */ }
  }
  return messages
}

/** List candidate JSONL files from the creation date through today. */
function listCandidateFiles(createdAt: string): string[] {
  const sessionsDir = codexSessionsDir()
  if (!existsSync(sessionsDir)) return []
  const startDate = new Date(createdAt)
  const today = new Date()
  const files: string[] = []

  for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear().toString()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const dayDir = join(sessionsDir, yyyy, mm, dd)
    if (!existsSync(dayDir)) continue
    try {
      for (const f of readdirSync(dayDir)) {
        if (f.endsWith('.jsonl')) files.push(join(dayDir, f))
      }
    } catch { /* skip unreadable dirs */ }
  }

  // Most recent first
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

/** Read the first line of a file to get session_meta. Codex's first line can be 15KB+ (includes system prompt). */
function readSessionMeta(filePath: string): { cwd: string; timestamp: string } | null {
  try {
    const size = statSync(filePath).size
    const fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(Math.min(32_768, size))
    const bytesRead = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0]
    if (!firstLine) return null
    const obj = JSON.parse(firstLine)
    if (obj.type !== 'session_meta') return null
    return {
      cwd: obj.payload?.cwd ?? '',
      timestamp: obj.payload?.timestamp ?? obj.timestamp ?? '',
    }
  } catch {
    return null
  }
}

// --- Discovery ---

/**
 * Discover the Codex JSONL transcript for a Tinstar session.
 * Matches by workdir, then cross-references agent text against tmux pane.
 */
export async function discoverTranscript(
  sessionName: string,
  workdir: string,
  createdAt: string,
  tmuxTarget: string,
  captureScreen?: (tmuxName: string, scrollback?: number) => Promise<string>,
): Promise<string | null> {
  const candidates = listCandidateFiles(createdAt)
  const cwdMatches = candidates.filter(f => {
    const meta = readSessionMeta(f)
    return meta && meta.cwd === workdir
  })

  if (cwdMatches.length === 0) return null
  if (cwdMatches.length === 1) return cwdMatches[0]!

  // Multiple matches — cross-reference with tmux pane
  let tmuxText: string
  try {
    if (!captureScreen) return cwdMatches[0]!
    tmuxText = await captureScreen(tmuxTarget, 200)
  } catch {
    // Can't capture pane — return most recent match
    return cwdMatches[0]!
  }

  for (const f of cwdMatches) {
    const tail = tailBytes(f, 8192)
    const messages = extractAgentMessages(tail)
    for (const msg of messages) {
      const snippet = msg.slice(0, 120)
      if (snippet.length >= 30 && tmuxText.includes(snippet)) {
        log.info('codex-transcript', `${sessionName}: matched via text: "${snippet.slice(0, 60)}..."`)
        return f
      }
    }
  }

  // No text match — fall back to most recent cwd match
  log.info('codex-transcript', `${sessionName}: no text match, using most recent cwd match`)
  return cwdMatches[0]!
}

// --- Status parsing ---

/**
 * Read session status from a Codex JSONL transcript.
 * Scans backwards for lifecycle events or activity signals:
 * - task_complete → idle
 * - task_started, response_item, function_call, agent_message → running
 */
export function readCodexStatus(transcriptPath: string): 'running' | 'idle' | null {
  if (!existsSync(transcriptPath)) return null
  const lines = readTail(transcriptPath, 20)

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!)
      if (obj.type === 'event_msg') {
        const sub = obj.payload?.type
        if (sub === 'task_complete') return 'idle'
        if (sub === 'task_started' || sub === 'agent_message' || sub === 'user_message') return 'running'
      }
      // response_item entries (function_call, reasoning, etc.) mean the model is active
      if (obj.type === 'response_item') return 'running'
    } catch { /* skip */ }
  }
  return null
}

export interface CodexUserMessageEvidence {
  message: string
  timestamp: string | null
}

export interface CodexUserMessageScan {
  available: boolean
  evidence: CodexUserMessageEvidence | null
  identity: string | null
  /** Byte boundary after the last complete JSONL record inspected. */
  nextOffset: number
}

function userMessageEvidence(
  line: string,
  matches: (message: string) => boolean,
): CodexUserMessageEvidence | null {
  if (!line.trim()) return null
  try {
    const event = JSON.parse(line)
    const message = event.type === 'event_msg'
      && event.payload?.type === 'user_message'
      && typeof event.payload.message === 'string'
      ? event.payload.message
      : null
    if (message === null || !matches(message)) return null
    return {
      message,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
    }
  } catch {
    return null
  }
}

/**
 * Incrementally scan complete rollout records without monopolizing the event
 * loop between chunks. `nextOffset` deliberately stops before an incomplete
 * trailing record so the next confirmation can finish it after append.
 */
export async function scanCodexUserMessages(
  transcriptPath: string,
  startOffset: number,
  matches: (message: string) => boolean,
  expectedIdentity?: string,
): Promise<CodexUserMessageScan> {
  let file
  try {
    file = await openFile(transcriptPath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { available: false, evidence: null, identity: null, nextOffset: 0 }
    }
    throw error
  }
  try {
    const stat = await file.stat()
    const size = stat.size
    const identity = `${stat.dev}:${stat.ino}`
    let position = expectedIdentity && expectedIdentity !== identity
      ? 0
      : (startOffset >= 0 && startOffset <= size ? startOffset : 0)
    let committedOffset = position
    let carry = Buffer.alloc(0)
    const chunk = Buffer.alloc(256 * 1024)

    while (position < size) {
      const count = Math.min(chunk.length, size - position)
      const { bytesRead } = await file.read(chunk, 0, count, position)
      if (bytesRead <= 0) break
      const bufferStart = position - carry.length
      position += bytesRead
      const combined = carry.length === 0
        ? Buffer.from(chunk.subarray(0, bytesRead))
        : Buffer.concat([carry, chunk.subarray(0, bytesRead)])
      let lineStart = 0
      let newline = combined.indexOf(0x0a, lineStart)
      while (newline >= 0) {
        const evidence = userMessageEvidence(
          combined.subarray(lineStart, newline).toString('utf8'),
          matches,
        )
        committedOffset = bufferStart + newline + 1
        if (evidence) {
          return { available: true, evidence, identity, nextOffset: committedOffset }
        }
        lineStart = newline + 1
        newline = combined.indexOf(0x0a, lineStart)
      }
      carry = Buffer.from(combined.subarray(lineStart))
      await new Promise<void>(resolve => setImmediate(resolve))
    }

    if (carry.length > 0) {
      const evidence = userMessageEvidence(carry.toString('utf8'), matches)
      if (evidence) return { available: true, evidence, identity, nextOffset: size }
      try {
        JSON.parse(carry.toString('utf8'))
        committedOffset = size
      } catch { /* retain the incomplete record for the next scan */ }
    }
    return { available: true, evidence: null, identity, nextOffset: committedOffset }
  } finally {
    await file.close()
  }
}

// --- Recap entries ---

// Track last read byte offset per session.
const codexOffsets = new Map<string, number>()

export function resetCodexOffset(sessionName: string): void {
  codexOffsets.delete(sessionName)
}

/**
 * Parse new recap entries from a Codex transcript.
 * Extracts user_message and task_complete.last_agent_message events.
 */
export function parseCodexRecapEntries(sessionName: string, transcriptPath: string): RecapEntry[] {
  if (!existsSync(transcriptPath)) return []

  const size = statSync(transcriptPath).size
  const last = codexOffsets.get(sessionName) ?? 0
  // If the file was truncated/rotated, reset.
  const start = size < last ? 0 : last
  if (size === start) return []

  const entries: RecapEntry[] = []

  const fd = openSync(transcriptPath, 'r')
  try {
    const CHUNK = 256 * 1024 // 256KB
    const buf = Buffer.alloc(CHUNK)
    let pos = start
    let carry = ''
    while (pos < size) {
      const toRead = Math.min(CHUNK, size - pos)
      const n = readSync(fd, buf, 0, toRead, pos)
      if (n <= 0) break
      pos += n
      const text = carry + buf.subarray(0, n).toString('utf-8')
      const parts = text.split('\n')
      carry = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (obj.type !== 'event_msg') continue
          const p = obj.payload
          const ts = obj.timestamp ?? new Date().toISOString()

          if (p?.type === 'user_message' && p.message) {
            entries.push({ id: randomUUID(), type: 'user', content: p.message, timestamp: ts })
          } else if (p?.type === 'task_complete' && p.last_agent_message) {
            entries.push({ id: randomUUID(), type: 'agent', content: p.last_agent_message, timestamp: ts })
          }
        } catch { /* skip */ }
      }
    }
    codexOffsets.set(sessionName, pos)
  } finally {
    closeSync(fd)
  }
  return entries
}
