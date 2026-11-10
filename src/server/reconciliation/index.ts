import type { IncomingMessage, ServerResponse } from 'node:http'
import { ok, fail } from '../api/envelope'
import { resolveCorsHeaders } from '../api/cors'
import { currentOriginAllowlist } from '../api/originAllowlist'
import { loadReconciliationConfig, type ReconciliationConfig, type FleetSource } from './config'
import { fleetObservation } from './fleet'
import { type WorkScope } from './notion'
import type { SceneCard } from './scene'
import { ageObservation } from './observation'
import { CardContextReader } from './cardContext'
import { SceneReconciler } from './scene'
import { buildQueue } from './queue'
import { QueuePullReader } from './queuePulls'
import { buildWorkerLinkReport } from './workerLinkReport'
import { SearchDocumentCollector } from './searchIndex'
import { NotionApi } from './notionApi'
import { WorkReader, type WorkCard } from './workReader'
import { getConfigRoot } from '../configRoot'
import { WorkflowOperations } from './workflow'
import { externalWorkers, searchWorkSchema, getWorkSchema, type StartWorkInput, type UpdateWorkInput, type CreateWorkInput } from '../../shared/workflow'
import { searchSeeds, directNeighbors } from '../../shared/smartSearch'
import { workHealth } from '../../shared/workHealth'
import { workReadback } from './workReadback'
import { executionWarnings } from './workflowViews'
import { needsWill } from './needsWill'
import { privatePeer } from './mcp'
import type { PullsRead } from '../../shared/pulls'
import type { PullReadiness } from './queuePulls'

export type SourceSnapshot = Omit<Awaited<ReturnType<ReconciliationSources['snapshot']>>, 'diagnostics'>
export type CheckInSnapshot = SourceSnapshot & { checkIns?: SourceSnapshot['intentions'] }

/** Shared source collection, projection and policy-aware workflow operations. */
export class ReconciliationSources {
  readPulls?: () => Promise<PullsRead>
  readPullReadiness?: (urls: string[]) => Promise<Map<string, PullReadiness>>
  onWorkRefresh?: (cards: WorkCard[]) => Promise<void>
  checkInIndicators?: () => Promise<Map<string, NonNullable<SceneCard['checkInRequest']>>>
  private fleet
  private workReader
  readonly workflow
  readonly notionApi
  private context
  private reconciler = new SceneReconciler()
  private queuePulls = new QueuePullReader()
  private search = new SearchDocumentCollector((id, revision) => this.context.get(id, revision))

  constructor(private readonly config: ReconciliationConfig = loadReconciliationConfig(), fetcher: typeof fetch = fetch, api?: NotionApi, receiptRoot = getConfigRoot()) {
    this.notionApi = api ?? new NotionApi(fetcher)
    this.workReader = new WorkReader(config.notion, this.notionApi)
    this.workflow = new WorkflowOperations(this.workReader, () => this.fleetSnapshot(true), receiptRoot)
    this.context = new CardContextReader(config.notion, this.notionApi.fetch)
    this.fleet = config.fleet.map(source => ({ source, observation: fleetObservation(source) }))
  }

  async fleetSnapshot(force = false) {
    // At most four local snapshot processes at once, even for a large farm.
    const homes: Array<{ source: FleetSource & { machineBasis: string }; observation: Awaited<ReturnType<ReturnType<typeof fleetObservation>['get']>> }> = []
    for (let offset = 0; offset < this.fleet.length; offset += 4) {
      homes.push(...await Promise.all(this.fleet.slice(offset, offset + 4).map(async ({ source, observation }) => ({
        source: { ...source, machineBasis: source.machine ? 'configured' : 'unknown' }, observation: await observation.get(force),
      }))))
    }
    return homes.map(row => ({ ...row, observation: ageObservation(row.observation) }))
  }

  async snapshot(force = false, scope: WorkScope = {}) {
    const [fleet, intentions] = await Promise.all([this.fleetSnapshot(force), this.workReader.query(scope, force)])
    if (force && intentions.status === 'fresh' && intentions.data) await this.onWorkRefresh?.(intentions.data.cards)
    return {
      generatedAt: new Date().toISOString(), scope: 'configured-homes-only',
      warnings: [...this.config.warnings, ...(!fleet.length ? ['No First Mate homes configured; fleet coverage is unknown'] : [])],
      // Earlier batches can age while a later home consumes its timeout.
      fleet, intentions: ageObservation(intentions), diagnostics: { notion: this.notionApi.diagnostics },
    }
  }

  async card(id: string) { return workReadback(await this.context.details(id)) }

  /** The full board can be incomplete without silencing the independent
   * Firstmate-owned active-card census. No additional timer or writer. */
  async checkInSnapshot(force = false): Promise<CheckInSnapshot> {
    const [fleet, checkIns] = await Promise.all([this.fleetSnapshot(force), this.workReader.query({ owner: 'Firstmate', statuses: ['In Progress', 'Waiting For'] }, force)])
    return { generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings,
      fleet, intentions: ageObservation(this.workReader.declarations()), checkIns: ageObservation(checkIns) }
  }

