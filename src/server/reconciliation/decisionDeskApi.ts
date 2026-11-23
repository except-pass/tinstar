import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { cardIdSchema } from '../../shared/workIdentity'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { resolveCorsHeaders } from '../api/cors'
import { ok, fail } from '../api/envelope'
import { type PreparedReviews, reviewSessionInput, preparedClaimInput, preparedReleaseInput } from './preparedReviews'
import { CardLeaseError, leaseFailure, leaseHash } from './cardLeases'
import { DecisionDeskConflict, type DecisionPackets } from './decisionPackets'
import { preparedRecoveryInput, preparedSubmitInput, type PreparedSubmissions } from './preparedSubmissions'
import { workReadback } from './workReadback'

async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new SyntaxError('Expected application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  const timeout = setTimeout(() => req.destroy(), 10_000)
  try {
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 128 * 1024) throw new SyntaxError('Request body exceeds 128 KiB')
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { clearTimeout(timeout) }
}

const base = '/api/reconciliation/decision-desk/'
const pendingWriteHint = 'The pending write may belong to the card already bound to this review session. '
  + `Find the reserved card and operation in the Decision Desk pending-writes list at GET ${base}source-writes. `
  + `Once the earlier request has settled, send POST ${base}reconcile-source-write with card_id, operation, earlier_request_settled: true, and a reason. `
  + 'Include the X-Tinstar-UI: 1 header on both requests.'
const paths = new Set(['snapshot', 'submit', 'submission-state', 'metrics', 'sessions', 'claim', 'release', 'close-session',
  'source-writes', 'reconcile-source-write'])

export class DecisionDeskApi {
  constructor(private packets: DecisionPackets, private authorized: (req: IncomingMessage) => Promise<boolean>,
    private reviews: PreparedReviews, private submissions: PreparedSubmissions,
    private recovery?: { list(): unknown; reconcile(card: string, operation: string, actor: string, reason: string): Promise<unknown> }) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname.slice(base.length)
    if (!url.pathname.startsWith(base) || !paths.has(path)) return false
    const origin = req.headers.origin, allowlist = currentOriginAllowlist()
    const headers = { ...resolveCorsHeaders({ origin, allowlist }), 'Cache-Control': 'no-store', Vary: 'Tailscale-User-Login, Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Tinstar-UI' }
    const respond = (value: unknown) => ok(res, value, { headers })
    if (origin && !allowlist.includes(origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
    const login = req.headers['tailscale-user-login']
    if (typeof login !== 'string' || !await this.authorized(req)) return fail(res, 'FORBIDDEN', 'Authorized tailnet owner required for Decision Desk', { headers })
    if (req.headers['x-tinstar-ui'] !== '1') return fail(res, 'FORBIDDEN', 'UI handshake required', { headers })
    const caller = leaseHash(JSON.stringify(['web-review', login, this.packets.scope]))
    let exactClaim = false
    try {
      if (req.method === 'GET') {
        switch (path) {
          case 'snapshot': return respond(workReadback(await this.reviews.snapshot()))
          case 'sessions': return respond(await this.reviews.list(caller))
          case 'metrics': return respond(await this.submissions.metrics())
          case 'source-writes':
            if (this.recovery) return respond(workReadback(this.recovery.list()))
        }
      }
      if (req.method === 'POST') {
        switch (path) {
          case 'claim': {
            const input = preparedClaimInput.required({ review_session_token: true }).parse(await body(req))
            exactClaim = input.card_id !== undefined
            return respond(await this.reviews.claim(caller, 'Browser review', input))
          }
          case 'release':
            return respond(await this.reviews.release(caller, 'Browser review', preparedReleaseInput.parse(await body(req))))
          case 'sessions':
            return respond(await this.reviews.create(caller, reviewSessionInput.parse(await body(req))))
          case 'close-session': {
            const input = z.object({ review_session_token: z.string().min(1).max(256), reason: z.string().trim().min(1).max(1000) }).parse(await body(req))
            return respond(await this.reviews.close(caller, input.review_session_token, input.reason))
          }
          case 'submit':
            return respond(await this.submissions.submit(caller, 'Browser review', preparedSubmitInput.parse(await body(req)), 'Will'))
          case 'submission-state':
            return respond(await this.submissions.recover(caller, preparedRecoveryInput.parse(await body(req))))
          case 'reconcile-source-write': {
            if (!this.recovery) break
            const input = z.object({ card_id: cardIdSchema, operation: z.string().uuid(), earlier_request_settled: z.literal(true),
              reason: z.string().trim().min(1).max(4000) }).parse(await body(req))
            return respond(await this.recovery.reconcile(input.card_id, input.operation, login, input.reason))
          }
        }
      }
      return fail(res, 'BAD_REQUEST', 'Method unavailable for this resource', { headers, status: 405 })
    } catch (error) {
      if (error instanceof CardLeaseError) {
        const refusal = leaseFailure(error)
        return respond(exactClaim && refusal.code === 'source-write-pending' ? { ...refusal, message: pendingWriteHint } : refusal)
      }
      if (error instanceof DecisionDeskConflict) return fail(res, 'CONFLICT', error.message, { headers })
      if (error instanceof z.ZodError) return fail(res, 'BAD_REQUEST', error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), { headers })
      if (error instanceof SyntaxError) return fail(res, 'BAD_REQUEST', 'Invalid JSON request', { headers })
      return fail(res, 'BACKEND_UNAVAILABLE', 'Decision Desk storage unavailable', { headers })
    }
  }
}
