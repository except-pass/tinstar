import { organizedGroups } from '../../shared/floorOrganization'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { getConfigRoot } from '../configRoot'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { resolveCorsHeaders } from '../api/cors'
import { ok, fail } from '../api/envelope'
import { actionSchema, stateSchema, targetSchema, type CommandResult } from '../../shared/reconciliationCommands'
import type { QueueRead } from '../../shared/reconciliationQueue'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import { SceneSessions, secretEquals } from './sessions'
import { searchWorkSchema, getWorkSchema, startWorkSchema, updateWorkSchema, createWorkSchema, workflowRules, type StartWorkInput, type UpdateWorkInput, type CreateWorkInput } from '../../shared/workflow'
import type { WorkerLinkReport } from './workerLinkReport'
import { registerDomainReadTools, type DomainReadTools } from './domainReads'

export function installToken(root = getConfigRoot()) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'mcp-token')
  try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  chmodSync(path, 0o600)
  const token = readFileSync(path, 'utf8').trim()
  if (!token) throw new Error('MCP token is empty')
  return token
}
// A wildcard application bind must never expose MCP to the public network.
// Ignore proxy headers: an operator must keep this route off public proxies.
export function privatePeer(address = '') {
  const ip = address.replace(/^::ffff:/, '')
  if (ip === '::1' || ip.startsWith('127.')) return true
  const match = /^100\.(\d+)\.\d+\.\d+$/.exec(ip)
  return !!match && Number(match[1]) >= 64 && Number(match[1]) <= 127 || /^fd7a:115c:a1e0:/i.test(ip)
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0
  const timeout = setTimeout(() => req.destroy(), 10_000)
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk)
      if (size > 256 * 1024) throw new Error('request too large')
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { clearTimeout(timeout) }
}
const commandInput = {
  scene_id: z.string().uuid(), command_id: z.string().min(1).max(128), expected_revision: z.number().int().nonnegative(),
  ttl_ms: z.number().int().min(500).max(15_000).default(8000), action: actionSchema,
}
export interface PresentationReaders {
  searchWork?(input: unknown): Promise<unknown>
  getWork?(input: unknown): Promise<unknown>
  startWork?(input: StartWorkInput, actor: string): Promise<unknown>
  updateWork?(input: UpdateWorkInput, actor: string): Promise<unknown>
  createWork?(input: CreateWorkInput, actor: string): Promise<unknown>
  scene(force?: boolean, scope?: { history?: boolean }): Promise<FloorScene>
  card(id: string): Promise<unknown>
  queue(): Promise<QueueRead>
  workerLinkReport(): Promise<WorkerLinkReport>
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const renderedSchema = z.object({ scene_generated_at: z.string().datetime().nullable(), scene_read_failed: z.boolean() }).strict()
const ackSchema = z.object({ command_id: z.string().max(128), scene_id: z.string().uuid(), outcome: z.enum(['applied', 'unknown-id', 'stale-revision', 'expired', 'queue-source-unavailable']), revision: z.number().int().nonnegative().optional(), applied_at: z.number().optional(), state: stateSchema.optional() }).strict()

export class ReconciliationMcp {
  readonly sessions = new SceneSessions()
  private token: string | null
  constructor(private readers: PresentationReaders, root = getConfigRoot(), private domainReads?: DomainReadTools) {
    // MCP config trouble degrades this interface only; source viewing still works.
    try { this.token = installToken(root) } catch { this.token = null }
  }
  createServer(actor = 'Tin Star MCP', request?: IncomingMessage) {
    const server = new McpServer({ name: 'tinstar-overview', version: '6.0.0' })
    const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    server.registerTool('search_work', { description: 'Find configured-board work by owner, status, initiative, epic or checkpoint. Independent of browser filters; default scope excludes Done/Archived. Paginated bounded property reads share UI links and Smart Search patterns (unknown is not none). No scene/window required.', inputSchema: searchWorkSchema, annotations: readAnnotations }, async input => result(await this.readers.searchWork?.(input) ?? { outcome: 'unavailable' }))
    server.registerTool('get_work', { description: 'Read an exact configured-board card, including outside the active scope, bounded body/comments with authors, linked worker/PR evidence and freshness. Current/historical/conflicting/unverified links remain distinct. No scene/window required.', inputSchema: getWorkSchema, annotations: readAnnotations }, async input => result(await this.readers.getWork?.(input) ?? { outcome: 'unavailable' }))
    server.registerTool('get_work_views', { description: 'Read the same Needs Will requests, associated PR/check evidence, honest request age and per-source execution warnings as Decisions/Desk. Passing checks alone never create a merge ask; unknown/stale sources never prove a stranded worker. No scene/window required.', inputSchema: {}, annotations: readAnnotations }, async () => result(await this.readers.queue().catch(() => ({ outcome: 'queue-source-unavailable', message: 'Workflow views unavailable; retained client data is last-known' }))))
    server.registerTool('get_workflow_rules', { description: 'Read code-enforced workflow rules, required fields, tracked native/external workers, coupled decisions, checkpoint limits and safe retry rules. No separate rules-page permission required.', inputSchema: {}, annotations: readAnnotations }, async () => result(workflowRules))
    server.registerTool('start_work', { description: 'Record a real execution: merge exact tracked worker provenance and set In Progress together, attributed to the authenticated caller. Requires Owner and Area; rejects stale/historical/owner-only evidence. Returns confirmed readback or precise not-saved/partially-saved result. Retry identical operation_id/input; no checkpoint/ask changes. External running evidence is explicitly consumer-reported.', inputSchema: startWorkSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, async input => result(await this.readers.startWork?.(input, actor) ?? { outcome: 'not-saved', code: 'unavailable' }))
    server.registerTool('create_work', { description: 'Create a configured-board card with declared owner/area, ordinary properties, brief and acceptance criteria. Firstmate assignment is Queued. Authenticated attribution, confirmed readback and retryable operation_id; no scene/window required.', inputSchema: createWorkSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, async input => result(await this.readers.createWork?.(input, actor) ?? { outcome: 'not-saved', code: 'unavailable' }))
    server.registerTool('update_work', { description: 'Shared workflow operation: edit ordinary properties/brief/acceptance or note; assign/handoff; evidence-backed checkpoint (provisional or owner-confirmed); wait with dependency/unblock/follow-up; request/answer a specific decision with declared next owner/status; complete/park with supported disposition. In Progress requires worker evidence, other asks/history survive. Returns exact saved fields and partial results. Retry identical operation_id/input; no scene/window required.', inputSchema: updateWorkSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, async input => result(await this.readers.updateWork?.(input, actor) ?? { outcome: 'not-saved', code: 'unavailable' }))
    server.registerTool('list_ui_sessions', { description: 'List authorized ephemeral Overview windows and connected state. Choose an explicit scene_id; never guess a window.', inputSchema: {}, annotations: readAnnotations }, async () => result({ sessions: this.sessions.list() }))
    server.registerTool('get_scene', { description: 'Read this window’s applied arrangement, selection, filters, expansion and source freshness.', inputSchema: { scene_id: z.string().uuid() }, annotations: readAnnotations }, async ({ scene_id }) => {
      const window = this.sessions.read(scene_id)
      if (window.outcome === 'unknown-id') return result(window)
      const scene = await this.sceneForWindow(scene_id)
      return result({ ...window, freshness: scene.coverage, counts: scene.counts, warnings: scene.warnings, records: { cards: scene.cards.map(c => ({ id: c.id, title: c.source.properties.Name?.value, expectation: c.expectation })), actors: scene.executions.map(e => ({ id: e.id, identity: e.identity, activity: e.activity, placement: e.placement })), claims: scene.claims.map(c => ({ id: c.id, cardId: c.cardId, executionId: c.executionId, verification: c.verification })), arrangements: scene.arrangements, groups: window.state ? organizedGroups(scene, window.state, Date.now()) : [] } })
    })
    server.registerTool('read_record', { description: 'Read an actor (execution/manager), card, claim, group or evidence and its source identity. Evidence is the claim’s bounded source references, never a terminal transcript.', inputSchema: { scene_id: z.string().uuid(), target: targetSchema, evidence: z.boolean().default(false) }, annotations: readAnnotations }, async ({ scene_id, target, evidence }) => {
      if (this.sessions.read(scene_id).outcome === 'unknown-id') return result({ outcome: 'unknown-id' })
      const scene = await this.sceneForWindow(scene_id)
      let record: unknown
      switch (target.kind) {
        case 'card': record = scene.cards.find(x => x.id === target.id); break
        case 'execution': record = scene.executions.find(x => x.id === target.id); break
        case 'claim': record = [...scene.claims, ...scene.claimHistory].find(x => x.id === target.id); break
        case 'manager': record = scene.coverage.homes.find(x => x.source.home === target.id); break
        case 'group': {
          const state = this.sessions.read(scene_id).state
          const groups = state ? organizedGroups(scene, state, Date.now()) : []
          record = groups.find(x => x.id === target.id) ?? (groups.some(x => x.outerId === target.id) ? { id: target.id, groups: groups.filter(x => x.outerId === target.id) } : Object.values(scene.arrangements).flat().find(x => x.id === target.id)); break
        }
        case 'you': case 'firstMate': record = target.id === 'root' ? { role: target.kind } : undefined; break
      }
      const claims = evidence ? [...scene.claims, ...scene.claimHistory].filter(c => target.kind === 'card' ? c.cardId === target.id : target.kind === 'execution' ? c.executionId === target.id : c.id === target.id) : undefined
      return result({ outcome: record ? 'available' : 'unknown-id', record, evidence: claims, freshness: scene.coverage })
    })
    server.registerTool('get_card_context', { description: 'Read a card from the authorized configured board, including bounded prose, properties, coverage and omissions. No code/transcripts or credentials.', inputSchema: { scene_id: z.string().uuid(), card_id: z.string().regex(/^[a-f0-9]{32}$/) }, annotations: readAnnotations }, async ({ scene_id, card_id }) => {
      if (this.sessions.read(scene_id).outcome === 'unknown-id') return result({ outcome: 'unknown-id' })
      const scene = await this.sceneForWindow(scene_id), card = scene.cards.find(c => c.id === card_id)
      return result(card ? { card, context: await this.readers.card(card_id), freshness: scene.coverage.intentions } : { outcome: 'unknown-id' })
    })
    server.registerTool('get_queue', { description: 'Read ordered Desk readiness and each exact source (home, task, request id/kind), per-source readiness and bound response identity. An unavailable queue is never an empty ready queue.', inputSchema: { scene_id: z.string().uuid() }, annotations: readAnnotations }, async ({ scene_id }) => result(this.sessions.read(scene_id).outcome === 'unknown-id' ? { outcome: 'unknown-id' } : await this.readers.queue().catch(() => ({ outcome: 'queue-source-unavailable', message: 'Queue source read failed' }))))
    server.registerTool('get_worker_link_report', { description: 'Read deterministic configured-home worker-link mismatch findings, unknown coverage and auditable backfill proposals. Report only: First Mate must verify durable task records before writing any proposed merged Notion property.', inputSchema: {}, annotations: readAnnotations }, async () => result(await this.readers.workerLinkReport()))
    server.registerTool('present_view', { description: 'Steer one explicit window using semantic actions only. Include its current revision and a unique command_id. Retry identical input for idempotency. Applied means the browser committed and acknowledged; queued is not applied. User clicks win revision conflicts. View only, no work/approval/Notion changes.', inputSchema: commandInput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async input => this.submitAndWait(input))
    server.registerTool('next_queue_item', { description: 'Navigate to the next ordered verified ready desk item; future actions stay in their work context. Uses the same browser acknowledgment, revision, expiry and idempotency protocol as present_view. Navigation never approves or dismisses.', inputSchema: { scene_id: z.string().uuid(), command_id: z.string().min(1).max(128), expected_revision: z.number().int().nonnegative(), ttl_ms: z.number().int().min(500).max(15_000).default(8000) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async input => this.submitAndWait({ ...input, action: { type: 'navigate-queue', direction: 'next' } }))
    server.registerTool('get_command', { description: 'Read an earlier command outcome without resubmitting or changing the view. Idempotency retained for ten minutes, then unknown-id.', inputSchema: { scene_id: z.string().uuid(), command_id: z.string().max(128) }, annotations: readAnnotations }, async ({ scene_id, command_id }) => result(this.sessions.result(scene_id, command_id)))
    registerDomainReadTools(server, this.domainReads, request)
    return server
  }
  private sceneForWindow(sceneId: string) {
    const filter = this.sessions.read(sceneId).state?.statusFilter?.preset
    return this.readers.scene(false, filter === 'all' || filter === 'custom' ? { history: true } : {})
  }
  private async submitAndWait(input: Parameters<SceneSessions['enqueue']>[0]) {
    const needsQueue = input.action.type === 'navigate-queue' || input.action.type === 'open-queue' && !input.action.cardId
    const queue = needsQueue ? await this.readers.queue().catch(() => ({ outcome: 'queue-source-unavailable' as const, message: 'Queue source read failed' })) : undefined
    const queued = this.sessions.enqueue(input, await this.sceneForWindow(input.scene_id), queue)
    if (queued.outcome !== 'queued') return result(queued)
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const current = this.sessions.result(input.scene_id, input.command_id)
      if (current.outcome !== 'queued') return result(current)
    }
    return result(this.sessions.result(input.scene_id, input.command_id))
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '').split('?')[0]
    const report = path === '/api/reconciliation/worker-links/report'
    if (!report && path !== '/api/reconciliation/mcp' && path !== '/api/reconciliation/ui' && path !== '/api/reconciliation/workflow') return false
    const allowlist = currentOriginAllowlist()
    const headers = { ...resolveCorsHeaders({ origin: req.headers.origin, allowlist }), 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tinstar-UI, MCP-Protocol-Version', 'Cache-Control': 'no-store' }
    if (!privatePeer(req.socket.remoteAddress) || req.headers.origin && !allowlist.includes(req.headers.origin)) return fail(res, 'FORBIDDEN', 'Unauthorized private interface', { headers })
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
    if (report) {
      if (!this.token) return fail(res, 'CONFIG_UNAVAILABLE', 'MCP token unavailable; check private config permissions', { headers })
      if (!secretEquals(String(req.headers.authorization ?? ''), `Bearer ${this.token}`)) return fail(res, 'FORBIDDEN', 'unauthorized', { headers, status: 401 })
      if (req.method !== 'GET') return fail(res, 'BAD_REQUEST', 'Read-only endpoint; use GET', { headers, status: 405 })
      return ok(res, await this.readers.workerLinkReport(), { headers })
    }
    if (req.method !== 'POST') return fail(res, 'BAD_REQUEST', 'Use POST', { headers, status: 405 })
    if (path.endsWith('/mcp')) {
      if (!this.token) return fail(res, 'CONFIG_UNAVAILABLE', 'MCP token unavailable; check private config permissions', { headers })
      if (!secretEquals(String(req.headers.authorization ?? ''), `Bearer ${this.token}`)) return fail(res, 'FORBIDDEN', 'unauthorized', { headers, status: 401 })
      let parsed: unknown
      try { parsed = await body(req) } catch { return fail(res, 'BAD_REQUEST', 'Invalid bounded JSON request', { headers }) }
      // The facade authenticates its caller before forwarding. Only the
      // install-token authority may assert this identity; browser input cannot.
      const forwarded = req.headers['x-tinstar-caller']
      const actor = typeof forwarded === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,99}$/.test(forwarded) ? forwarded : 'Tin Star MCP'
      const server = this.createServer(actor, req)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
      res.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res, parsed)
      return true
    }
    // A custom header forces a browser preflight, preventing cross-site form
    // registration; this uses the app's existing local/desktop origin authority.
    if (req.headers['x-tinstar-ui'] !== '1') return fail(res, 'FORBIDDEN', 'UI handshake required', { headers })
    if (path === '/api/reconciliation/workflow') {
      try {
        const request = z.object({ operation: z.enum(['search', 'get', 'start', 'update', 'create', 'rules']), input: z.unknown().optional() }).strict().parse(await body(req))
        if (request.operation === 'rules') return ok(res, workflowRules, { headers })
        if (request.operation === 'search') return ok(res, await this.readers.searchWork?.(searchWorkSchema.parse(request.input)), { headers })
        if (request.operation === 'get') return ok(res, await this.readers.getWork?.(getWorkSchema.parse(request.input)), { headers })
        if (request.operation === 'update') return ok(res, await this.readers.updateWork?.(updateWorkSchema.parse(request.input), 'Tin Star UI'), { headers })
        if (request.operation === 'create') return ok(res, await this.readers.createWork?.(createWorkSchema.parse(request.input), 'Tin Star UI'), { headers })
        return ok(res, await this.readers.startWork?.(startWorkSchema.parse(request.input), 'Tin Star UI'), { headers })
      } catch { return fail(res, 'BAD_REQUEST', 'Invalid workflow request; use the shared workflow operation schema', { headers }) }
    }
    try {
      const parsed = z.discriminatedUnion('type', [
        z.object({ type: z.literal('register'), state: stateSchema, rendered_scene: renderedSchema.optional() }).strict(),
        z.object({ type: z.literal('sync'), scene_id: z.string().uuid(), key: z.string().max(128), state: stateSchema, acknowledgments: z.array(ackSchema).max(32), rendered_scene: renderedSchema.optional() }).strict(),
        z.object({ type: z.literal('disconnect'), scene_id: z.string().uuid(), key: z.string().max(128) }).strict(),
      ]).parse(await body(req))
      if (parsed.type === 'register') return ok(res, this.sessions.register(parsed.state, parsed.rendered_scene), { headers })
      if (!this.sessions.authorized(parsed.scene_id, parsed.key)) return fail(res, 'FORBIDDEN', 'unauthorized', { headers })
      if (parsed.type === 'disconnect') { this.sessions.disconnect(parsed.scene_id); return ok(res, { outcome: 'disconnected' }, { headers }) }
      return ok(res, { commands: this.sessions.sync(parsed.scene_id, parsed.state, parsed.acknowledgments as CommandResult[], parsed.rendered_scene) }, { headers })
    } catch { return fail(res, 'BAD_REQUEST', 'Invalid UI presentation request', { headers }) }
  }
}
