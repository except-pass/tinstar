import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { askViewSchema } from '../../shared/ask'
import { candidateSchema, selectionSchema, operationSchema, readerRepositories, type ActionSnapshot } from '../../shared/actions'
import { releasePull } from '../../shared/releases'
import { getConfigRoot } from '../configRoot'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { resolveCorsHeaders } from '../api/cors'
import { ok, fail } from '../api/envelope'
import { ActionStore } from './store'
import { ActionExecutor } from './executor'
import { actionExamples } from './examples'
import { cmsandboxCheckPolicy } from './checkPolicy'
import { runnerStatus } from './runner'
import { readActionJob, readActionSnapshot } from './evidence'

const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const invoke = z.object({ key: z.string().uuid(), action: key, version: key, targets: z.array(selectionSchema).min(1).max(10), mode: z.enum(['direct', 'coordinated']), view: askViewSchema, repair: operationSchema.refine(value => value.kind === 'repair.update' || value.kind === 'repair.rerun').optional() }).strict()
async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON')
  let size = 0; const chunks: Buffer[] = []
  const timeout = setTimeout(() => req.destroy(), 10_000)
  try {
    for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 256 * 1024) throw new Error('Request too large'); chunks.push(Buffer.from(chunk)) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { clearTimeout(timeout) }
}
export class ActionsApi {
  readonly executor: ActionExecutor
  private ready?: Promise<void>
  constructor(readonly store = new ActionStore(), private read = readActionSnapshot, private root = getConfigRoot()) {
    this.executor = new ActionExecutor(store, read, cmsandboxCheckPolicy, readActionJob)
  }
  private async initialize() { await (this.ready ??= this.store.reconcileInterrupted()) }
  async receipt(id: string) { await this.initialize(); return (await this.store.receipts()).find(receipt => receipt.id === id) }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local')
    if (!url.pathname.startsWith('/api/actions')) return false
    const origin = req.headers.origin, allowlist = currentOriginAllowlist()
    const headers = { ...resolveCorsHeaders({ origin, allowlist }), 'Cache-Control': 'no-store', Vary: 'Tailscale-User-Login, Origin' }
    if (origin && !allowlist.includes(origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
    let owners: string[] = []
    try { owners = z.array(z.string()).parse(JSON.parse(await readFile(join(this.root, 'config.json'), 'utf8')).ask?.ownerLogins) } catch { owners = [] }
    const login = req.headers['tailscale-user-login'], peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    if (!(peer === '::1' || peer.startsWith('127.')) || typeof login !== 'string' || !owners.includes(login) || req.headers['x-tinstar-ui'] !== '1') return fail(res, 'FORBIDDEN', 'Authorized owner UI required for local action operations', { headers })
    try {
      await this.initialize()
      if (req.method === 'GET' && url.pathname === '/api/actions') return ok(res, { installed: await this.store.list(), examples: actionExamples(), runner: runnerStatus, policy: cmsandboxCheckPolicy, receipts: await this.store.receipts() }, { headers })
      if (req.method === 'GET' && url.pathname === '/api/actions/inspect') {
        const id = key.parse(url.searchParams.get('id')), version = url.searchParams.get('version') ?? undefined
        return ok(res, { installed: await this.store.inspect(id, version), versions: await this.store.versions(id) }, { headers })
      }
      if (req.method === 'POST' && url.pathname === '/api/actions/install') {
        const input = z.object({ candidate: candidateSchema, inspected: z.literal(true) }).strict().parse(await body(req))
        return ok(res, await this.store.install(input.candidate, login), { headers })
      }
      if (req.method === 'POST' && url.pathname === '/api/actions/rollback') {
        const input = z.object({ id: key, version: key }).strict().parse(await body(req))
        await this.store.rollback(input.id, input.version, login)
        return ok(res, { rolledBack: true }, { headers })
      }
      if (req.method === 'POST' && url.pathname === '/api/actions/capture') {
        const input = z.object({ target: selectionSchema }).strict().parse(await body(req))
        const identity = releasePull(input.target.url)
        if (!identity || !readerRepositories.includes(identity.repository as typeof readerRepositories[number])) throw new Error('Target outside Reader scope')
        const snapshot = await this.read(identity.url)
        if (snapshot.head !== input.target.head || snapshot.base !== input.target.base) throw new Error('Selected head/base changed')
        return ok(res, snapshot, { headers })
      }
      if (req.method === 'POST' && url.pathname === '/api/actions/run') {
        const input = invoke.parse(await body(req)), installed = await this.store.inspect(input.action, input.version)
        const targets: ActionSnapshot[] = []
        // Four read slots, selected targets only. No inventory scan or caller-controlled tool URL.
        for (let index = 0; index < input.targets.length; index += 4) targets.push(...await Promise.all(input.targets.slice(index, index + 4).map(async selected => {
          const identity = releasePull(selected.url)
          if (!identity || !readerRepositories.includes(identity.repository as typeof readerRepositories[number]) || !installed.grant.repositories.includes(identity.repository)) throw new Error('Target outside installed repository scope')
          const snapshot = await this.read(identity.url)
          if (snapshot.head !== selected.head || snapshot.base !== selected.base || selected.baseHead && selected.baseHead !== snapshot.baseHead) throw new Error('Selected head/base changed; refresh before invocation')
          return snapshot
        })))
        return ok(res, { runId: await this.executor.start({ key: input.key, actor: login, installed, targets, mode: input.mode, view: input.view, repair: input.repair as Extract<NonNullable<typeof input.repair>, { kind: 'repair.update' | 'repair.rerun' }> | undefined }), simulated: true, actualGitHubWrites: 0 }, { headers })
      }
      if (req.method === 'POST' && url.pathname === '/api/actions/cancel') {
        const input = z.object({ runId: z.string().uuid() }).strict().parse(await body(req))
        await this.executor.cancel(input.runId, login); return ok(res, { cancelled: true }, { headers })
      }
      return fail(res, 'NOT_FOUND', 'Unknown local action route; live execution is not implemented', { headers })
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return fail(res, 'BAD_REQUEST', 'Invalid action payload', { headers })
      return fail(res, 'CONFLICT', error instanceof Error ? error.message : 'Action unavailable', { headers })
    }
  }
}