  async currentCard(id: string) { return this.workReader.card(id, true) }
  async currentCardContext(id: string) { return this.context.checkpoints(id) }

  async scene(force = false, scope: WorkScope = {}) {
    const scene = this.reconciler.reconcile(await this.snapshot(force, scope))
    if (this.checkInIndicators) {
      const indicators = await this.checkInIndicators()
      for (const card of scene.cards) card.checkInRequest = indicators.get(card.id)
    }
    return { ...scene, searchIndex: this.search.get(scene) }
  }


  async searchWork(input: unknown) {
    const args = searchWorkSchema.parse(input)
    const scope = { owner: args.owner, statuses: args.statuses, initiative: args.initiative, epic: args.epic, checkpoint_before: args.checkpoint_before, history: args.history }
    const [intentions, fleet] = await Promise.all([this.workReader.query(scope, args.refresh), this.fleetSnapshot(args.refresh)])
    const scene = this.reconciler.project({ generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings, intentions, fleet })
    const keys = directNeighbors(scene, searchSeeds(scene, { query: args.query, patterns: args.patterns, facets: [] }, Date.now()))
    const cards = scene.cards.filter(card => keys.has(`card:${card.id}`)).sort((a, b) => a.id.localeCompare(b.id))
    const page = cards.slice(args.offset, args.offset + args.limit)
    if (args.refresh && intentions.status === 'fresh') await this.onWorkRefresh?.(page.map(card => card.source))
    const filteredCards = new Set(cards.map(card => card.id)), links = [...scene.claims, ...scene.claimHistory]
    const cardScoped = !!(args.owner || args.statuses || args.initiative || args.epic || args.checkpoint_before || args.patterns.length)
    const workers = scene.executions.filter(worker => keys.has(`execution:${worker.id}`) &&
      (!cardScoped || links.some(link => link.executionId === worker.id && filteredCards.has(link.cardId))))
    return { scope, coverage: scene.coverage, warnings: scene.warnings, total: cards.length,
      next_offset: args.offset + args.limit < Math.max(cards.length, workers.length) ? args.offset + args.limit : null,
      worker_total: workers.length, workers: workReadback(workers.slice(args.offset, args.offset + args.limit).map(worker => ({ ...worker,
        links: links.filter(link => link.executionId === worker.id),
        relationship_scope: 'Observed links only; unlinked is not proof of no assignment' }))),
      records: page.map(card => this.workRecord(scene, card.id)), diagnostics: { notion: this.notionApi.diagnostics } }
  }
  private workRecord(scene: ReturnType<SceneReconciler['reconcile']>, id: string) {
    const card = scene.cards.find(card => card.id === id)
    const links = [...scene.claims, ...scene.claimHistory].filter(claim => claim.cardId === id)
    // Source readers already allowlist fields; redact likely credential literals
    // from ordinary properties/evidence as well as body and comments.
    return workReadback({ card, links, external_workers: externalWorkers(card?.source.properties['Delegated To']?.value), workers: scene.executions.filter(worker => links.some(link => link.executionId === worker.id)),
      findings: scene.findings.filter(finding => finding.cardIds.includes(id)), health: workHealth(scene, id, Date.now()),
      omissions: 'Allowlisted source metadata only; no raw terminal transcripts or secrets. Query pages and on-demand body/comment reads have explicit bounds.',
      pull_requests: [...new Set([...(card ? Object.values(card.source.properties).map(property => String(property.value ?? '')) : []),
        ...scene.executions.filter(worker => links.some(link => link.executionId === worker.id)).map(worker => String(worker.source.pr.url ?? ''))]
        .flatMap(value => value.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g) ?? []))] })
  }
  async getWork(input: unknown) {
    const args = getWorkSchema.parse(input)
    try {
      const [card, fleet] = await Promise.all([this.workReader.card(args.card_id, args.refresh), this.fleetSnapshot(args.refresh)])
      if (args.refresh) {
        this.context.invalidate(args.card_id)
        await this.onWorkRefresh?.([card])
      }
      const intentions = { status: 'fresh' as const, coverage: 'complete' as const, data: { dataSourceId: this.config.notion!.dataSourceId, schema: {}, cards: [card], hasMore: false, truncatedRelations: [], missingSchemaProperties: [], scope: 'exact configured-board card' },
        observedAt: this.workReader.lastKnown(card.id)!.observedAt, attemptedAt: new Date().toISOString(), expiresAt: new Date(Date.parse(this.workReader.lastKnown(card.id)!.observedAt) + 120_000).toISOString(), error: null }
      const scene = this.reconciler.project({ generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings, intentions, fleet })
      return workReadback({ outcome: 'available', scope: { card_id: card.id, source: 'configured-board exact-card read' }, ...this.workRecord(scene, card.id), coverage: scene.coverage,
        ...(args.details ? { context: await this.context.details(card.id) } : {}) })
    } catch {
      const known = this.workReader.lastKnown(args.card_id)
      return { outcome: known ? 'stale' : 'unavailable', ...(known ? { card: workReadback(known.card), observedAt: known.observedAt } : {}),
        message: 'Card source unavailable or outside configured board; last-known data only, no absence conclusion', coverage: 'unknown' }
    }
  }
  async startWork(input: StartWorkInput, actor: string) {
    const result = await this.workflow.start(input, actor)
    if (result.outcome !== 'not-saved') this.context.invalidate(input.card_id)
    return workReadback(result)
  }

  async updateWork(input: UpdateWorkInput, actor: string) {
    const result = await this.workflow.update(input, actor)
    if (result.outcome !== 'not-saved') this.context.invalidate(input.card_id)
    return workReadback(result)
  }
  async createWork(input: CreateWorkInput, actor: string) {
    return workReadback(await this.workflow.create(input, actor))
  }
  async firstmateWork(force = false) {
    return this.workReader.query({ owner: 'Firstmate', statuses: ['Queued', 'In Progress', 'Waiting For'] }, force)
  }
  async updateComments(id: string, force = false) { return this.context.commentDetails(id, force) }
  async updateContext(id: string) { return this.context.details(id, true) }

  async workerLinkReport() { return buildWorkerLinkReport(await this.snapshot()) }

  async queue() {
    const [snapshot, pullRead] = await Promise.all([this.snapshot(), this.readPulls?.().catch(() => null)])
    const candidates = buildQueue(snapshot)
    const urls = candidates.items.filter(item => item.kind === 'merge')
      .flatMap(item => item.evidence.filter(link => link.kind === 'pull-request').map(link => link.url))
    const states = await (this.readPullReadiness?.(urls) ?? this.queuePulls.get(urls))
    const queue = buildQueue(snapshot, states)
    // Detail reads are demand-only for this view, share the normal cache/limiter,
    // and are bounded independently of the property census. Unknown history is
    // disclosed; it never becomes a fabricated request age or answer.
    const ids = [...new Set(queue.items.flatMap(item => item.cardIds))]
    const contexts = new Map<string, Awaited<ReturnType<CardContextReader['commentDetails']>>>()
    for (let offset = 0; offset < Math.min(ids.length, 20); offset += 4) await Promise.all(ids.slice(offset, Math.min(offset + 4, 20)).map(async id => {
      contexts.set(id, await this.context.commentDetails(id))
    }))
    if (ids.length > 20) queue.warnings.push(`Request history inspected for 20 of ${ids.length} candidate cards. Remaining request ages/answer history are unknown; use get_work for exact context.`)
    if ([...contexts.values()].some(context => context.outcome !== 'available')) queue.warnings.push('Some request history is unavailable or partial; retained property asks require verification and their ages may be unknown.')
    const scene = this.reconciler.project(snapshot)
    queue.needsWill = needsWill(queue, scene, contexts, pullRead ?? null, states)
    queue.operationalExceptions = executionWarnings(scene)
    if (pullRead) queue.pullCoverage = { repositories: pullRead.repositories, warnings: pullRead.warnings, associationsComplete: pullRead.associationsComplete }
    else queue.warnings.push('PR inventory unavailable; explicit merge requests retain their evidence and readiness, inventory coverage is unknown.')
    return workReadback(queue)
  }
}

