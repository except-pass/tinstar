import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { RecapEntry } from '../../types'
import { randomUUID } from 'node:crypto'

/** Read the last N lines of a file without reading the entire thing. */
export function readTail(filePath: string, maxLines: number): string[] {
  const CHUNK = 16_384 // 16 KB — JSONL lines are typically 1-5 KB each
  const size = statSync(filePath).size
  if (size === 0) return []

  const fd = openSync(filePath, 'r')
  try {
    const readFrom = Math.max(0, size - CHUNK)
    const buf = Buffer.alloc(Math.min(CHUNK, size))
    readSync(fd, buf, 0, buf.length, readFrom)
    const text = buf.toString('utf-8')
    const lines = text.split('\n').filter(l => l.trim())
    return lines.slice(-maxLines)
  } finally {
    closeSync(fd)
  }
}

/** Encode a workdir path the same way Claude Code does for project directories */
function encodeWorkdir(workdir: string): string {
  // Claude Code encodes the path by replacing / with - (keeps the leading dash)
  return workdir.replace(/\//g, '-')
}

/** Directory holding all .jsonl conversation files for a given workdir */
export function getProjectDir(workdir: string, stateDir?: string): string {
  const encoded = encodeWorkdir(workdir)
  const base = stateDir ?? join(homedir(), '.claude', 'projects')
  return join(base, encoded)
}

/** Build the JSONL transcript path for a given conversation */
export function getTranscriptPath(workdir: string, conversationId: string, stateDir?: string): string {
  return join(getProjectDir(workdir, stateDir), `${conversationId}.jsonl`)
}

// Track last read position per session
type OffsetState = { byteOffset: number; carry: string }
const offsets = new Map<string, OffsetState>()

/**
 * Parse transcript into recap entries: user prompt + last assistant response per turn.
 * Intermediate assistant messages (thinking-out-loud, tool-call narration) are skipped.
 */
export function parseNewEntries(sessionName: string, workdir: string, conversationId: string, stateDir?: string): RecapEntry[] {
  return parseNewEntriesAt(sessionName, getTranscriptPath(workdir, conversationId, stateDir))
}

/**
 * Same as parseNewEntries, but the caller supplies the transcript path
 * directly. Use this when the path was discovered another way (e.g. via
 * findTranscriptByConvId for a session with no workspace.path, like marshal).
 */
export function parseNewEntriesAt(sessionName: string, path: string): RecapEntry[] {
  if (!existsSync(path)) return []

  const size = statSync(path).size
  const state = offsets.get(sessionName) ?? { byteOffset: 0, carry: '' }
  // If the file was truncated/rotated, reset.
  if (size < state.byteOffset) {
    state.byteOffset = 0
    state.carry = ''
  }
  if (size === state.byteOffset) return []

  // Parse all new lines into typed records
  const records: Array<{ type: 'user' | 'agent'; text: string; timestamp: string }> = []
  const fd = openSync(path, 'r')
  try {
    const CHUNK = 256 * 1024 // 256KB
    const buf = Buffer.alloc(CHUNK)
    let pos = state.byteOffset
    let carry = state.carry
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
          const rec = extractRecord(obj)
          if (rec) records.push(rec)
        } catch {
          // Skip malformed lines
        }
      }
    }
    state.byteOffset = pos
    state.carry = carry
    offsets.set(sessionName, state)
  } finally {
    closeSync(fd)
  }

  // Group into turns: each user message starts a new turn.
  // Keep the user prompt and only the LAST assistant text before the next user message.
  const entries: RecapEntry[] = []
  let lastAgent: { text: string; timestamp: string } | null = null

  for (const rec of records) {
    if (rec.type === 'user') {
      // Flush previous turn's last agent response
      if (lastAgent) {
        entries.push({ id: randomUUID(), type: 'agent', content: lastAgent.text, timestamp: lastAgent.timestamp })
        lastAgent = null
      }
      entries.push({ id: randomUUID(), type: 'user', content: rec.text, timestamp: rec.timestamp })
    } else {
      // Keep overwriting — we only want the last one
      lastAgent = { text: rec.text, timestamp: rec.timestamp }
    }
  }

  // Flush trailing agent response
  if (lastAgent) {
    entries.push({ id: randomUUID(), type: 'agent', content: lastAgent.text, timestamp: lastAgent.timestamp })
  }

  return entries
}

