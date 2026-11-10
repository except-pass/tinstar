import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ReconciliationSources } from '../reconciliation'
import { activeReleaseLinks, registeredPulls, releaseAssociations, releasePull } from '../../shared/releases'
import { getConfigRoot } from '../configRoot'
import { AssociationStore } from '../releases/associations'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { resolveCorsHeaders } from '../api/cors'
import { ok, fail } from '../api/envelope'
import { PullReader } from './reader'
import { PullFilesReader } from './files'
import type { AskContext } from '../../shared/ask'
import { pullContext } from '../../shared/pullContext'
import { clawsonMergeSchema } from '../../shared/clawsonMerge'
import { prepareClawsonMerge } from './clawsonMerge'
import { actionBody } from '../actions/routes'
import type { WorkflowOperations } from '../reconciliation/workflow'
import { askConfigSchema } from '../ask/routes'

const repositorySchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/).transform(value => value.toLowerCase())
async function configuredRepositories(root: string): Promise<string[] | null> {
  try {
    const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    return config.prOperations?.repositories === undefined ? null : z.array(repositorySchema).parse(config.prOperations.repositories)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('PR repository configuration could not be read. Check prOperations.repositories in config.json.') }
}
/** PR projection and owner handoffs. Uses the shared Releases associations and workflow writer. */
export class PullsApi {
  constructor(private sources: Pick<ReconciliationSources, 'scene'> & { workflow?: WorkflowOperations }, private store = new AssociationStore(), private root = getConfigRoot(), private reader = new PullReader(), private files = new PullFilesReader(), private prepareMerge = prepareClawsonMerge) {}
  readiness(urls: string[]) { return this.reader.readinessFor(urls) }
  private async scope() {
    const scene = await this.sources.scene(), warnings: string[] = []
    let events: Awaited<ReturnType<AssociationStore['read']>> = [], auditAvailable = true
    try { events = await this.store.read() } catch { auditAvailable = false; warnings.push('Shared association audit unavailable. Card linkage is unknown.') }
    const associations = releaseAssociations(scene, events)
    const associated = [...associations.pulls.filter(pull => activeReleaseLinks(pull).length > 0), ...registeredPulls(scene)]
    const configured = await configuredRepositories(this.root)
    const all = [...new Set(configured ?? associated.map(pull => pull.repository))].sort()
    // A visible cap bounds per-request GitHub work, not the user's repository choices.
    const repositories = all.slice(0, 32)
    if (all.length > repositories.length) warnings.push(`Showing 32 of ${all.length} repositories. Set prOperations.repositories to choose the review scope.`)
    if (!repositories.length) warnings.push('No repositories selected. Add prOperations.repositories to Tin Star config.json or register an explicit PR in the shared sources.')
    return { scene, warnings, associations, auditAvailable, repositories, associated }
  }
  async read() {
    const { warnings, associations, auditAvailable, repositories, associated } = await this.scope()
    const identity = await this.reader.identity()
    const reads = await this.reader.inventory(repositories, { ...identity, associated })
    const links = new Map(associations.pulls.map(pull => [pull.id, pull.links]))
    return { associations: auditAvailable ? associations.pulls.filter(pull => activeReleaseLinks(pull).length > 0).map(({ id, repository, number, url, links }) => ({ id, repository, number, url, links })) : [], account: identity.account, authenticatedActor: identity.authenticatedActor, credentialProfile: identity.credentialProfile, pulls: reads.flatMap(read => read.pulls.map(pull => ({ ...pull, links: auditAvailable ? links.get(pull.id) ?? [] : [] }))),
      repositories: reads.map(read => read.coverage), warnings: [...warnings, ...(identity.authenticatedActor ? [`Authenticated as ${identity.authenticatedActor}; review author ${identity.account}. Repositories outside its verified installations are unavailable; no ambient-login fallback.`] : []), ...associations.warnings], associationsComplete: auditAvailable && associations.associationsComplete }
  }
  async origin(url: string) {
    const { repositories, associated, associations, auditAvailable } = await this.scope()
    const identity = releasePull(url)
    if (!identity || !repositories.includes(identity.repository)) throw new Error('PR unavailable in the current repository scope.')
    const user = await this.reader.identity()
    const pull = await this.reader.summary(identity.url)
    if (!(user.repositories ? user.repositories.includes(identity.repository) : user.owners.includes(identity.repository.split('/')[0]!)) && pull.author.toLowerCase() !== user.account && !associated.some(row => row.id === pull.id)) throw new Error('PR unavailable in the current authored or associated scope.')
    return { ...pull, links: auditAvailable ? associations.pulls.find(row => row.id === pull.id)?.links ?? [] : [] }
  }
  async relationships(id: string): Promise<AskContext['relationships']> {
    const { scene, associations, auditAvailable } = await this.scope()
    const context = pullContext(scene, { id, links: auditAvailable ? associations.pulls.find(row => row.id === id)?.links ?? [] : [] })
    return { complete: auditAvailable && associations.associationsComplete && context.contributors.every(worker => worker.freshness === 'fresh') && (!scene.coverage.intentions.expiresAt || Date.parse(scene.coverage.intentions.expiresAt) > Date.now()),
      cards: context.links.map(link => ({ card_id: link.cardId, sources: link.sources })),
      workers: context.contributors.map(worker => ({ execution_id: worker.id, home: worker.home, task: worker.task, attempt: worker.attempt,
        state: worker.state, freshness: worker.freshness, source: worker.source, observed_at: worker.observedAt, registered_head: worker.registeredHead,
        claims: worker.claims.map(claim => ({ claim_id: claim.id, card_id: claim.cardId, sources: claim.sources, basis: claim.basis, verification: claim.verification, state: claim.state })),
      })),
    }
  }
  async authorized(req?: IncomingMessage): Promise<boolean> {
    if (!req) return false
    let ownerLogins: string[] = []
    try {
      const config = JSON.parse(await readFile(join(this.root, 'config.json'), 'utf8'))
      ownerLogins = askConfigSchema.parse(config.ask).ownerLogins
    } catch { ownerLogins = [] }
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const login = req.headers['tailscale-user-login']
    return (peer === '::1' || peer.startsWith('127.')) && typeof login === 'string' && ownerLogins.includes(login)
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local')
    if (!['/api/pulls', '/api/pulls/detail', '/api/pulls/files', '/api/pulls/origin', '/api/pulls/clawson-merge'].includes(url.pathname)) return false
    const origin = req.headers.origin, allowlist = currentOriginAllowlist()
    const headers = { ...resolveCorsHeaders({ origin, allowlist }), 'Cache-Control': 'no-store', Vary: 'Tailscale-User-Login, Origin' }
    if (origin && !allowlist.includes(origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
    if (!await this.authorized(req)) return fail(res, 'FORBIDDEN', 'Authorized tailnet owner required for PR Operations.', { headers })
    try {
      if (url.pathname === '/api/pulls/clawson-merge') {
        if (req.method !== 'POST' || req.headers['x-tinstar-ui'] !== '1') return fail(res, 'BAD_REQUEST', 'Use the Send to Clawson button.', { headers })
        const input = clawsonMergeSchema.parse(await actionBody(req))
        if (new Set(input.targets.map(target => releasePull(target.url)?.id)).size !== input.targets.length) throw new Error('Select each PR once.')
        if (!this.sources.workflow) throw new Error('Card creation is unavailable.')
        const actor = req.headers['tailscale-user-login'] as string
        const result = await this.sources.workflow.createClawsonMerge(input, actor, async () => {
          // The same configured, owned/authored/associated scope used for PR reads.
          for (const target of input.targets) await this.origin(target.url)
          return this.prepareMerge(input, actor)
        })
        if (!result.card) return fail(res, 'CONFLICT', result.message, { headers, details: { code: result.code } })
        return ok(res, { url: z.object({ url: z.string().url() }).parse(result.card).url, message: result.outcome === 'saved' ? 'Sent to Clawson for admin merge.' : result.message }, { headers })
      }
      if (req.method !== 'GET') return fail(res, 'BAD_REQUEST', 'Use GET for PR reads.', { headers })
      if (url.pathname === '/api/pulls/origin') return ok(res, await this.origin(url.searchParams.get('url') ?? ''), { headers })
      if (url.pathname !== '/api/pulls') {
        const { repositories } = await this.scope()
        const identity = releasePull(url.searchParams.get('url') ?? ''), head = url.searchParams.get('head') ?? ''
        if (!identity || !repositories.includes(identity.repository) || !/^[a-f0-9]{40,64}$/.test(head)) return fail(res, 'BAD_REQUEST', 'Choose a PR in the current repository scope and its captured head.', { headers })
        return ok(res, url.pathname.endsWith('/files') ? await this.files.get(identity.url, head) : await this.reader.detail(identity.url, head), { headers })
      }
      return ok(res, await this.read(), { headers })
    } catch (error) {
      if (url.pathname !== '/api/pulls/clawson-merge') return fail(res, 'BACKEND_UNAVAILABLE', (error as Error).message, { headers })
      return fail(res, error instanceof z.ZodError || error instanceof SyntaxError ? 'BAD_REQUEST' : 'CONFLICT', error instanceof z.ZodError ? 'Choose between 1 and 10 PRs with their observed heads.' : (error as Error).message, { headers })
    }
  }
}
