import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { fail, ok } from '../../api/envelope'
import { readBody } from '../../api/readBody'
import { isRecord } from '../../../v6/contract/result'
import { parseAppliedReceipt, parseIntentEnvelope, type IntentEnvelope } from '../../../v6/contract/intent'
import {
  containsRefusedKey,
  isStale,
  proposalFromIntent,
  reconcileReceipt,
  recordSubmission,
  requestIdAllowed,
  type SubmissionInput,
} from '../../../v6/portfolio/model'
import { PLAN_SLUG } from '../../../v6/portfolio/plan'
import type { PlanView, PortfolioDoc } from '../../../v6/portfolio/types'
import { fetchStretchPlan } from './planClient'
import { loadPortfolio, resolvePortfolioFile, updatePortfolio } from './store'

export interface ShellSubmission {
  requestId: string
  noteId: string | null
  disposition: string
  applied: boolean
  announced: boolean | null
  canReceive: boolean | 'unknown' | null
  exitCode: number | null
  detail: string
  noteOutcome: string | null
}

export type PortfolioShellSubmit = (
  raw: unknown,
  opts: { home: string; binDir: string; projectionFile?: string },
) => Promise<ShellSubmission>

export type PortfolioReadReceipts = (
  opts: { home: string; binDir: string },
  requestId: string,
) => Promise<{ reply: { body: string; requestId: string | null } | null }>

export interface PortfolioRouteDeps {
  /** Shell inbox client. Tests inject a fake. Unconfigured calls do not spawn. */
  submitIntent?: PortfolioShellSubmit
  readReceipts?: PortfolioReadReceipts
  projectionFile?: string
  home?: string
  binDir?: string
  fetchPlan?: (slug: string) => Promise<PlanView>
}

const unconfiguredSubmit: PortfolioShellSubmit = async raw => {
  const requestId = isRecord(raw) && typeof raw.requestId === 'string' ? raw.requestId : ''
  return {
    requestId,
    noteId: null,
    disposition: 'failed',
    applied: false,
    announced: null,
    canReceive: null,
    exitCode: null,
    detail: 'submitIntent is not configured',
    noteOutcome: null,
  }
}

const unconfiguredReceipts: PortfolioReadReceipts = async () => ({ reply: null })

function inboxOpts(deps: PortfolioRouteDeps): { home: string; binDir: string } {
  return {
    home: deps.home ?? process.env.TINSTAR_V6_FM_HOME ?? '',
    binDir: deps.binDir ?? process.env.FM_V6_BIN ?? '',
  }
}

function submissionOf(raw: ShellSubmission): SubmissionInput {
  return {
    requestId: raw.requestId,
    noteId: raw.noteId,
    disposition: raw.disposition,
    applied: false,
    detail: raw.detail,
    exitCode: raw.exitCode,
    canReceive: raw.canReceive,
    noteOutcome: raw.noteOutcome,
  }
}

type IntentWrite =
  | { error: string; status: 400 | 409 }
  | { board: PortfolioDoc }

function publicSubmission(doc: PortfolioDoc, requestId: string) {
  const row = doc.pending.find(item => item.requestId === requestId)
  return {
    requestId,
    noteId: row?.noteId ?? null,
    disposition: row?.disposition ?? 'failed',
    applied: row?.applied === true,
    detail: row?.detail ?? 'Not applied',
    exitCode: row?.exitCode ?? null,
    canReceive: row?.canReceive ?? null,
  }
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  const type = req.headers['content-type']
  if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
    fail(res, 'BAD_REQUEST', 'Content-Type must be application/json', { status: 415 })
    return undefined
  }
  let text: string
  try {
    text = await readBody(req)
  } catch (err) {
    fail(res, 'BAD_REQUEST', err instanceof Error ? err.message : 'bad body')
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    fail(res, 'BAD_REQUEST', 'body must be JSON')
    return undefined
  }
}

