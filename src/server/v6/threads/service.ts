import { randomUUID } from 'node:crypto'
import { ANCHOR_TYPES, INTENT_SCHEMA, type AnchorType, type IntentEnvelope } from '../../../v6/contract/intent'
import { isRecord } from '../../../v6/contract/result'
import type { ThreadMessageView, ThreadView, TurnDisposition } from '../../../v6/threads/types'
import {
  defaultProjectionFile,
  type IntentDisposition,
} from '../shell/projection'
import {
  readReceipts,
  submitIntent,
  type InboxClientOptions,
} from '../shell/submitIntent'
import {
  readThreadDoc,
  serializeThreads,
  writeThreadDoc,
  type StoredThread,
  type StoredTurn,
  type ThreadDoc,
} from './store'

const REFUSED_KEYS = new Set(['command', 'shell', 'argv', 'tmux'])
const MAX_TEXT = 8_000
const MAX_IDS = 32
const MAX_LABELS = 12

export interface ThreadServiceOptions {
  storeFile: string
  inbox: InboxClientOptions
  now?: () => string
  newThreadId?: () => string
  newRequestId?: () => string
}

export interface PostMessageInput {
  threadId?: string
  requestId?: string
  text?: unknown
  anchor?: unknown
  fixture?: unknown
  portfolio?: unknown
}

export interface PresenceInput {
  threadId?: string
  type?: unknown
  ids?: unknown
  archived?: unknown
  occupantIds?: unknown
  position?: unknown
}

export type ThreadResult =
  | { ok: true; thread: ThreadView | null }
  | { ok: false; status: 'BAD_REQUEST' | 'INVALID_PARAMS' | 'NOT_FOUND' | 'FORBIDDEN'; message: string }

function nowOf(opts: ThreadServiceOptions): string {
  return (opts.now ?? (() => new Date().toISOString()))()
}

function mintThreadId(opts: ThreadServiceOptions): string {
  return (opts.newThreadId ?? (() => `thr-${randomUUID()}`))()
}

function mintRequestId(opts: ThreadServiceOptions): string {
  return (opts.newRequestId ?? (() => `req-${randomUUID()}`))()
}

export function safeToken(id: string): boolean {
  if (id.length === 0 || id.length > 128 || id.startsWith('.')) return false
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)
}

function safeSemanticId(id: string): boolean {
  if (id.length === 0 || id.length > 200) return false
  if (id.includes('..') || id.startsWith('/') || id.includes('\\') || id.includes(',')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(id)
}

function refusedKey(value: unknown, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(item => refusedKey(item, depth + 1))
  return Object.keys(value as Record<string, unknown>).some(key => {
    if (REFUSED_KEYS.has(key)) return true
    return refusedKey((value as Record<string, unknown>)[key], depth + 1)
  })
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((id, index) => id === right[index])
}

function asAnchorType(raw: unknown): AnchorType | null {
  if (typeof raw !== 'string') return null
  return (ANCHOR_TYPES as readonly string[]).includes(raw) ? raw as AnchorType : null
}

function asIdList(raw: unknown, allowEmpty = false): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_IDS) return null
  if (raw.length === 0) return allowEmpty ? [] : null
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !safeSemanticId(item)) return null
    ids.push(item)
  }
  return ids
}

interface ParsedAnchor {
  type: AnchorType
  ids: string[]
  textSelection: { text: string; field?: string } | null
  revision: string | null
  labels: string[]
}