export async function handleReconciliationRequest(sources: ReconciliationSources, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  if (!['/api/reconciliation/sources', '/api/reconciliation/scene', '/api/reconciliation/queue', '/api/reconciliation/card-context'].includes(path)) return false
  const allowlist = currentOriginAllowlist()
  const headers = { ...resolveCorsHeaders({ origin: req.headers.origin, allowlist }), 'Cache-Control': 'no-store', 'Access-Control-Allow-Headers': 'Content-Type, X-Tinstar-UI' }
  if (req.headers.origin && !allowlist.includes(req.headers.origin)) return fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return true }
  if (req.method !== 'GET') return fail(res, 'BAD_REQUEST', 'Read-only endpoint; use GET', { headers })
  // The shared queue now includes private PR metadata. Use the same local UI
  // authority as workflow writes; MCP reaches it through its authenticated tool.
  if (path === '/api/reconciliation/queue' && (!privatePeer(req.socket.remoteAddress) || req.headers['x-tinstar-ui'] !== '1')) return fail(res, 'FORBIDDEN', 'Private UI handshake required; agents use get_work_views.', { headers })
  if (path === '/api/reconciliation/card-context') {
    const id = new URL(req.url!, 'http://localhost').searchParams.get('id')
    if (!id) return fail(res, 'NOT_FOUND', 'Unknown authorized card', { headers })
    try { await sources.currentCard(id) }
    catch { return fail(res, 'NOT_FOUND', 'Unknown authorized card', { headers }) }
    return ok(res, await sources.card(id), { headers })
  }
  return ok(res, path === '/api/reconciliation/queue' ? await sources.queue() : path === '/api/reconciliation/scene' ? await sources.scene(new URL(req.url!, 'http://localhost').searchParams.get('refresh') === '1', new URL(req.url!, 'http://localhost').searchParams.get('history') === '1' ? { history: true } : {}) : await sources.snapshot(), { headers })
}