export function createPortfolioHandler(deps: PortfolioRouteDeps = {}) {
  const submitIntent = deps.submitIntent ?? unconfiguredSubmit
  const readReceipts = deps.readReceipts ?? unconfiguredReceipts
  const fetchPlan = deps.fetchPlan ?? (async (slug: string) => fetchStretchPlan(slug, {
    baseUrl: process.env.STRETCHPLAN_URL || 'http://127.0.0.1:8932',
  }))

  return async function handlePortfolio(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path !== '/api/v6/portfolio' && !path.startsWith('/api/v6/portfolio/')) return false

    const located = resolvePortfolioFile(deps.projectionFile)
    if (!located.ok) {
      fail(res, 'PATH_OUTSIDE_WORKSPACE', located.detail)
      return true
    }
    const file = located.file
    const method = req.method ?? 'GET'

    if (path === '/api/v6/portfolio' && method === 'GET') {
      try {
        ok(res, { board: loadPortfolio(file) })
      } catch (err) {
        fail(res, 'INTERNAL', err instanceof Error ? err.message : 'portfolio could not be read')
      }
      return true
    }

    const planMatch = path.match(/^\/api\/v6\/portfolio\/plans\/([^/]+)$/)
    if (planMatch) {
      if (method !== 'GET') {
        fail(res, 'BAD_REQUEST', 'Stretch Plan is read only', { status: 405 })
        return true
      }
      const slug = decodeURIComponent(planMatch[1] ?? '')
      if (!PLAN_SLUG.test(slug)) {
        fail(res, 'INVALID_PARAMS', 'Invalid plan slug')
        return true
      }
      ok(res, await fetchPlan(slug))
      return true
    }

    if (path === '/api/v6/portfolio/intent' && method === 'POST') {
      const raw = await readJson(req, res)
      if (raw === undefined) return true
      if (containsRefusedKey(raw)) {
        fail(res, 'FORBIDDEN', 'command, shell, and tmux fields are not accepted')
        return true
      }
      const parsed = parseIntentEnvelope(raw)
      if (!parsed.ok) {
        fail(res, 'BAD_REQUEST', parsed.diagnostic)
        return true
      }
      const envelope: IntentEnvelope = parsed.value
      if (!requestIdAllowed(envelope.requestId)) {
        fail(res, 'INVALID_PARAMS', 'requestId is not a valid inbox request id')
        return true
      }
      const outcome = await updatePortfolio<IntentWrite>(file, async doc => {
        const existing = doc.pending.find(item => item.requestId === envelope.requestId)
        if (!existing) {
          const proposal = proposalFromIntent(doc, envelope)
          if (!proposal.ok) return { doc, result: { error: proposal.diagnostic, status: 400 as const } }
          if (isStale(doc, envelope.revision, proposal.value)) {
            return { doc, result: { error: 'Stale edit', status: 409 as const } }
          }
          const submitted = await submitIntent(envelope, { ...inboxOpts(deps), projectionFile: file })
          const next = recordSubmission(doc, envelope, proposal.value, submissionOf(submitted))
          return { doc: next, result: { board: next } }
        }
        const submitted = await submitIntent(envelope, { ...inboxOpts(deps), projectionFile: file })
        const next = recordSubmission(doc, envelope, existing.proposal, submissionOf(submitted))
        return { doc: next, result: { board: next } }
      })
      if ('error' in outcome) {
        const status = outcome.status === 409 ? 'CONFLICT' : 'BAD_REQUEST'
        fail(res, status, outcome.error)
        return true
      }
      ok(res, { submission: publicSubmission(outcome.board, envelope.requestId), board: outcome.board })
      return true
    }

    if (path === '/api/v6/portfolio/reconcile' && method === 'POST') {
      const raw = await readJson(req, res)
      if (raw === undefined) return true
      if (!isRecord(raw) || typeof raw.requestId !== 'string') {
        fail(res, 'BAD_REQUEST', 'requestId is required')
        return true
      }
      if (containsRefusedKey(raw)) {
        fail(res, 'FORBIDDEN', 'command, shell, and tmux fields are not accepted')
        return true
      }
      const requestId = raw.requestId
      const receipts = await readReceipts(inboxOpts(deps), requestId)
      let receipt: { requestId: string; outcome: 'applied' | 'rejected'; detail: string } | null = null
      if (receipts.reply && typeof receipts.reply.body === 'string') {
        const parsed = parseAppliedReceipt(receipts.reply.body)
        if (parsed.ok && parsed.value.requestId === requestId) receipt = parsed.value
      }
      const outcome = await updatePortfolio(file, doc => {
        const reconciled = reconcileReceipt(doc, requestId, receipt)
        return { doc: reconciled.doc, result: reconciled }
      })
      if (outcome.status === 'missing') {
        fail(res, 'NOT_FOUND', outcome.detail)
        return true
      }
      ok(res, { board: outcome.doc, status: outcome.status, detail: outcome.detail })
      return true
    }

    fail(res, 'NOT_FOUND', 'Unknown portfolio route')
    return true
  }
}

/** Attach the portfolio routes to a throwaway or composed HTTP server. */
export function registerPortfolioRoutes(server: Server, deps: PortfolioRouteDeps = {}): ReturnType<typeof createPortfolioHandler> {
  const handle = createPortfolioHandler(deps)
  server.on('request', (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) fail(res, 'INTERNAL', 'Portfolio request failed')
    })
  })
  return handle
}