function parseAnchor(raw: unknown): ParsedAnchor | string {
  if (!isRecord(raw)) return 'anchor must be an object'
  const type = asAnchorType(raw.type)
  if (!type) return 'anchor.type is not a known value'
  const ids = asIdList(raw.ids)
  if (!ids) return 'anchor.ids must be semantic ids'
  let textSelection: ParsedAnchor['textSelection'] = null
  if (raw.textSelection != null) {
    if (!isRecord(raw.textSelection) || typeof raw.textSelection.text !== 'string') {
      return 'textSelection.text must be a string'
    }
    const text = raw.textSelection.text
    if (text.length === 0 || text.length > 2_000) return 'textSelection.text is empty or too long'
    const field = raw.textSelection.field
    if (field != null && (typeof field !== 'string' || field.length > 80)) return 'textSelection.field is invalid'
    textSelection = field ? { text, field } : { text }
  }
  let revision: string | null = null
  if (raw.revision != null) {
    if (typeof raw.revision !== 'string' || raw.revision.length > 200) return 'revision must be a string or null'
    revision = raw.revision
  }
  const labels: string[] = []
  if (raw.labels != null) {
    if (!Array.isArray(raw.labels)) return 'labels must be strings'
    for (const label of raw.labels.slice(0, MAX_LABELS)) {
      if (typeof label !== 'string' || label.length === 0 || label.length > 200) return 'labels must be short strings'
      labels.push(label)
    }
  }
  return { type, ids, textSelection, revision, labels }
}

function findById(doc: ThreadDoc, id: string): StoredThread | null {
  return doc.threads.find(thread => thread.id === id) ?? null
}

function findByAnchor(doc: ThreadDoc, type: AnchorType, ids: string[]): StoredThread | null {
  return doc.threads.find(thread => thread.anchor.type === type && sameSet(thread.anchor.ids, ids)) ?? null
}

function messageBody(thread: StoredThread, turn: StoredTurn): Record<string, unknown> {
  const body: Record<string, unknown> = {
    threadId: thread.id,
    text: turn.text,
    previousNoteId: turn.previousNoteId,
    recipient: 'firstmate',
  }
  if (thread.anchor.textSelection) body.textSelection = thread.anchor.textSelection
  if (thread.anchor.labels.length > 0) body.labels = [...thread.anchor.labels]
  if (thread.fixture) body.fixture = true
  return body
}

function envelopeFor(thread: StoredThread, turn: StoredTurn): IntentEnvelope {
  return {
    schema: INTENT_SCHEMA,
    kind: 'thread.message',
    requestId: turn.requestId,
    revision: thread.anchor.revision,
    anchor: { type: thread.anchor.type, ids: [...thread.anchor.ids] },
    body: messageBody(thread, turn),
  }
}

const PENDING: ReadonlySet<TurnDisposition> = new Set(['queued', 'saved-unannounced', 'not-receivable'])

export function toThreadView(thread: StoredThread): ThreadView {
  const messages: ThreadMessageView[] = []
  for (const turn of thread.turns) {
    const pending = !turn.reply && PENDING.has(turn.disposition)
    messages.push({
      id: turn.requestId,
      role: 'user',
      text: turn.text,
      disposition: turn.reply ? 'replied' : turn.disposition,
      noteId: turn.noteId,
      requestId: turn.requestId,
      previousNoteId: turn.previousNoteId,
      pending,
      detail: turn.detail,
    })
    if (turn.reply) {
      messages.push({
        id: `reply:${turn.requestId}`,
        role: 'firstmate',
        text: turn.reply.body,
        disposition: 'replied',
        noteId: turn.reply.noteId,
        requestId: turn.requestId,
        previousNoteId: null,
        pending: false,
        detail: '',
      })
    }
  }
  return {
    id: thread.id,
    anchor: {
      type: thread.anchor.type,
      ids: [...thread.anchor.ids],
      textSelection: thread.anchor.textSelection,
      revision: thread.anchor.revision,
      labels: [...thread.anchor.labels],
    },
    fixture: thread.fixture,
    display: {
      status: thread.display.status,
      changedLine: thread.display.changedLine,
      position: thread.display.position
        ? { columnId: thread.display.position.columnId, index: thread.display.position.index }
        : null,
    },
    messages,
  }
}

function applySubmission(turn: StoredTurn, disposition: IntentDisposition, detail: string, noteId: string | null): void {
  if (turn.reply) return
  turn.disposition = disposition
  turn.detail = detail
  if (noteId) turn.noteId = noteId
}

