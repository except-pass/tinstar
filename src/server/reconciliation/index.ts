import { releaseAssociations } from '../../shared/releases'
import { ReviewDeploymentAudit } from './reviewDeployment'
import { AssociationStore } from '../releases/associations'
import { reviewView } from './reviews'
import type { ReviewQueueRead } from '../../shared/reviews'
import { AskStore } from '../ask/store'
import { ProposalSource } from './proposalSource'
import { WorkflowContent } from './workflowContent'
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
import { externalWorkers, searchWorkSchema, getWorkSchema, type SubmitHandoffInput, type StartWorkInput, type UpdateWorkInput, type CreateWorkInput } from '../../shared/workflow'
import { searchSeeds, directNeighbors } from '../../shared/smartSearch'
import { workHealth } from '../../shared/workHealth'
import { workReadback } from './workReadback'
import { executionWarnings } from './workflowViews'
import { needsWill } from './needsWill'
import type { DecisionResolution } from './decisionResolution'
import { inventoryPullState, type PullsRead } from '../../shared/pulls'
import type { PullReadiness } from './queuePulls'
import { notionReleaseTransport } from '../releases/writer'

export type SourceSnapshot = Omit<Awaited<ReturnType<ReconciliationSources['snapshot']>>, 'diagnostics'>
export type CheckInSnapshot = SourceSnapshot & { checkIns?: SourceSnapshot['intentions'] }

/** Shared source collection, projection and policy-aware workflow operations. */
export class ReconciliationSources {
  reconcileReviewHandoffs?: (force?: boolean) => Promise<void>
  readonly reviewAudit: ReviewDeploymentAudit
  releaseDesk?: () => Promise<import('./queue').QueueItem[]>
  authorizePulls?: (req?: IncomingMessage) => Promise<boolean>
  readPulls?: (req?: IncomingMessage) => Promise<PullsRead | null>
  readPullReadiness?: (urls: string[]) => Promise<Map<string, PullReadiness>>
  onWorkRefresh?: (cards: WorkCard[]) => Promise<void>
  checkInIndicators?: () => Promise<Map<string, NonNullable<SceneCard['checkInRequest']>>>
  private associations: AssociationStore
  private fleet
  private workReader
  readonly askStore
  readonly proposalSource
  readonly workflow
  readonly notionApi
  private context
  private reconciler = new SceneReconciler()
  private queuePulls = new QueuePullReader()
  private search = new SearchDocumentCollector((id, revision) => this.context.get(id, revision))
  // Owner-authorized PR evidence must never enter an anonymous display response.
  private queueDisplays = new Map<boolean, { value?: ReturnType<typeof buildQueue>; pending?: Promise<void>; until: number; again: boolean; failed?: boolean }>()

  constructor(private readonly config: ReconciliationConfig = loadReconciliationConfig(), fetcher: typeof fetch = fetch, api?: NotionApi, receiptRoot = getConfigRoot()) {
    this.notionApi = api ?? new NotionApi(fetcher)
    this.workReader = new WorkReader(config.notion, this.notionApi)
    this.associations = new AssociationStore(receiptRoot)
    this.askStore = new AskStore(receiptRoot)
    const content = new WorkflowContent(this.workReader)
    this.proposalSource = new ProposalSource(this.askStore, async id => [...await content.notes(id), ...await content.sections(id)])
    this.workflow = new WorkflowOperations(this.workReader, () => this.fleetSnapshot(true), receiptRoot, this.proposalSource)
    this.reviewAudit = new ReviewDeploymentAudit(receiptRoot)
    this.workflow.validateReview = async input => this.reviewAudit.validate(input, await this.scene(true), this.associations)
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
    // Scene refreshes read source properties only. Awaiting per-card comments
    // here makes a large board exceed the source deadline. Comment updates use
    // the existing rotating sweep and targeted search_work/get_work refreshes.
    return {
      generatedAt: new Date().toISOString(), scope: 'configured-homes-only',
      warnings: [...this.config.warnings, ...(!fleet.length ? ['No First Mate homes configured; fleet coverage is unknown'] : [])],
      // Earlier batches can age while a later home consumes its timeout.
      fleet, intentions: ageObservation(intentions), diagnostics: { notion: this.notionApi.diagnostics },
    }
  }

