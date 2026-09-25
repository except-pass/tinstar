import type { IncomingMessage, ServerResponse } from 'node:http'
import { fail, ok } from '../../api/envelope'
import { readBody } from '../../api/readBody'
import { parseAppliedReceipt } from '../../../v6/contract/intent'
import { isRecord } from '../../../v6/contract/result'
import {
  applyReceipt,
  prepareAnswer,
  projectSubmission,
  readEntry,
  upsertRow,
  type AnswerKind,
  type AttentionRow,
  type InboxSubmission,
} from '../../../v6/needsyou/model'
import { defaultAttentionDir, mutateAttention, readAttention } from './store'

export interface NeedsYouInboxOptions {
  home: string
  binDir: string
  projectionFile?: string
}

/** Shell `submitIntent`. Tests inject a fake. Production resolves the shell module. */
export type SubmitIntent = (raw: unknown, opts: NeedsYouInboxOptions) => Promise<InboxSubmission>

export interface NeedsYouRouteOptions {
  /** Projection directory. Default is getConfigRoot()/v6/needsyou. */
  dir?: string
  submitIntent?: SubmitIntent
  inbox?: NeedsYouInboxOptions
  now?: () => string
}

export type NeedsYouHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

const ANSWER_KINDS = new Set<AnswerKind>(['attention.answer', 'schedule.acknowledge'])

function directory(opts: NeedsYouRouteOptions): string {
  return opts.dir ?? defaultAttentionDir()
}

function jsonType(req: IncomingMessage): boolean {
  const value = req.headers['content-type']
  if (Array.isArray(value)) return value.some(part => part.toLowerCase().startsWith('application/json'))
  return typeof value === 'string' && value.toLowerCase().startsWith('application/json')
}

async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  if (!jsonType(req)) return { ok: false, message: 'Content-Type must be application/json' }
  let text = ''
  try {
    text = await readBody(req)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'body could not be read' }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, message: 'Invalid request body' }
  }
}

function notConfigured(requestId: string): InboxSubmission {
  return {
    requestId,
    noteId: null,
    disposition: 'failed',
    applied: false,
    detail: 'inbox client is not configured',
  }
}

async function loadShellSubmit(): Promise<SubmitIntent | null> {
  try {
    const href = new URL('../shell/submitIntent.ts', import.meta.url).href
    const load = new Function('href', 'return import(href)') as (href: string) => Promise<unknown>
    const loaded = await load(href)
    if (!isRecord(loaded) || typeof loaded.submitIntent !== 'function') return null
    return loaded.submitIntent as SubmitIntent
  } catch {
    return null
  }
}

function publicRow(row: AttentionRow) {
  return {
    fixture: row.fixture,
    ci: row.ci,
    item: row.wire,
    delivery: row.delivery,
    answerRequestId: row.answerRequestId,
    spentRequestIds: row.spentRequestIds,
    lastError: row.lastError,
    receiptDetail: row.receiptDetail,
    acknowledgement: row.acknowledgement,
    applied: row.delivery === 'applied',
  }
}