async function deliver(opts: ThreadServiceOptions, thread: StoredThread, turn: StoredTurn): Promise<void> {
  const submission = await submitIntent(envelopeFor(thread, turn), opts.inbox)
  applySubmission(turn, submission.disposition, submission.detail, submission.noteId)
}

export async function listThreads(
  opts: ThreadServiceOptions,
  typeRaw: unknown,
  idsRaw: unknown,
): Promise<ThreadResult> {
  const type = asAnchorType(typeRaw)
  const ids = asIdList(idsRaw)
  if (!type || !ids) return { ok: false, status: 'INVALID_PARAMS', message: 'type and ids are required' }
  const doc = readThreadDoc(opts.storeFile)
  const thread = findByAnchor(doc, type, ids)
  return { ok: true, thread: thread ? toThreadView(thread) : null }
}

export async function getThread(opts: ThreadServiceOptions, id: string): Promise<ThreadResult> {
  if (!safeToken(id)) return { ok: false, status: 'INVALID_PARAMS', message: 'thread id is invalid' }
  const doc = readThreadDoc(opts.storeFile)
  const thread = findById(doc, id)
  if (!thread) return { ok: false, status: 'NOT_FOUND', message: 'thread not found' }
  return { ok: true, thread: toThreadView(thread) }
}

export async function postThreadMessage(opts: ThreadServiceOptions, input: PostMessageInput): Promise<ThreadResult> {
  if (refusedKey(input)) {
    return { ok: false, status: 'FORBIDDEN', message: 'command, shell, and tmux fields are not accepted' }
  }
  if (typeof input.text !== 'string' || input.text.trim().length === 0 || input.text.length > MAX_TEXT) {
    return { ok: false, status: 'INVALID_PARAMS', message: 'text must be a non-empty string' }
  }
  const anchorParsed = parseAnchor(input.anchor)
  if (typeof anchorParsed === 'string') return { ok: false, status: 'INVALID_PARAMS', message: anchorParsed }
  if (input.threadId != null && (typeof input.threadId !== 'string' || !safeToken(input.threadId))) {
    return { ok: false, status: 'INVALID_PARAMS', message: 'thread id is invalid' }
  }
  if (input.requestId != null && (typeof input.requestId !== 'string' || !safeToken(input.requestId))) {
    return { ok: false, status: 'INVALID_PARAMS', message: 'request id is invalid' }
  }
  const fixture = input.fixture === true
  const text = input.text

  return serializeThreads(async () => {
    const doc = readThreadDoc(opts.storeFile)
    let thread = typeof input.threadId === 'string' ? findById(doc, input.threadId) : null
    if (typeof input.threadId === 'string' && !thread) {
      return { ok: false, status: 'NOT_FOUND', message: 'thread not found' } satisfies ThreadResult
    }
    if (!thread) thread = findByAnchor(doc, anchorParsed.type, anchorParsed.ids)
    if (!thread) {
      const at = nowOf(opts)
      thread = {
        id: mintThreadId(opts),
        anchor: anchorParsed,
        turns: [],
        fixture,
        createdAt: at,
        updatedAt: at,
        display: { status: 'current', changedLine: null, position: null },
      }
      doc.threads.push(thread)
    } else if (fixture) {
      thread.fixture = true
    }

    const requestId = typeof input.requestId === 'string' ? input.requestId : mintRequestId(opts)
    const existing = thread.turns.find(turn => turn.requestId === requestId)
    if (existing) {
      await deliver(opts, thread, existing)
      thread.updatedAt = nowOf(opts)
      writeThreadDoc(opts.storeFile, doc)
      return { ok: true, thread: toThreadView(thread) } satisfies ThreadResult
    }

    const previous = thread.turns[thread.turns.length - 1]
    const turn: StoredTurn = {
      requestId,
      noteId: null,
      previousNoteId: previous ? previous.noteId : null,
      text,
      at: nowOf(opts),
      disposition: 'queued',
      detail: 'queued',
      reply: null,
    }
    thread.turns.push(turn)
    thread.updatedAt = turn.at
    writeThreadDoc(opts.storeFile, doc)
    await deliver(opts, thread, turn)
    thread.updatedAt = nowOf(opts)
    writeThreadDoc(opts.storeFile, doc)
    return { ok: true, thread: toThreadView(thread) } satisfies ThreadResult
  })
}