  private knownSnapshot(): SourceSnapshot {
    return { generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings,
      intentions: this.workReader.declarations(),
      fleet: this.fleet.map(({ source, observation }) => ({ source: { ...source, machineBasis: source.machine ? 'configured' : 'unknown' },
        observation: observation.peek() ?? { status: 'unknown', coverage: 'unknown', data: null, observedAt: null,
          attemptedAt: new Date().toISOString(), expiresAt: null, error: 'Fleet source refresh pending' } })) }
  }

  /** The same queue, progressively displayed from known sources. Operational
   * reconciliation remains shared in the background; selections still use the
   * existing fresh, request-scoped queue and writer validation. */
  async queueDisplay(req?: IncomingMessage, force = false) {
    const authorized = !!await this.authorizePulls?.(req)
    let cached = this.queueDisplays.get(authorized)
    if (!cached) { cached = { until: 0, again: false }; this.queueDisplays.set(authorized, cached) }
    const entry = cached
    if (force) { entry.until = 0; if (entry.pending) entry.again = true }
    if (!entry.pending && Date.now() >= entry.until) {
      entry.failed = false
      entry.pending = this.queue(req).then(value => { entry.value = value }, () => { entry.failed = true }).finally(() => {
        entry.pending = undefined
        entry.until = entry.again ? 0 : Date.now() + 20_000
        entry.again = false
      })
    }
    if (!entry.pending && !entry.failed && entry.value) return { ...entry.value, refreshing: false }

    // Start the normal cached property/fleet reads, but never make list delivery
    // wait for a slow source or for per-card history/reconciliation.
    void this.snapshot().catch(() => {})
    const snapshot = this.knownSnapshot(), scene = this.reconciler.project(snapshot)
    const queue = buildQueue(snapshot)
    queue.readOnly = false // The shared refresh can finalize an already-recorded answer.
    const contexts = new Map(queue.items.flatMap(item => item.cardIds).flatMap(id => {
      const context = this.context.cachedComments(id)
      return context ? [[id, context] as const] : []
    }))
    const known = needsWill(queue, scene, contexts, null, new Map(), authorized)
    const prior = new Map((entry.value?.needsWill ?? []).map(item => [item.id, item]))
    const warning = entry.failed ? 'Request evidence could not refresh. Last-known requests remain visible; verify sources before choosing.'
      : 'Refreshing request evidence. Known requests remain visible; choices need verification until refresh completes.'
    // An unfinished read cannot establish that a retained request disappeared.
    const rows = new Map([...prior])
    for (const item of known) rows.set(item.id, { ...prior.get(item.id), ...item,
      proposal: prior.get(item.id)?.proposal ?? item.proposal,
      proposals: prior.get(item.id)?.proposals ?? item.proposals,
      currentProposalAnswerId: prior.get(item.id)?.currentProposalAnswerId ?? item.currentProposalAnswerId })
    queue.needsWill = [...rows.values()].map(item => ({ ...item, oneTouch: false, proposalHistoryComplete: false,
      readiness: item.readiness === 'future-or-conditional' ? item.readiness : 'needs-readiness-verification',
      reasons: [...new Set([...item.reasons, warning])] }))
    const projected = new Map(queue.needsWill.map(item => [item.id, item]))
    queue.items = [...queue.items.map(item => projected.get(item.id) ?? { ...item, oneTouch: false }),
      ...queue.needsWill.filter(item => !queue.items.some(current => current.id === item.id))]
    queue.counts = Object.fromEntries(['ready-now', 'needs-readiness-verification', 'future-or-conditional'].map(readiness => [readiness, queue.items.filter(item => item.readiness === readiness).length]))
    queue.warnings.push(warning)
    if (!authorized) queue.warnings.push('PR details require owner authorization')
    queue.operationalExceptions = executionWarnings(scene)
    return workReadback({ ...queue, refreshing: !!entry.pending })
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
  releaseTransport() { return notionReleaseTransport(this.workReader) }
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
      let [card, fleet] = await Promise.all([this.workReader.card(args.card_id, args.refresh), this.fleetSnapshot(args.refresh)])
      if (args.refresh) {
        this.context.invalidate(args.card_id)
        await this.onWorkRefresh?.([card])
        await this.workflow.reconcileDecisions(card.id, fleet)
        card = await this.workReader.card(card.id, true)
      }
      const intentions = { status: 'fresh' as const, coverage: 'complete' as const, data: { dataSourceId: this.config.notion!.dataSourceId, schema: {}, cards: [card], hasMore: false, truncatedRelations: [], missingSchemaProperties: [], scope: 'exact configured-board card' },
        observedAt: this.workReader.lastKnown(card.id)!.observedAt, attemptedAt: new Date().toISOString(), expiresAt: new Date(Date.parse(this.workReader.lastKnown(card.id)!.observedAt) + 120_000).toISOString(), error: null }
      const scene = this.reconciler.project({ generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings, intentions, fleet })
      const context = args.details ? await this.context.details(card.id) : undefined
      const review = reviewView(intentions, new Map(context && (context.commentsOutcome ?? context.outcome) === 'available' ? [[card.id, context.blocks]] : [])).items[0] ?? null
      const result = workReadback({ review, outcome: 'available', scope: { card_id: card.id, source: 'configured-board exact-card read' }, ...this.workRecord(scene, card.id), coverage: scene.coverage,
        ...(context ? { context } : {}) })
      // Explicit full-contract retrieval preserves bytes; routine reads remain bounded.
      return { ...result, implementation_contract: args.implementation_contract
        ? await this.workflow.readImplementationContract(card.id, args.implementation_contract)
        : { outcome: 'not-requested', complete_response: false, reader: 'get_work with implementation_contract {offset,limit,revision?}; concatenate exact chunks and verify manifest hash' } }
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
  async submitHandoff(input: SubmitHandoffInput, actor: string) {
    const result = await this.workflow.submitHandoff(input, actor)
    if ('record' in result && 'card_id' in result.record && typeof result.record.card_id === 'string') this.context.invalidate(result.record.card_id)
    return workReadback(result)
  }
  async firstmateWork(force = false) {
    return this.workReader.query({ owner: 'Firstmate', statuses: ['Queued', 'In Progress', 'Waiting For'] }, force)
  }
  async updateComments(id: string, force = false) { return this.context.commentDetails(id, force) }
  async updateContext(id: string) { return this.context.details(id, true) }

  async workerLinkReport() { return buildWorkerLinkReport(await this.snapshot()) }

  /** Same canonical census/projection as get_work_views, without operational
   * reconciliation, PR readiness or network history reads on the display path. */
  async reviews(force = false): Promise<ReviewQueueRead> {
    const intentions = await this.workReader.query({}, force)
    const notes = new Map<string, Array<{ text: string }>>()
    for (const item of reviewView(intentions).items) {
      const context = this.context.cachedComments(item.cardId)
      if (context?.outcome === 'available') notes.set(item.cardId, context.blocks)
    }
    const warnings: string[] = []
    const reviews = reviewView(intentions, notes)
    try {
      void this.fleetSnapshot().catch(() => {})
      const fleet = this.fleet.map(({ source, observation }) => ({
        source: { ...source, machineBasis: source.machine ? 'configured' : 'unknown' },
        observation: observation.peek() ?? { status: 'unknown' as const, coverage: 'unknown' as const, data: null,
          observedAt: null, attemptedAt: new Date().toISOString(), expiresAt: null, error: 'Fleet association read pending' },
      }))
      const scene = this.reconciler.project({ generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings, intentions, fleet })
      const links = releaseAssociations(scene, await this.associations.read())
      if (!links.associationsComplete) warnings.push('Review PR association coverage is incomplete or stale; linked worker duplicates may remain until fleet evidence is available.')
      const saved = await this.workflow.savedReviewAssociations()
      for (const item of reviews.items) item.linkedPulls = [...new Set([
        ...links.pulls.filter(pull => pull.links.some(link => link.active && link.cardId === item.cardId)).map(pull => pull.url),
        ...saved.filter(link => link.cardId === item.cardId).map(link => link.pull),
      ])]
    } catch { warnings.push('Review PR associations are unavailable; duplicate coverage is unknown.') }
    try {
      if (await this.workflow.pendingReviewCount()) warnings.push('Some review writes remain unconfirmed; Firstmate must reconcile their saved receipts.')
      if ((await this.reviewAudit.exceptions()).length) warnings.push('Deployment review handoffs remain unresolved; Firstmate must inspect the deployment audit.')
    } catch { warnings.push('Review recovery evidence is unavailable; handoff completeness is unknown.') }
    return workReadback({ reviews, warnings })
  }

  async queue(req?: IncomingMessage, requestKey?: string, force = false) {
    let reviewWarning: string | null = null
    const reviewRecoveries = await this.workflow.reconcileReviews().catch(() => null)
    for (const recovered of reviewRecoveries ?? []) this.context.invalidate(recovered.cardId)
    try { await this.reconcileReviewHandoffs?.(!!req && new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1') } catch { reviewWarning = 'Review handoff audit/reconciliation unavailable; retained handoffs remain unconfirmed.' }
    const authorized = !!await this.authorizePulls?.(req)
    const [snapshot, pullRead] = await Promise.all([this.snapshot(force), authorized ? this.readPulls?.(req).catch(() => null) : null])
    const candidates = buildQueue(snapshot, new Map(), Date.now(), pullRead ?? null)
    const urls = candidates.items.filter(item => (!requestKey || item.id === requestKey) && item.kind === 'merge')
      .flatMap(item => item.evidence.filter(link => link.kind === 'pull-request').map(link => link.url))
    const readableUrls = urls.filter(url => !pullRead || inventoryPullState(url, pullRead) === 'open')
    const states = authorized ? await (this.readPullReadiness?.(readableUrls) ?? this.queuePulls.get(readableUrls)) : new Map<string, PullReadiness>()
    if (authorized && pullRead) for (const url of urls) if (inventoryPullState(url, pullRead) === 'unverified') {
      states.set(url, { status: 'unknown', state: 'unknown', observedAt: null, expiresAt: null, head: null, draft: false, checks: 'unknown', mergeability: 'unknown' })
    }
    const queue = buildQueue(snapshot, states, Date.now(), pullRead ?? null)
    if (this.releaseDesk && snapshot.intentions.status === 'fresh' && snapshot.intentions.coverage === 'complete' && snapshot.intentions.data) {
      try { queue.items.push(...await this.releaseDesk()) }
      catch { queue.warnings.push('Release verification receipts unavailable; inspect Releases before concluding that no production checks remain.') }
      for (const readiness of Object.keys(queue.counts)) queue.counts[readiness] = queue.items.filter(item => item.readiness === readiness).length
    }
    // Ask resolves one exact queue request through this same projection. Avoid
    // rereading unrelated histories while the owner waits for a single turn.
    if (requestKey) queue.items = queue.items.filter(item => item.id === requestKey)
    queue.readOnly = false // Refresh can finish delivery of an already-recorded owner answer.
    // Detail reads are demand-only for this view, share the normal cache/limiter,
    // and are bounded independently of the property census. Unknown history is
    // disclosed; it never becomes a fabricated request age or answer.
    const deliveries = (await this.workflow.decisionDelivery?.messages().catch(() => []) ?? []).filter(message => !requestKey || (message.sourceAnchor ?? message.requestId) === requestKey || queue.items.some(item => item.cardIds.includes(message.decisionResolution?.cardId ?? '')))
    const ids = [...new Set([...deliveries.flatMap(message => message.decisionResolution ? [message.decisionResolution.cardId] : []), ...queue.items.flatMap(item => item.cardIds)])]
    const resolutions = new Map<string, DecisionResolution>()
    const resolutionIds = new Set([...deliveries.flatMap(message => message.decisionResolution ? [message.decisionResolution.cardId] : []), ...queue.items.filter(item => item.sources.some(source => source.kind === 'firstmate')).flatMap(item => item.cardIds)])
    for (const id of ids.filter(id => resolutionIds.has(id)).slice(0, 20)) {
      try {
        const resolution = await this.workflow.reconcileDecisions(id, snapshot.fleet, false)
        if (resolution) resolutions.set(id, resolution)
      } catch { resolutions.set(id, { state: 'verification-needed', message: 'Decision reconciliation needs verification: current Notion history unavailable' }) }
    }
    for (const item of queue.items) for (const id of item.cardIds) {
      const summary = resolutions.get(id)
      const resolution = summary?.requests?.find(result => item.sources.some(source => source.responseAnchor === result.source_anchor || source.id === result.source_anchor)) ?? (!summary?.requests ? summary : undefined)
      if (resolution) { item.decisionResolution = resolution; if (resolution.state !== 'resolved') { item.oneTouch = false; item.readiness = 'needs-readiness-verification' } }
    }
    // Keep an in-flight answer visible even if its source closes before its
    // delivery acknowledgment arrives. Unrelated asks on that card survive.
    for (const message of deliveries) {
      const resolution = message.decisionResolution
      if (!resolution || resolutions.get(resolution.cardId)?.state === 'resolved' || queue.items.some(item => item.sources.some(source => source.responseAnchor === message.sourceAnchor))) continue
      queue.items.push({ id: message.sourceAnchor ?? message.requestId, title: `Decision ${resolution.requestId}`, action: null, kind: 'decision', readiness: 'needs-readiness-verification', reasons: [],
        cardIds: [resolution.cardId], executionIds: [], homeIds: [message.home], decisionKeys: [resolution.requestId], checkpoint: null, oneTouch: false,
        decisionResolution: resolutions.get(resolution.cardId)?.requests?.find(result => result.request_id === resolution.requestId) ?? resolutions.get(resolution.cardId) ?? { state: 'pending', message: 'Decision recorded · First Mate not yet updated' },
        evidence: [{ kind: 'card', url: `https://www.notion.so/${resolution.cardId}` }], sources: [] })
    }
    if (requestKey) queue.items = queue.items.filter(item => item.id === requestKey)
    const contexts = new Map<string, Awaited<ReturnType<CardContextReader['commentDetails']>>>()
    for (let offset = 0; offset < Math.min(ids.length, 20); offset += 4) await Promise.all(ids.slice(offset, Math.min(offset + 4, 20)).map(async id => {
      contexts.set(id, await this.context.commentDetails(id, force))
    }))
    if (ids.length > 20) queue.warnings.push(`Request history inspected for 20 of ${ids.length} candidate cards. Remaining request ages/answer history are unknown; use get_work for exact context.`)
    if ([...contexts.values()].some(context => context.outcome !== 'available')) queue.warnings.push('Some request history is unavailable or partial; retained property asks require verification and their ages may be unknown.')
    const scene = this.reconciler.project(snapshot)
    const reviewNotes = new Map<string, Array<{ text: string }>>()
    for (const item of queue.reviews.items.slice(0, 20)) {
      const context = contexts.get(item.cardId) ?? await this.context.commentDetails(item.cardId)
      if (context.outcome === 'available') reviewNotes.set(item.cardId, context.blocks)
    }
    queue.reviews = reviewView(snapshot.intentions, reviewNotes)
    try { queue.reviewExceptions = await this.reviewAudit.exceptions() } catch { reviewWarning = 'Review handoff audit could not be read; exception coverage is unknown.' }
    if (!reviewRecoveries || reviewRecoveries.some(row => row.result.outcome !== 'saved')) queue.warnings.push('Some recorded review writes remain unconfirmed; inspect the existing review receipts before claiming acceptance or handoff completion.')
    queue.reviewRecoveries = reviewRecoveries ?? []
    if (reviewWarning) queue.warnings.push(reviewWarning)
    const histories = new Map(ids.map(id => [id, contexts.get(id)?.blocks ?? []]))
    const publications = (await Promise.all(queue.items.map(item => this.proposalSource.forRequest(item.id, item.cardIds, histories)))).flat()
    queue.needsWill = needsWill(queue, scene, contexts, pullRead ?? null, states, authorized, publications)
    const projected = new Map(queue.needsWill.map(item => [item.id, item]))
    queue.items = queue.items.map(item => projected.get(item.id) ?? item)
    queue.counts = Object.fromEntries(['ready-now', 'needs-readiness-verification', 'future-or-conditional'].map(readiness => [readiness, queue.items.filter(item => item.readiness === readiness).length]))
    queue.operationalExceptions = executionWarnings(scene)
    if (pullRead) queue.pullCoverage = { repositories: pullRead.repositories, warnings: pullRead.warnings, associationsComplete: pullRead.associationsComplete }
    else if (!authorized) queue.warnings.push('PR details require owner authorization')
    else queue.warnings.push('PR state unverified: inventory unavailable; explicit asks are retained without a verified waiting-on-merge conclusion.')
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
  if (path === '/api/reconciliation/queue' && new URL(req.url!, 'http://localhost').searchParams.get('view') === 'reviews') {
    return ok(res, await sources.reviews(new URL(req.url!, 'http://localhost').searchParams.get('refresh') === '1'), { headers })
  }
  if (path === '/api/reconciliation/card-context') {
    const id = new URL(req.url!, 'http://localhost').searchParams.get('id')
    if (!id) return fail(res, 'NOT_FOUND', 'Unknown authorized card', { headers })
    try { await sources.currentCard(id) }
    catch { return fail(res, 'NOT_FOUND', 'Unknown authorized card', { headers }) }
    return ok(res, await sources.card(id), { headers })
  }
  return ok(res, path === '/api/reconciliation/queue' ? await sources.queueDisplay(req, new URL(req.url!, 'http://localhost').searchParams.get('refresh') === '1') : path === '/api/reconciliation/scene' ? await sources.scene(new URL(req.url!, 'http://localhost').searchParams.get('refresh') === '1', new URL(req.url!, 'http://localhost').searchParams.get('history') === '1' ? { history: true } : {}) : await sources.snapshot(), { headers })
}
