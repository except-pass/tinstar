import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { askCreateSchema, bridgeUpdateSchema, publicAsk, isArtifactTarget, type AskContext } from '../../shared/ask'
import { getConfigRoot } from '../configRoot'
import { ok, fail } from '../api/envelope'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { resolveCorsHeaders } from '../api/cors'
import { secretEquals } from '../reconciliation/sessions'
import type { ReconciliationSources } from '../reconciliation'
import { artifactContext, type AskArtifactSources } from './artifacts'
import { AskConflict, AskNotFound, AskStore } from './store'

export const askConfigSchema = z.object({ ownerLogins: z.array(z.string().min(1)).min(1), bridgeToken: z.string().min(32) })
export type AskConfig = z.infer<typeof askConfigSchema>
async function config(): Promise<AskConfig | null> {
  try {
    const raw = JSON.parse(await readFile(join(getConfigRoot(), 'config.json'), 'utf8'))
    return askConfigSchema.parse(raw.ask)
  } catch { return null }
}
async function readBody(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON')
  const chunks: Buffer[] = []; let size = 0
  const timeout = setTimeout(() => req.destroy(), 10_000)
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk)
      if (size > 256 * 1024) throw new Error('Request too large')
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { clearTimeout(timeout) }
}

/** The browser route must be behind tailnet-only tailscale serve with the backend
 * bound to loopback. Only serve may inject Tailscale-User-Login. A directly exposed
 * backend would let clients forge it; CORS is not authentication. See ask.md.
 * The bearer bridge is independent: its token never enters browser responses.
 */
export class AskApi {
  readonly store: AskStore
  constructor(private sources: Pick<ReconciliationSources, 'scene'>, root = getConfigRoot(), private getConfig = config, private artifacts?: AskArtifactSources) {
    this.store = new AskStore(root)
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '').split('?')[0]!
    if (!path.startsWith('/api/ask/')) return false
    const allowlist = currentOriginAllowlist()
    const headers = { ...resolveCorsHeaders({ origin: req.headers.origin, allowlist }), 'Cache-Control': 'no-store', Vary: 'Tailscale-User-Login, Origin' }
    if (req.headers.origin && !allowlist.includes(req.headers.origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    const settings = await this.getConfig()
    if (!settings) return fail(res, 'CONFIG_UNAVAILABLE', 'Ask is not configured', { headers })
    if (path === '/api/ask/bridge') {
      if (req.headers.origin || !secretEquals(String(req.headers.authorization ?? ''), `Bearer ${settings.bridgeToken}`)) return fail(res, 'FORBIDDEN', 'Bridge authorization required', { headers, status: 401 })
      try {
        if (req.method === 'GET') return ok(res, await this.store.bridgeWork(), { headers })
        if (req.method === 'POST') { await this.store.ingest(bridgeUpdateSchema.parse(await readBody(req))); return ok(res, { accepted: true }, { headers }) }
        return fail(res, 'BAD_REQUEST', 'Use GET or POST', { headers, status: 405 })
      } catch (error) { return this.error(res, error, headers) }
    }
    // tailscale serve connects locally; reject a directly connected remote peer
    // even with a forged owner header. Local OS users remain in the host trust boundary.
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const login = req.headers['tailscale-user-login']
    if (!(peer === '::1' || peer.startsWith('127.')) || typeof login !== 'string' || !settings.ownerLogins.includes(login)) return fail(res, 'FORBIDDEN', 'Authorized tailnet owner required', { headers })
    if (req.headers['x-tinstar-ui'] !== '1') return fail(res, 'FORBIDDEN', 'UI handshake required', { headers })
    try {
      if (path === '/api/ask/requests' && req.method === 'GET') return ok(res, (await this.store.list(login)).map(publicAsk), { headers })
      if (path === '/api/ask/requests' && req.method === 'POST') {
        const input = askCreateSchema.parse(await readBody(req))
        // A retry remains valid if its card was removed since capture.
        const existing = (await this.store.list(login)).find(row => row.client_key === input.client_key)
        const parent = input.follow_up_to ? await this.store.find(login, input.follow_up_to) : undefined
        if (input.follow_up_to && !parent) throw new AskNotFound('Original question unavailable')
        let context: AskContext
        if (existing || parent) context = (existing ?? parent)!.context
        else if (isArtifactTarget(input.target)) {
          if (!this.artifacts) throw new AskNotFound('Artifact sources unavailable')
          context = await artifactContext(input.target, input.view, { ...(input.field_key ? { field_key: input.field_key, field_value: input.field_value } : {}) }, this.artifacts)
        } else {
          const scene = await this.sources.scene()
          const claim = input.target?.kind === 'claim' ? scene.claims.find(claim => claim.id === input.target!.id) : undefined
          const worker = input.target?.kind === 'execution' ? scene.executions.find(worker => worker.id === input.target!.id) : undefined
          if (input.target && !(claim || worker)) throw new AskNotFound('Entity unavailable in the authorized source')
          const card = scene.cards.find(card => card.id === (claim?.cardId ?? input.card_id))
          if (!card && !worker) throw new AskNotFound('Card unavailable in the authorized source')
          const title = card?.source.properties.Name?.value
          const observation = worker?.observation ?? scene.coverage.intentions
          context = { schema_version: 2, return_to: { section: 'overview', target: input.target ?? { kind: 'card', id: card!.id }, view: input.view }, anchor: { kind: worker ? 'worker' : claim ? 'link' : 'work', page_id: worker?.id ?? card!.id, label: (worker ? String(worker.source.backlog.title || worker.identity.task_id || 'Worker') : typeof title === 'string' ? title : card!.id).slice(0, 512), url: worker ? null : `https://www.notion.so/${card!.id}`, observed_at: observation.observedAt, freshness: observation.status, expires_at: observation.expiresAt }, view: input.view,
            ...(input.target ? { target: input.target } : {}),
            ...(input.field_key ? { field_key: input.field_key, field_value: input.field_value } : {}),
            ...(claim ? { relationship: { claim_id: claim.id, card_id: claim.cardId, execution_id: claim.executionId, sources: claim.sources, basis: claim.basis, verification: claim.verification } } : {}),
          }
        }
        if (existing && !parent && (input.field_key !== context.field_key || input.field_value !== context.field_value)) throw new AskConflict('Question field differs from the original')
        if (input.target ? JSON.stringify(input.target) !== JSON.stringify(context.target) : context.target || input.card_id !== context.anchor.page_id) throw new AskConflict('Question context differs from the original')
        return ok(res, publicAsk(await this.store.create(login, input.client_key, input.question, context, input.follow_up_to)), { headers })
      }
      const match = /^\/api\/ask\/requests\/([a-f0-9-]{36})\/(read|dismiss|retry)$/.exec(path)
      if (match && req.method === 'POST') return ok(res, publicAsk(await this.store.action(login, match[1]!, match[2] as 'read' | 'dismiss' | 'retry')), { headers })
      return fail(res, 'NOT_FOUND', 'Unknown Ask route or method', { headers })
    } catch (error) { return this.error(res, error, headers) }
  }
  private error(res: ServerResponse, error: unknown, headers: Record<string, string>) {
    if (error instanceof AskConflict) return fail(res, 'CONFLICT', error.message, { headers })
    if (error instanceof AskNotFound) return fail(res, 'NOT_FOUND', error.message, { headers })
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof Error && ['Expected JSON', 'Request too large'].includes(error.message)) return fail(res, 'BAD_REQUEST', 'Invalid Ask payload', { headers })
    return fail(res, 'BACKEND_UNAVAILABLE', 'Ask storage unavailable; retry with the same question', { headers })
  }
}