/** Reset offset tracking for a session */
export function resetOffset(sessionName: string): void {
  offsets.delete(sessionName)
}

/**
 * Read the last JSONL entry and derive session status from it.
 *
 * Claude Code JSONL format:
 *   - type 'assistant' with tool_use content blocks  → agent called tools, still running
 *   - type 'assistant' with only text blocks          → final response, idle
 *   - type 'user'                                     → prompt submitted or tool results fed back, running
 *
 * Returns null if the file is missing or the last line can't be parsed.
 */
export type SessionStatusDetail = {
  state: 'running' | 'idle'
  /** True when running because assistant emitted tool_use (vs model thinking after user input) */
  toolPending: boolean
}

export function readSessionStatus(workdir: string, conversationId: string, stateDir?: string): 'running' | 'idle' | null {
  return readSessionStatusDetail(workdir, conversationId, stateDir)?.state ?? null
}

export function readSessionStatusDetail(workdir: string, conversationId: string, stateDir?: string): SessionStatusDetail | null {
  return readSessionStatusDetailAt(getTranscriptPath(workdir, conversationId, stateDir))
}

/**
 * Read the last meaningful JSONL entry from `transcriptPath` and derive
 * running/idle. Skips trailing metadata lines (system, attachment, last-prompt,
 * file-history-snapshot, permission-mode) AND user lines whose content is only
 * a `<local-command-…>` / `<bash-input>` / `<bash-stdout>` / `<bash-stderr>`
 * artifact — those come from `! cmd` typed at the bash prompt and don't
 * represent a turn the agent has to respond to.
 */
export function readSessionStatusDetailAt(transcriptPath: string): SessionStatusDetail | null {
  if (!existsSync(transcriptPath)) return null

  // 50 lines comfortably covers the metadata trail + a flurry of bash-input
  // user records without forcing a full file read.
  const lines = readTail(transcriptPath, 50)
  if (lines.length === 0) return null

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>
      if (obj.type === 'assistant') {
        const msgContent = (obj.message as Record<string, unknown> | undefined)?.content
        if (Array.isArray(msgContent)) {
          const hasToolUse = (msgContent as Array<Record<string, unknown>>).some(b => b.type === 'tool_use')
          return hasToolUse
            ? { state: 'running', toolPending: true }
            : { state: 'idle', toolPending: false }
        }
        return { state: 'idle', toolPending: false }
      }
      if (obj.type === 'user') {
        if (isLocalCommandArtifact(obj)) continue
        return { state: 'running', toolPending: false }
      }
      // Skip non-conversation entries (system, progress, file-history-snapshot, etc.)
    } catch {
      // Skip malformed lines
    }
  }
  return null
}

/**
 * Read the model the latest assistant turn ran on, from `transcriptPath`.
 *
 * Sourced from the per-turn `message.model` sibling key that Claude Code writes
 * on every `assistant` record (the same records `extractAssistantText` walks).
 * This is a cheap tail read — no `claude` subprocess, no context-usage sidecar.
 *
 * Returns the most recent assistant record's `message.model`, or `null` when
 * the file is missing, has no assistant turn yet (pre-first-response), or the
 * model field is absent/non-string.
 */
// Per-transcript model cache, keyed by absolute path. Invalidated by (mtimeMs, size)
// so a model change — which appends a new assistant record, growing the file — is
// always re-read, while an unchanged transcript skips the open+read+parse entirely.
// This matters because /api/state resolves every session's model on each request and
// the model viewer polls it; without this, a large fleet pays N tail-reads per poll.
type ModelCacheEntry = { mtimeMs: number; size: number; model: string | null }
const modelCache = new Map<string, ModelCacheEntry>()

/** Test-only: drop the model cache so a reused transcript path can't return a stale
 *  value across cases that write different content to the same path. */
export function __resetModelCache(): void {
  modelCache.clear()
}

export function readLatestModelAt(transcriptPath: string): string | null {
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(transcriptPath)
  } catch {
    modelCache.delete(transcriptPath) // file gone ⇒ forget any cached model
    return null
  }

  const cached = modelCache.get(transcriptPath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.model

  const fresh = readLatestModelFresh(transcriptPath)
  // Sticky last-known: a busy session can append >50 lines / >16 KB of trailing
  // non-assistant records after its last assistant turn, pushing `message.model`
  // out of the bounded tail window → a transient null. Keep the last KNOWN non-null
  // model rather than flickering the UI to "—"; a real model change writes a fresh
  // assistant record at the very tail, which this read picks up on the next epoch.
  const model = fresh ?? cached?.model ?? null
  modelCache.set(transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, model })
  return model
}