export function registerNeedsYouRoutes(opts: NeedsYouRouteOptions = {}): NeedsYouHandler {
  const stamp = opts.now ?? (() => new Date().toISOString())

  return async function handleNeedsYou(req, res): Promise<boolean> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (!path.startsWith('/api/v6/needsyou')) return false
    const method = req.method ?? 'GET'
    const dir = directory(opts)

    try {
      if (method === 'GET' && path === '/api/v6/needsyou') {
        const doc = readAttention(dir)
        ok(res, { items: doc.items.map(publicRow) })
        return true
      }

      if (method === 'POST' && path === '/api/v6/needsyou/items') {
        const body = await readJson(req)
        if (!body.ok) {
          fail(res, 'BAD_REQUEST', body.message)
          return true
        }
        const entry = readEntry(body.value, 0)
        if (entry.kind === 'diagnostic') {
          fail(res, 'INVALID_PARAMS', entry.diagnostic)
          return true
        }
        const saved = await mutateAttention(dir, doc => {
          doc.items = upsertRow(doc.items, entry.row)
          return doc.items.find(row => row.item.id === entry.row.item.id) ?? entry.row
        })
        ok(res, publicRow(saved))
        return true
      }

      if (method === 'POST' && path === '/api/v6/needsyou/receipts') {
        const body = await readJson(req)
        if (!body.ok) {
          fail(res, 'BAD_REQUEST', body.message)
          return true
        }
        const receipt = parseAppliedReceipt(body.value)
        if (!receipt.ok) {
          fail(res, 'INVALID_PARAMS', receipt.diagnostic)
          return true
        }
        const outcome = await mutateAttention(dir, doc => {
          const applied = applyReceipt(doc.items, receipt.value)
          doc.items = applied.items
          return applied
        })
        const row = outcome.items.find(item => item.answerRequestId === receipt.value.requestId)
          ?? outcome.items.find(item => item.spentRequestIds.includes(receipt.value.requestId))
        ok(res, {
          changed: outcome.changed,
          detail: outcome.detail,
          applied: row?.delivery === 'applied',
          item: row ? publicRow(row) : null,
        })
        return true
      }

      const answerMatch = path.match(/^\/api\/v6\/needsyou\/([^/]+)\/answer$/)
      if (answerMatch && method === 'POST') {
        const id = decodeURIComponent(answerMatch[1] ?? '')
        const body = await readJson(req)
        if (!body.ok) {
          fail(res, 'BAD_REQUEST', body.message)
          return true
        }
        if (!isRecord(body.value)) {
          fail(res, 'INVALID_PARAMS', 'body must be an object')
          return true
        }
        const kindRaw = body.value.kind === undefined ? 'attention.answer' : body.value.kind
        if (typeof kindRaw !== 'string' || !ANSWER_KINDS.has(kindRaw as AnswerKind)) {
          fail(res, 'INVALID_PARAMS', 'kind is not an attention answer')
          return true
        }
        const kind = kindRaw as AnswerKind
        if (typeof body.value.revision !== 'string' || typeof body.value.requestId !== 'string' || !isRecord(body.value.body)) {
          fail(res, 'INVALID_PARAMS', 'revision, requestId, and body are required')
          return true
        }
        const seenRevision = body.value.revision
        const requestId = body.value.requestId
        const answerBody = body.value.body

        const existing = readAttention(dir).items.find(row => row.item.id === id)
        if (!existing) {
          fail(res, 'NOT_FOUND', `Needs You item ${id} not found`)
          return true
        }
        if (existing.spentRequestIds.includes(requestId) || existing.delivery === 'applied') {
          ok(res, { ...publicRow(existing), detail: 'already applied', applied: existing.delivery === 'applied' })
          return true
        }

        const prepared = prepareAnswer({
          item: existing.item,
          seenRevision,
          requestId,
          kind,
          body: answerBody,
        })
        if (!prepared.ok) {
          fail(res, prepared.diagnostic === 'revision mismatch' ? 'CONFLICT' : 'INVALID_PARAMS', prepared.diagnostic, {
            details: { applied: false },
          })
          return true
        }

        const submit = opts.submitIntent ?? await loadShellSubmit()
        let submission: InboxSubmission
        if (!submit) {
          submission = notConfigured(requestId)
        } else if (!opts.submitIntent && (!opts.inbox?.home || !opts.inbox.binDir)) {
          submission = notConfigured(requestId)
        } else {
          submission = await submit(prepared.envelope, opts.inbox ?? { home: '', binDir: '' })
          if (submission.applied !== false) submission = { ...submission, applied: false }
        }

        const saved = await mutateAttention(dir, doc => {
          const index = doc.items.findIndex(row => row.item.id === id)
          const current = index < 0 ? existing : doc.items[index]
          if (!current) return existing
          if (current.item.revision !== existing.item.revision) return current
          const next = projectSubmission(current, prepared, submission, stamp())
          if (index < 0) doc.items = [...doc.items, next]
          else doc.items[index] = next
          return next
        })
        ok(res, { ...publicRow(saved), detail: submission.detail, disposition: submission.disposition })
        return true
      }

      fail(res, 'NOT_FOUND', 'Needs You route not found')
      return true
    } catch (err) {
      fail(res, 'INTERNAL', err instanceof Error ? err.message : 'needs you route failed')
      return true
    }
  }
}
