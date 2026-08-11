import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { log } from '../logger'
import { readTail } from './transcript-parser'
import type { RecapEntry } from '../../types'
import type {
  ProviderQuota,
  ProviderQuotaWindow,
  ProviderSessionContext,
  ProviderSessionUsage,
  ProviderTokenUsage,
} from '../../domain/provider-capabilities'

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
  /**
   * True when the window contained a legacy (codex-cli <= 0.146.0)
   * `event_msg`/`user_message` record. That format is no longer parsed for
   * evidence; a scan that sees it can never confirm, so callers should fail
   * loudly (upgrade codex) instead of retrying into duplicate deliveries.
   */
  sawLegacyUserInput: boolean
}

function joinedContentText(content: unknown, textType: string): string | null {
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (item && typeof item === 'object'
      && (item as { type?: unknown }).type === textType
      && typeof (item as { text?: unknown }).text === 'string') {
      parts.push((item as { text: string }).text)
    }
  }
  return parts.length > 0 ? parts.join('') : null
}

interface UserInputLineInspection {
  evidence: CodexUserMessageEvidence | null
  legacy: boolean
}

/**
 * Codex CLI 0.147.0 records terminal user input twice: as a `response_item`
 * with role "user" and as an `event_msg`/`item_completed` whose item is a
 * `UserMessage`. Either record carries the exact submitted bytes, so either
 * one is acceptable evidence. The pre-0.147 `event_msg`/`user_message` shape
 * is deliberately not evidence — it marks an unsupported codex version.
 */
function userMessageEvidence(
  line: string,
  matches: (message: string) => boolean,
): UserInputLineInspection {
  if (!line.trim()) return { evidence: null, legacy: false }
  try {
    const event = JSON.parse(line)
    if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
      return { evidence: null, legacy: true }
    }
    const message = event.type === 'event_msg'
      && event.payload?.type === 'item_completed'
      && event.payload.item?.type === 'UserMessage'
      ? joinedContentText(event.payload.item.content, 'text')
      : event.type === 'response_item'
        && event.payload?.type === 'message'
        && event.payload.role === 'user'
        ? joinedContentText(event.payload.content, 'input_text')
        : null
    if (message === null || !matches(message)) {
      return { evidence: null, legacy: false }
    }
    return {
      evidence: {
        message,
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : null,
      },
      legacy: false,
    }
  } catch {
    return { evidence: null, legacy: false }
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
      return {
        available: false,
        evidence: null,
        identity: null,
        nextOffset: 0,
        sawLegacyUserInput: false,
      }
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
    let sawLegacyUserInput = false
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
        const inspection = userMessageEvidence(
          combined.subarray(lineStart, newline).toString('utf8'),
          matches,
        )
        sawLegacyUserInput ||= inspection.legacy
        committedOffset = bufferStart + newline + 1
        if (inspection.evidence) {
          return {
            available: true,
            evidence: inspection.evidence,
            identity,
            nextOffset: committedOffset,
            sawLegacyUserInput,
          }
        }
        lineStart = newline + 1
        newline = combined.indexOf(0x0a, lineStart)
      }
      carry = Buffer.from(combined.subarray(lineStart))
      await new Promise<void>(resolve => setImmediate(resolve))
    }

    if (carry.length > 0) {
      const inspection = userMessageEvidence(carry.toString('utf8'), matches)
      sawLegacyUserInput ||= inspection.legacy
      if (inspection.evidence) {
        return {
          available: true,
          evidence: inspection.evidence,
          identity,
          nextOffset: size,
          sawLegacyUserInput,
        }
      }
      try {
        JSON.parse(carry.toString('utf8'))
        committedOffset = size
      } catch { /* retain the incomplete record for the next scan */ }
    }
    return {
      available: true,
      evidence: null,
      identity,
      nextOffset: committedOffset,
      sawLegacyUserInput,
    }
  } finally {
    await file.close()
  }
}

// --- Observation events ---

type UnknownRecord = Record<string, unknown>

export interface CodexCreditsObservation {
  hasCredits?: boolean
  unlimited?: boolean
  balance?: string | null
}

/** Codex-owned fields that do not belong in the shared quota vocabulary. */
export interface CodexObservationDetail {
  limitId?: string
  limitName?: string
  planType?: string
  credits?: CodexCreditsObservation
}

/**
 * Privacy-bounded projection of one Codex `event_msg.token_count` rollout line.
 * The raw record is deliberately not retained: prompts, account identifiers,
 * and version-specific private fields cannot escape through this type.
 */