/** Uncached tail read of the latest assistant turn's `message.model`. */
function readLatestModelFresh(transcriptPath: string): string | null {
  // The model is stable across a session, so the latest assistant record in the
  // tail is sufficient. 50 lines covers the trailing metadata flurry without a
  // full-file read (mirrors readSessionStatusDetailAt). See readLatestModelAt for
  // how an unusually long trailing non-assistant flurry is handled (sticky cache).
  const lines = readTail(transcriptPath, 50)
  if (lines.length === 0) return null

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>
      if (obj.type !== 'assistant') continue
      const message = obj.message as Record<string, unknown> | undefined
      const model = message?.model
      if (typeof model === 'string' && model) return model
    } catch {
      // Skip malformed lines
    }
  }
  return null
}

/**
 * Read the latest assistant turn's `message.model` for a session identified by
 * its workdir + conversation id. Thin wrapper over `readLatestModelAt`.
 */
export function readLatestModel(workdir: string, conversationId: string, stateDir?: string): string | null {
  return readLatestModelAt(getTranscriptPath(workdir, conversationId, stateDir))
}

/**
 * Scan `<base>/*\/<conversationId>.jsonl` for an existing transcript. Used by
 * the status watcher when a session has no recorded `workspace.path` (so we
 * can't compute the project dir directly). Returns the absolute transcript
 * path, or null if none exists.
 */
export function findTranscriptByConvId(conversationId: string, base?: string): string | null {
  const projectsDir = base ?? join(homedir(), '.claude', 'projects')
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const candidate = join(projectsDir, entry, `${conversationId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function isLocalCommandArtifact(obj: Record<string, unknown>): boolean {
  const message = obj.message as Record<string, unknown> | undefined
  const content = message?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('')
      : ''
  const trimmed = text.trimStart()
  return (
    trimmed.startsWith('<local-command-') ||
    trimmed.startsWith('<bash-input>') ||
    trimmed.startsWith('<bash-stdout>') ||
    trimmed.startsWith('<bash-stderr>')
  )
}

// --- Record extraction ---

function extractRecord(obj: Record<string, unknown>): { type: 'user' | 'agent'; text: string; timestamp: string } | null {
  const type = obj.type as string
  if (!type) return null

  const timestamp = (obj.timestamp as string) ?? new Date().toISOString()

  if (type === 'user') {
    const text = extractUserText(obj)
    return text ? { type: 'user', text, timestamp } : null
  }
  if (type === 'assistant') {
    const text = extractAssistantText(obj)
    return text ? { type: 'agent', text, timestamp } : null
  }
  return null
}

function extractUserText(obj: Record<string, unknown>): string | null {
  const message = obj.message as Record<string, unknown> | undefined
  if (!message) return null

  const content = message.content
  if (typeof content === 'string') {
    if (content.startsWith('<local-command-')) return null
    const trimmed = content.trim()
    return trimmed || null
  }

  if (Array.isArray(content)) {
    // tool_result arrays aren't real user messages — skip unless they contain text blocks
    const textBlocks = (content as Array<Record<string, unknown>>).filter(
      b => b.type === 'text' && typeof b.text === 'string'
    )
    if (textBlocks.length === 0) return null
    const text = textBlocks.map(b => b.text as string).join('\n').trim()
    if (!text || text.startsWith('<local-command-')) return null
    // Skip system/skill injections (long auto-generated content)
    if (text.startsWith('Base directory for this skill:')) return null
    return text
  }

  return null
}

function extractAssistantText(obj: Record<string, unknown>): string | null {
  const message = obj.message as Record<string, unknown> | undefined
  if (!message) return null

  const content = message.content
  if (!Array.isArray(content)) return null

  const textBlocks = (content as Array<Record<string, unknown>>).filter(
    b => b.type === 'text' && typeof b.text === 'string'
  )

  if (textBlocks.length === 0) return null
  const text = textBlocks.map(b => b.text as string).join('\n').trim()
  return text || null
}
