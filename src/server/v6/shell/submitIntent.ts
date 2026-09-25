import {
  parseAppliedReceipt,
  parseIntentEnvelope,
  type AppliedReceipt,
  type IntentEnvelope,
} from '../../../v6/contract/intent'
import { isRecord } from '../../../v6/contract/result'
import {
  defaultFmRunner,
  fmChildEnv,
  inboxScript,
  type CommandResult,
  type FmCommandRunner,
} from './fmExec'
import { defaultProjectionFile, updateProjection, type IntentDisposition } from './projection'

export type { IntentDisposition }

export interface IntentSubmission {
  requestId: string
  noteId: string | null
  disposition: IntentDisposition
  applied: false
  announced: boolean | null
  canReceive: boolean | 'unknown' | null
  exitCode: number | null
  detail: string
  noteOutcome: string | null
}

export interface InboxClientOptions {
  home: string
  binDir: string
  projectionFile?: string
  runner?: FmCommandRunner
  now?: () => string
}

export interface ReadyProjection {
  canReceive: boolean | 'unknown'
  detail: string
}

export interface InboxReplyView {
  noteId: string
  requestId: string | null
  body: string
  cursor: string
  announced: boolean | null
  acknowledged: boolean
  /** Set only when the reply body is a matching tinstar.v6.receipt/1. */
  appliedOutcome: 'applied' | 'rejected' | null
  receiptDetail: string | null
}

const INBOX_SUBCOMMANDS = new Set(['note', 'receipts', 'ready'])

const REFUSED_KEYS = new Set(['command', 'shell', 'argv', 'tmux'])

function failed(requestId: string, detail: string, exitCode: number | null = null): IntentSubmission {
  return {
    requestId,
    noteId: null,
    disposition: 'failed',
    applied: false,
    announced: null,
    canReceive: null,
    exitCode,
    detail,
    noteOutcome: null,
  }
}

export function requestIdAllowed(id: string): boolean {
  if (id.length === 0 || id.length > 128 || id.startsWith('.')) return false
  return /^[A-Za-z0-9._:-]+$/.test(id)
}

function refusedKey(value: unknown): string | null {
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (REFUSED_KEYS.has(key)) return key
  }
  return null
}

async function runInbox(
  opts: InboxClientOptions,
  subcommand: 'note' | 'receipts' | 'ready',
  args: string[],
): Promise<CommandResult> {
  if (!INBOX_SUBCOMMANDS.has(subcommand)) {
    return { code: null, stdout: '', stderr: 'refused subcommand' }
  }
  const runner = opts.runner ?? defaultFmRunner
  return runner.exec(inboxScript(opts.binDir), [subcommand, ...args], fmChildEnv(opts.home))
}

function parseNoteStdout(stdout: string): {
  id: string | null
  outcome: string | null
  announced: boolean | null
  saved: boolean
} | null {
  const line = stdout.split('\n').find(row => row.includes('"schema"')) ?? stdout.trim()
  try {
    const raw = JSON.parse(line) as unknown
    if (!isRecord(raw) || raw.schema !== 'fm-inbox-note.v1') return null
    return {
      id: typeof raw.id === 'string' ? raw.id : null,
      outcome: typeof raw.outcome === 'string' ? raw.outcome : null,
      announced: typeof raw.announced === 'boolean' ? raw.announced : null,
      saved: raw.saved === true,
    }
  } catch {
    return null
  }
}

export async function readReady(opts: InboxClientOptions): Promise<ReadyProjection> {
  const result = await runInbox(opts, 'ready', [])
  if (result.code !== 0) {
    return { canReceive: 'unknown', detail: result.stderr.trim() || 'ready failed' }
  }
  try {
    const raw = JSON.parse(result.stdout) as unknown
    if (!isRecord(raw) || raw.schema !== 'fm-primary-ready.v1') {
      return { canReceive: 'unknown', detail: 'ready payload was not fm-primary-ready.v1' }
    }
    if (raw.can_receive === true) return { canReceive: true, detail: '' }
    if (raw.can_receive === false) return { canReceive: false, detail: 'primary cannot receive' }
    return { canReceive: 'unknown', detail: 'can_receive is unknown' }
  } catch {
    return { canReceive: 'unknown', detail: 'ready payload was not JSON' }
  }
}

interface ReceiptNote {
  id?: unknown
  request_id?: unknown
  body?: unknown
  announced?: unknown
  acknowledged?: unknown
  reply?: unknown
}

function notesFrom(raw: Record<string, unknown>): ReceiptNote[] {
  const pending = Array.isArray(raw.pending) ? raw.pending : []
  const handled = Array.isArray(raw.handled) ? raw.handled : []
  return [...pending, ...handled].filter(isRecord) as ReceiptNote[]
}