export interface CodexObservationEvent {
  /** Stable for an identical normalized event, including after file replay. */
  id: string
  /** Original rollout capture time. Missing or invalid timestamps remain unknown. */
  observedAt: string | null
  sessionUsage?: ProviderSessionUsage
  sessionContext?: ProviderSessionContext
  providerQuota?: ProviderQuota
  detail?: CodexObservationDetail
}

export interface CodexRolloutObservationEvent extends CodexObservationEvent {
  /** Existing-file replay rebuilds current state but is not new historical data. */
  replayed: boolean
}

interface CodexFileCursor {
  path: string
  device: number
  inode: number
  /** Byte offset immediately after the last complete newline. */
  offset: number
  /** Small fingerprint of bytes immediately before `offset`. */
  anchor: string
  /** The prior read crossed the safe record-size bound before finding a newline. */
  discardingOversizedLine: boolean
}

interface CodexObservationSessionState {
  cursor?: CodexFileCursor
  initialized: boolean
  model?: string
  /** Recent replay IDs; older replays retain the same stable ID for downstream dedupe. */
  seenIds: Set<string>
}

const MAX_SEEN_OBSERVATION_IDS = 4_096
const MAX_OBSERVATION_RECORD_BYTES = 1024 * 1024

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as UnknownRecord
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined
}

