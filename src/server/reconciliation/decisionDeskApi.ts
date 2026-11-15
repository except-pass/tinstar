import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { cardIdSchema } from '../../shared/workIdentity'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { resolveCorsHeaders } from '../api/cors'
import { ok, fail } from '../api/envelope'
import { DecisionDeskConflict, type DecisionPackets } from './decisionPackets'
import type { DecisionEvidence } from '../../shared/decisionPacket'
import { workReadback } from './workReadback'

async function policyBody(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new z.ZodError([{ code: 'custom', path: [], message: 'Expected JSON policy' }])
  const chunks: Buffer[] = []; let bytes = 0
  const timeout = setTimeout(() => req.destroy(), 10_000)
  try {
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 16 * 1024) throw new z.ZodError([{ code: 'custom', path: [], message: 'Policy body exceeds 16 KiB' }])
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { clearTimeout(timeout) }
}

/** Owner-authenticated storage/read API only. Publication stays an internal
 * service operation until the preparer capability contract is chosen. Nothing
 * here launches research, takes a review lease or changes a source card. */
export class DecisionDeskApi {
  constructor(private packets: DecisionPackets, private scope: string, private evidence: (cardId: string) => DecisionEvidence,
    private authorized: (req: IncomingMessage) => Promise<boolean>) {}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local')
    const paths = ['/api/reconciliation/decision-desk/policy', '/api/reconciliation/decision-desk/evidence', '/api/reconciliation/decision-desk/packets', '/api/reconciliation/decision-desk/packet', '/api/reconciliation/decision-desk/events']
    if (!paths.includes(url.pathname)) return false
    const origin = req.headers.origin, allowlist = currentOriginAllowlist()
    const headers = { ...resolveCorsHeaders({ origin, allowlist }), 'Cache-Control': 'no-store', Vary: 'Tailscale-User-Login, Origin', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Tinstar-UI' }
    if (origin && !allowlist.includes(origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
    if (!await this.authorized(req) || typeof req.headers['tailscale-user-login'] !== 'string') return fail(res, 'FORBIDDEN', 'Authorized tailnet owner required for Decision Desk', { headers })
    if (req.headers['x-tinstar-ui'] !== '1') return fail(res, 'FORBIDDEN', 'UI handshake required', { headers })
    try {
      if (url.pathname.endsWith('/policy')) {
        if (req.method === 'GET') return ok(res, await this.packets.readPolicy(this.scope), { headers })
        if (req.method === 'PUT') return ok(res, await this.packets.updatePolicy(this.scope, await policyBody(req), req.headers['tailscale-user-login']), { headers })
      } else if (req.method === 'GET') {
        if (url.pathname.endsWith('/evidence')) return ok(res, workReadback(this.evidence(cardIdSchema.parse(url.searchParams.get('card_id')))), { headers })
        if (url.pathname.endsWith('/events')) {
          const after = z.coerce.number().int().nonnegative().safeParse(url.searchParams.get('after') ?? 0)
          if (!after.success) throw after.error
          return ok(res, workReadback(await this.packets.events(after.data)), { headers })
        }
        if (url.pathname.endsWith('/packets')) {
          const values = []
          for (const id of await this.packets.ids()) {
            const packet = await this.packets.read(id)
            if (packet) values.push({ id, version: packet.version, card_id: packet.packet.binding.card_id, content_hash: packet.content_hash, published_at: packet.published_at, expires_at: packet.expires_at })
          }
          return ok(res, workReadback({ packets: values, scope: this.scope, omissions: ['Bounded publication inventory, not a Ready count; inspect current evidence for eligibility.'] }), { headers })
        }
        const id = z.string().uuid().parse(url.searchParams.get('id'))
        const stored = await this.packets.read(id)
        if (!stored) return fail(res, 'NOT_FOUND', 'Packet is unavailable', { headers })
        return ok(res, workReadback(await this.packets.read(id, this.evidence(stored.packet.binding.card_id))), { headers })
      }
      return fail(res, 'BAD_REQUEST', 'Use GET, or PUT for the versioned policy', { headers, status: 405 })
    } catch (error) {
      if (error instanceof DecisionDeskConflict) return fail(res, 'CONFLICT', error.message, { headers })
      if (error instanceof z.ZodError || error instanceof SyntaxError) return fail(res, 'BAD_REQUEST', 'Invalid Decision Desk request; settings were not saved', { headers })
      return fail(res, 'BACKEND_UNAVAILABLE', 'Decision Desk storage unavailable; settings were not confirmed saved', { headers })
    }
  }
}