function replyFromNote(note: ReceiptNote): InboxReplyView | null {
  if (typeof note.id !== 'string') return null
  const reply = isRecord(note.reply) ? note.reply : null
  if (!reply || typeof reply.body !== 'string' || typeof reply.cursor !== 'string') return null
  const requestId = typeof note.request_id === 'string' ? note.request_id : null
  const receipt = parseAppliedReceipt(reply.body)
  const matched: AppliedReceipt | null = receipt.ok && requestId && receipt.value.requestId === requestId
    ? receipt.value
    : null
  return {
    noteId: note.id,
    requestId,
    body: reply.body,
    cursor: reply.cursor,
    announced: typeof note.announced === 'boolean' ? note.announced : null,
    acknowledged: note.acknowledged === true,
    appliedOutcome: matched ? matched.outcome : null,
    receiptDetail: matched ? matched.detail : null,
  }
}

function findReply(raw: Record<string, unknown>, requestId: string): InboxReplyView | null {
  for (const note of notesFrom(raw)) {
    if (note.request_id !== requestId) continue
    return replyFromNote(note)
  }
  return null
}

/**
 * Read receipts for one request id. When the note is missing and `omitted` is
 * non-empty, ask again with the reveal flags instead of treating the page as complete.
 */
export async function readReceipts(opts: InboxClientOptions, requestId: string): Promise<{
  reply: InboxReplyView | null
  omitted: unknown[]
}> {
  const load = async (args: string[]) => {
    const result = await runInbox(opts, 'receipts', args)
    if (result.code !== 0) return null
    try {
      const raw = JSON.parse(result.stdout) as unknown
      if (!isRecord(raw) || raw.schema !== 'fm-inbox-receipts.v1') return null
      return raw
    } catch {
      return null
    }
  }
  const first = await load([])
  if (!first) return { reply: null, omitted: [] }
  const omitted = Array.isArray(first.omitted) ? first.omitted : []
  let reply = findReply(first, requestId)
  if (!reply && omitted.length > 0) {
    const full = await load(['--all-pending', '--all-handled', '--all-replies'])
    if (full) reply = findReply(full, requestId)
  }
  return { reply, omitted }
}

/**
 * The one inbox client. Other tasks import this instead of writing notes themselves.
 * Subcommands are only `note`, `receipts`, and `ready`.
 */
export async function submitIntent(raw: unknown, opts: InboxClientOptions): Promise<IntentSubmission> {
  const requestHint = isRecord(raw) && typeof raw.requestId === 'string' ? raw.requestId : ''
  if (!opts.home || !opts.binDir) {
    return failed(requestHint, 'First Mate home is not configured')
  }
  if (refusedKey(raw)) {
    return failed(requestHint, 'command, shell, and tmux fields are not accepted')
  }
  const parsed = parseIntentEnvelope(raw)
  if (!parsed.ok) return failed(requestHint, parsed.diagnostic)
  const envelope: IntentEnvelope = parsed.value
  if (refusedKey(envelope.body)) {
    return failed(envelope.requestId, 'command, shell, and tmux fields are not accepted')
  }
  if (!requestIdAllowed(envelope.requestId)) {
    return failed(envelope.requestId, 'requestId is not a valid inbox request id')
  }

  const note = await runInbox(opts, 'note', [
    '--request-id',
    envelope.requestId,
    '--json',
    '--',
    JSON.stringify(envelope),
  ])
  const payload = parseNoteStdout(note.stdout)
  if (note.code !== 0 && note.code !== 3) {
    return failed(
      envelope.requestId,
      note.stderr.trim() || (note.code === null ? 'inbox note could not be started' : 'nothing saved'),
      note.code,
    )
  }
  if (!payload?.saved || !payload.id) {
    return failed(envelope.requestId, note.stderr.trim() || 'nothing saved', note.code)
  }

  const ready = await readReady(opts)
  let disposition: IntentDisposition
  if (ready.canReceive !== true) disposition = 'not-receivable'
  else if (note.code === 3 || payload.announced === false) disposition = 'saved-unannounced'
  else disposition = 'queued'

  const detail = disposition === 'queued'
    ? (payload.outcome === 'replay' ? 'replayed the original note' : 'queued')
    : disposition === 'saved-unannounced'
      ? 'saved, not announced'
      : ready.detail || 'not receivable'

  const submission: IntentSubmission = {
    requestId: envelope.requestId,
    noteId: payload.id,
    disposition,
    applied: false,
    announced: payload.announced,
    canReceive: ready.canReceive,
    exitCode: note.code,
    detail,
    noteOutcome: payload.outcome,
  }

  const file = opts.projectionFile ?? defaultProjectionFile()
  const at = (opts.now ?? (() => new Date().toISOString()))()
  await updateProjection(file, doc => {
    doc.intents[envelope.requestId] = {
      requestId: envelope.requestId,
      noteId: payload.id,
      kind: envelope.kind,
      anchor: envelope.anchor,
      disposition,
      at,
    }
  })
  return submission
}