function asPercent(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 100
    ? value
    : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function timestampFromMilliseconds(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return undefined
  return new Date(milliseconds).toISOString()
}

function parseTokenUsage(value: unknown): ProviderTokenUsage | undefined {
  const raw = asRecord(value)
  if (!raw) return undefined

  const usage: Partial<ProviderTokenUsage> = {}
  const fields = [
    ['input', 'input_tokens'],
    ['output', 'output_tokens'],
    ['cacheRead', 'cached_input_tokens'],
    ['cacheWrite', 'cache_write_input_tokens'],
    ['reasoning', 'reasoning_output_tokens'],
    ['total', 'total_tokens'],
  ] as const

  for (const [normalized, native] of fields) {
    const count = asNonNegativeInteger(raw[native])
    if (count !== undefined) usage[normalized] = count
  }

  return Object.keys(usage).length > 0
    ? usage as ProviderTokenUsage
    : undefined
}

function parseSessionUsage(info: UnknownRecord | null): ProviderSessionUsage | undefined {
  if (!info) return undefined
  const cumulativeTokens = parseTokenUsage(info.total_token_usage)
  const latestTurnTokens = parseTokenUsage(info.last_token_usage)
  if (cumulativeTokens) {
    return {
      cumulativeTokens,
      ...(latestTurnTokens ? { latestTurnTokens } : {}),
    }
  }
  if (latestTurnTokens) return { latestTurnTokens }
  return undefined
}

function parseSessionContext(
  info: UnknownRecord | null,
  sessionUsage: ProviderSessionUsage | undefined,
): ProviderSessionContext | undefined {
  if (!info) return undefined
  const windowTokens = asNonNegativeInteger(info.model_context_window)
  // Lifetime totals span every request; Codex's last usage is the active context snapshot.
  const latestTurnTokens = sessionUsage?.latestTurnTokens
  const usedTokens = latestTurnTokens?.total === undefined
    ? undefined
    : Math.max(0, latestTurnTokens.total - (latestTurnTokens.reasoning ?? 0))
  if (windowTokens === undefined && usedTokens === undefined) return undefined

  if (usedTokens !== undefined && windowTokens !== undefined && windowTokens > 0) {
    return {
      usedTokens,
      windowTokens,
      usedPercent: Math.min(100, usedTokens / windowTokens * 100),
    }
  }
  if (usedTokens !== undefined && windowTokens !== undefined) {
    return { usedTokens, windowTokens }
  }
  if (usedTokens !== undefined) return { usedTokens }
  return { windowTokens: windowTokens! }
}

function parseResetAt(
  raw: UnknownRecord,
  observedAt: string | null,
): string | undefined {
  const absoluteSeconds = asNonNegativeInteger(raw.resets_at)
  if (absoluteSeconds !== undefined) {
    return timestampFromMilliseconds(absoluteSeconds * 1_000)
  }

  const relativeSeconds = asNonNegativeInteger(raw.resets_in_seconds)
  if (relativeSeconds === undefined || observedAt === null) return undefined
  return timestampFromMilliseconds(Date.parse(observedAt) + relativeSeconds * 1_000)
}

function parseQuotaWindow(
  id: 'primary' | 'secondary',
  value: unknown,
  observedAt: string | null,
): ProviderQuotaWindow | undefined {
  const raw = asRecord(value)
  if (!raw) return undefined
  const windowMinutes = asNonNegativeInteger(raw.window_minutes)
  const usedPercent = asPercent(raw.used_percent)
  if (windowMinutes === undefined || usedPercent === undefined) return undefined

  const resetsAt = parseResetAt(raw, observedAt)
  return {
    id,
    label: id === 'primary' ? 'Primary' : 'Secondary',
    windowMinutes,
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  }
}

function parseProviderQuota(
  rateLimits: UnknownRecord | null,
  observedAt: string | null,
): ProviderQuota | undefined {
  if (!rateLimits) return undefined
  const windows = [
    parseQuotaWindow('primary', rateLimits.primary, observedAt),
    parseQuotaWindow('secondary', rateLimits.secondary, observedAt),
  ].filter((window): window is ProviderQuotaWindow => Boolean(window))
  return windows.length > 0 ? { windows } : undefined
}

function parseCredits(value: unknown): CodexCreditsObservation | undefined {
  const raw = asRecord(value)
  if (!raw) return undefined
  const credits: CodexCreditsObservation = {}
  if (typeof raw.has_credits === 'boolean') credits.hasCredits = raw.has_credits
  if (typeof raw.unlimited === 'boolean') credits.unlimited = raw.unlimited
  if (typeof raw.balance === 'string' || raw.balance === null) credits.balance = raw.balance
  return Object.keys(credits).length > 0 ? credits : undefined
}

function parseObservationDetail(
  rateLimits: UnknownRecord | null,
): CodexObservationDetail | undefined {
  if (!rateLimits) return undefined
  const detail: CodexObservationDetail = {}
  const limitId = asNonEmptyString(rateLimits.limit_id)
  const limitName = asNonEmptyString(rateLimits.limit_name)
  const planType = asNonEmptyString(rateLimits.plan_type)
  const credits = parseCredits(rateLimits.credits)
  if (limitId) detail.limitId = limitId
  if (limitName) detail.limitName = limitName
  if (planType) detail.planType = planType
  if (credits) detail.credits = credits
  return Object.keys(detail).length > 0 ? detail : undefined
}

/** Parse only the documented, non-message projection from one rollout line. */
export function parseCodexObservationLine(
  line: string,
  model?: string,
): CodexObservationEvent | null {
  let record: UnknownRecord | null
  try {
    record = asRecord(JSON.parse(line))
  } catch {
    return null
  }
  if (record?.type !== 'event_msg') return null

  const payload = asRecord(record.payload)
  if (payload?.type !== 'token_count') return null

  const observedAt = asTimestamp(record.timestamp)
  const info = asRecord(payload.info)
  const rateLimits = asRecord(payload.rate_limits)
  const parsedSessionUsage = parseSessionUsage(info)
  const sessionUsage = parsedSessionUsage
    ? { ...parsedSessionUsage, ...(model ? { model } : {}) }
    : undefined
  const sessionContext = parseSessionContext(info, sessionUsage)
  const providerQuota = parseProviderQuota(rateLimits, observedAt)
  const detail = parseObservationDetail(rateLimits)
  if (!sessionUsage && !sessionContext && !providerQuota && !detail) return null

  const projection = {
    observedAt,
    ...(sessionUsage ? { sessionUsage } : {}),
    ...(sessionContext ? { sessionContext } : {}),
    ...(providerQuota ? { providerQuota } : {}),
    ...(detail ? { detail } : {}),
  }
  const id = createHash('sha256').update(JSON.stringify(projection)).digest('hex')
  return { id, ...projection }
}

function parseTurnContextModel(line: string):
  | { matched: false }
  | { matched: true; model: string | undefined } {
  let record: UnknownRecord | null
  try {
    record = asRecord(JSON.parse(line))
  } catch {
    return { matched: false }
  }
  if (record?.type !== 'turn_context') return { matched: false }
  const payload = asRecord(record.payload)
  return { matched: true, model: asNonEmptyString(payload?.model) }
}

function readAnchor(fd: number, offset: number): string {
  const length = Math.min(128, offset)
  if (length === 0) return ''
  const buffer = Buffer.alloc(length)
  const bytesRead = readSync(fd, buffer, 0, length, offset - length)
  return bytesRead === length
    ? createHash('sha256').update(buffer).digest('hex')
    : ''
}

/** Stateful, incremental observation reader for append-only Codex rollout files. */
export class CodexRolloutObservationSource {
  private readonly sessions = new Map<string, CodexObservationSessionState>()

  read(sessionName: string, transcriptPath: string): CodexRolloutObservationEvent[] {
    let fd: number
    try {
      fd = openSync(transcriptPath, 'r')
    } catch {
      return []
    }

    try {
      const stats = fstatSync(fd)
      let state = this.sessions.get(sessionName)
      if (!state) {
        state = { initialized: false, seenIds: new Set() }
        this.sessions.set(sessionName, state)
      }

      const previous = state.cursor
      const sameFile = previous?.path === transcriptPath
        && previous.device === stats.dev
        && previous.inode === stats.ino
      let start = sameFile ? previous.offset : 0
      let continuingSameFile = sameFile
      if (stats.size < start) {
        start = 0
        continuingSameFile = false
      }
      if (sameFile && start > 0 && readAnchor(fd, start) !== previous.anchor) {
        start = 0
        continuingSameFile = false
      }

      // Only the first scan for this session incarnation is hydration. Once
      // initialized, unseen stable IDs are new to Tinstar even if the rollout
      // file rotated or was replaced; suppressing them would create a silent
      // hole in historical telemetry. Reincarnation cleanup resets the source
      // and therefore makes the next scan hydration again.
      const replayed = !state.initialized
      if (!continuingSameFile) state.model = undefined

      const events: CodexRolloutObservationEvent[] = []
      const emittedIds = new Set<string>()
      const chunkSize = 256 * 1024
      const buffer = Buffer.alloc(chunkSize)
      let pendingChunks: Buffer[] = []
      let pendingBytes = 0
      let discardingOversizedLine = continuingSameFile
        && (previous?.discardingOversizedLine ?? false)
      let position = start

      while (position < stats.size) {
        const bytesToRead = Math.min(chunkSize, stats.size - position)
        const bytesRead = readSync(fd, buffer, 0, bytesToRead, position)
        if (bytesRead <= 0) break
        position += bytesRead

        const chunk = buffer.subarray(0, bytesRead)
        let cursor = 0
        while (cursor < chunk.length) {
          const newline = chunk.indexOf(0x0a, cursor)
          const segmentEnd = newline === -1 ? chunk.length : newline
          const segment = chunk.subarray(cursor, segmentEnd)

          if (discardingOversizedLine) {
            if (newline === -1) break
            discardingOversizedLine = false
            cursor = newline + 1
            continue
          }

          if (pendingBytes + segment.length > MAX_OBSERVATION_RECORD_BYTES) {
            pendingChunks = []
            pendingBytes = 0
            if (newline === -1) discardingOversizedLine = true
            cursor = newline === -1 ? chunk.length : newline + 1
            continue
          }

          if (newline === -1) {
            if (segment.length > 0) {
              pendingChunks.push(Buffer.from(segment))
              pendingBytes += segment.length
            }
            break
          }

          const rawLine = pendingBytes === 0
            ? segment.toString('utf-8')
            : Buffer.concat(
                [...pendingChunks, segment],
                pendingBytes + segment.length,
              ).toString('utf-8')
          pendingChunks = []
          pendingBytes = 0
          cursor = newline + 1
          if (!rawLine.trim()) continue
          const modelRecord = parseTurnContextModel(rawLine)
          if (modelRecord.matched) {
            state.model = modelRecord.model
            continue
          }
          const event = parseCodexObservationLine(rawLine, state.model)
          if (!event || state.seenIds.has(event.id) || emittedIds.has(event.id)) continue
          emittedIds.add(event.id)
          events.push({ ...event, replayed })
        }
      }

      const offset = discardingOversizedLine ? position : position - pendingBytes
      state.cursor = {
        path: transcriptPath,
        device: stats.dev,
        inode: stats.ino,
        offset,
        anchor: readAnchor(fd, offset),
        discardingOversizedLine,
      }
      state.initialized = true
      for (const id of emittedIds) {
        state.seenIds.add(id)
        if (state.seenIds.size > MAX_SEEN_OBSERVATION_IDS) {
          const oldestId = state.seenIds.values().next().value
          if (oldestId) state.seenIds.delete(oldestId)
        }
      }
      return events
    } finally {
      closeSync(fd)
    }
  }

  reset(sessionName: string): void {
    this.sessions.delete(sessionName)
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