export async function refreshThreadReceipts(opts: ThreadServiceOptions, id: string): Promise<ThreadResult> {
  if (!safeToken(id)) return { ok: false, status: 'INVALID_PARAMS', message: 'thread id is invalid' }
  return serializeThreads(async () => {
    const doc = readThreadDoc(opts.storeFile)
    const thread = findById(doc, id)
    if (!thread) return { ok: false, status: 'NOT_FOUND', message: 'thread not found' } satisfies ThreadResult
    const at = nowOf(opts)
    for (const turn of thread.turns) {
      if (turn.reply || !turn.noteId) continue
      const { reply } = await readReceipts(opts.inbox, turn.requestId)
      if (!reply || reply.noteId !== turn.noteId) continue
      turn.reply = { noteId: reply.noteId, body: reply.body, cursor: reply.cursor, at }
      turn.disposition = 'replied'
      turn.detail = 'reply'
    }
    thread.updatedAt = at
    writeThreadDoc(opts.storeFile, doc)
    return { ok: true, thread: toThreadView(thread) } satisfies ThreadResult
  })
}

function parsePosition(raw: unknown): { columnId: string | null; index: number | null } | null | string {
  if (raw == null) return null
  if (!isRecord(raw)) return 'position must be an object'
  const columnId = raw.columnId == null ? null : raw.columnId
  const index = raw.index == null ? null : raw.index
  if (columnId != null && (typeof columnId !== 'string' || !safeSemanticId(columnId))) return 'position.columnId is invalid'
  if (index != null && (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 10_000)) {
    return 'position.index is invalid'
  }
  return { columnId: columnId ?? null, index: index ?? null }
}

export async function reportPresence(opts: ThreadServiceOptions, input: PresenceInput): Promise<ThreadResult> {
  if (refusedKey(input)) {
    return { ok: false, status: 'FORBIDDEN', message: 'command, shell, and tmux fields are not accepted' }
  }
  const position = parsePosition(input.position)
  if (typeof position === 'string') return { ok: false, status: 'INVALID_PARAMS', message: position }
  const occupantIds = input.occupantIds == null ? null : asIdList(input.occupantIds, true)
  if (input.occupantIds != null && !occupantIds) {
    return { ok: false, status: 'INVALID_PARAMS', message: 'occupantIds must be semantic ids' }
  }

  return serializeThreads(async () => {
    const doc = readThreadDoc(opts.storeFile)
    let thread: StoredThread | null = null
    if (typeof input.threadId === 'string') {
      if (!safeToken(input.threadId)) {
        return { ok: false, status: 'INVALID_PARAMS', message: 'thread id is invalid' } satisfies ThreadResult
      }
      thread = findById(doc, input.threadId)
    } else {
      const type = asAnchorType(input.type)
      const ids = asIdList(input.ids)
      if (!type || !ids) return { ok: false, status: 'INVALID_PARAMS', message: 'type and ids are required' } satisfies ThreadResult
      thread = findByAnchor(doc, type, ids)
    }
    if (!thread) return { ok: true, thread: null } satisfies ThreadResult

    const archived = input.archived === true
    const occupantsDiffer = occupantIds != null && !sameSet(occupantIds, thread.anchor.ids)
    if (archived || occupantsDiffer) {
      thread.display.status = 'changed'
      thread.display.changedLine = `changed — ${thread.anchor.ids.join(', ')}`
    } else if (input.archived === false || occupantIds) {
      thread.display.status = 'current'
      thread.display.changedLine = null
    }
    if (position) thread.display.position = position
    thread.updatedAt = nowOf(opts)
    writeThreadDoc(opts.storeFile, doc)
    return { ok: true, thread: toThreadView(thread) } satisfies ThreadResult
  })
}

export function projectionFileFor(explicit: string | undefined): string {
  return explicit ?? defaultProjectionFile()
}
