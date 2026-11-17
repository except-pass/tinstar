import { CardLeases, CardLeaseError } from './cardLeases'
import { deferredDecisionCard, matchesClaimFilters, currentWillRequests, oldestOpenRequestSince, type ClaimFilters } from './claimPolicy'
import { PreparedSubmissions } from './preparedSubmissions'
import { PreparedReviews } from './preparedReviews'
import { DecisionPackets } from './decisionPackets'
import { decisionMeaning } from '../../shared/decisionPacket'
import { DecisionPreparation, readClavisValue, type PrepCandidate } from './decisionPrep'
import { cardSourceUrl } from '../../shared/workIdentity'
import { projectDecisionEvidence, projectPreparedSubmitEvidence } from './decisionEvidence'
import type { MainWaitRead } from '../../shared/waitingOnMain'
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
import { NotionCardReadError, type WorkScope } from './notion'
import type { SceneCard } from './scene'
import { ageObservation } from './observation'
import { CardContextReader } from './cardContext'
import { PreparationHistory } from './preparationHistory'
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
import { coverageFromObservation, waitingForException } from '../../shared/waitingForPolicy'
import { searchSeeds, directNeighbors } from '../../shared/smartSearch'
import { workHealth } from '../../shared/workHealth'
import { workReadback } from './workReadback'
import { executionWarnings } from './workflowViews'
import { needsWill } from './needsWill'
import { decisionRequests, projectDecisionHistory } from '../../shared/workflowRequests'
import { decisionHistory, reconcileDecision, type DecisionResolution } from './decisionResolution'
import { inventoryPullState, type PullsRead } from '../../shared/pulls'
import type { PullReadiness } from './queuePulls'
import { notionReleaseTransport } from '../releases/writer'

export type SourceSnapshot = Omit<Awaited<ReturnType<ReconciliationSources['snapshot']>>, 'diagnostics'>
export type CheckInSnapshot = SourceSnapshot & { checkIns?: SourceSnapshot['intentions'] }

/** Shared source collection, projection and policy-aware workflow operations. */
export class ReconciliationSources {
  waitingOnMain?: (snapshot: SourceSnapshot) => Promise<MainWaitRead>
  reconcileReviewHandoffs?: (force?: boolean) => Promise<void>
  readonly leases: CardLeases
  readonly decisionPackets: DecisionPackets
  readonly preparedReviews: PreparedReviews
  readonly preparation: DecisionPreparation
  readonly preparedSubmissions: PreparedSubmissions
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
  private preparationHistory
  private preparationProjection?: { snapshot: SourceSnapshot; queue: ReturnType<typeof buildQueue> }
  private preparationProperties = new Map<string, { status: 'fresh' | 'unknown'; coverage: 'complete' | 'unknown'; observedAt: string; expiresAt: string }>()
  private commentImports = new Map<string, { observation: string; pending: Promise<void> }>()
  private sourceWriteRecoveryPass?: Promise<void>
  private reconciler = new SceneReconciler()
  private queuePulls = new QueuePullReader()
  private search = new SearchDocumentCollector((id, revision) => this.context.get(id, revision))
  // Owner-authorized PR evidence must never enter an anonymous display response.
  private queueDisplays = new Map<boolean, { value?: ReturnType<typeof buildQueue>; pending?: Promise<void>; until: number; again: boolean; failed?: boolean }>()

  constructor(private readonly config: ReconciliationConfig = loadReconciliationConfig(), fetcher: typeof fetch = fetch, api?: NotionApi, receiptRoot = getConfigRoot(), preparationSecret = readClavisValue) {
    this.leases = new CardLeases(receiptRoot)
    this.decisionPackets = new DecisionPackets(this.leases)
    const decisionScope = config.notion?.dataSourceId.replace(/-/g, '').toLowerCase() ?? 'configured-board'
    this.preparedReviews = new PreparedReviews(this.decisionPackets, decisionScope, id => this.preparationEvidence(id), () => this.decisionQueue())
    this.preparation = new DecisionPreparation(this.decisionPackets, decisionScope, { candidates: cardId => this.preparationCandidates(cardId), renew: () => this.renewPreparedSources(), coverage: () => this.decisionQueue().coverage, diagnostics: () => this.preparationDiagnostics(),
      observeOpenRequest: async (cardId, requestId) => {
        const history = await this.context.observeDecisionHistory(cardId)
        if (history.outcome !== 'available' || history.commentsOutcome !== 'available') throw new Error('Complete decision history is unavailable.')
        const notes = history.blocks
        const publications = await this.proposalSource.read(cardId, notes)
        const request = projectDecisionHistory(notes, publications).requests.get(requestId)
        return !!request && request.effective && !request.answers.length && !request.verification && decisionHistory(notes, publications).some(row => row.id === requestId)
      },
    }, id => this.preparationEvidence(id), preparationSecret)
    this.preparedReviews.reportPreparation = () => this.preparation.status(true)
    this.preparedReviews.refreshEvidence = () => this.warmPreparationHistory()
    this.notionApi = api ?? new NotionApi(fetcher)
    this.workReader = new WorkReader(config.notion, this.notionApi, config.jira)
    this.workReader.leases = this.leases
    this.associations = new AssociationStore(receiptRoot)
    this.askStore = new AskStore(receiptRoot)
    const content = new WorkflowContent(this.workReader)
    this.proposalSource = new ProposalSource(this.askStore, async id => [...await content.notes(id), ...await content.sections(id)])
    this.workflow = new WorkflowOperations(this.workReader, () => this.fleetSnapshot(true), receiptRoot, this.proposalSource)
    this.preparedSubmissions = new PreparedSubmissions(this.preparedReviews, {
      observe: (input, actor) => this.workflow.observePreparedAnswer(input, actor),
      evidence: async (stored, original, desired) => {
        // Forced exact history and source observation on every submit, without
        // queue()/get_work reconciliation or research in the critical path.
        const [snapshot, blocks] = await Promise.all([this.snapshot(true), this.workflow.preparedHistory(stored.packet.binding.card_id)])
        return projectPreparedSubmitEvidence(snapshot, stored.packet.binding.card_id, blocks, original, desired, Date.now(), this.proposalSource.cachedPublications(stored.packet.binding.card_id, blocks))
      },
      write: (input, actor) => this.workflow.answerPrepared(input, actor),
      scheduleReconciliation: card => {
        this.preparationHistory.invalidate(card)
        // Existing bridge/receipt closure proceeds independently of desk next.
        void this.workflow.reconcileDecisions(card).catch(() => {})
      },
    })
    this.reviewAudit = new ReviewDeploymentAudit(receiptRoot)
    this.workflow.validateReview = async input => this.reviewAudit.validate(input, await this.scene(true), this.associations)
    this.context = new CardContextReader(config.notion, this.notionApi.backgroundFetch, this.workReader.jira)
    this.preparationHistory = new PreparationHistory(this.context, () => this.preparation.historyLoaded(), async id => {
      await this.importCommentPackets(id)
      await this.preparation.revalidate(id)
    }, async id => {
      const observedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 30_000).toISOString()
      try {
        const card = await this.workReader.card(id, true, true)
        this.workReader.confirm(card)
        this.preparationProperties.set(id, { status: 'fresh', coverage: 'complete', observedAt, expiresAt })
      } catch (error) {
        // Keep the original observation and deadline during transient renewal.
        // The queue bounds retention and reports the source failure separately.
        throw new Error(error instanceof NotionCardReadError ? error.message : 'Canonical card properties could not be refreshed.')
      }
    }, (id, until) => {
      const properties = this.preparationProperties.get(id)
      return !!properties && properties.status === 'fresh' && properties.coverage === 'complete' && !!properties.expiresAt && Date.parse(properties.expiresAt) > until
    })
    this.workflow.onRecordedChange = id => { this.preparationProjection = undefined; this.preparationHistory.invalidate(id); this.invalidateQueueDisplays() }
    this.leases.onChange = () => this.invalidateQueueDisplays()
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
    const [fleet, intentions] = await Promise.all([this.fleetSnapshot(force), this.workReader.query(scope, force), this.askStore.loadProposals()])
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

  /** Cached queue used by prepared review and preparation admission. No source writes. */
  private decisionQueue() {
    const snapshot = this.knownSnapshot(), queue = buildQueue(snapshot)
    const complete = queue.coverage.intentions.status === 'fresh' && queue.coverage.intentions.coverage === 'complete' && queue.coverage.fleet.length > 0 && queue.coverage.fleet.every(home => home.status === 'fresh' && home.coverage === 'complete')
    const cards = snapshot.intentions.data?.cards.filter(card => !deferredDecisionCard(card)) ?? []
    // Property coverage alone cannot prove there are no body/comment asks.
    // Absence is certified only when all active card histories are cached and
    // fresh as well; otherwise the empty response discloses unknown demand.
    const historiesComplete = cards.every(card => {
      const history = this.context.cachedDecisionHistory(card.id)
      return history?.context.outcome === 'available' && history.context.commentsOutcome === 'available' && Date.parse(history.expires_at) > Date.now()
    })
    const activeIds = new Set(cards.map(card => card.id))
    const activeItems = queue.items.filter(item => item.cardIds.some(id => activeIds.has(id)))
    const card_ids = [...new Set(activeItems.flatMap(item => item.cardIds).filter(id => activeIds.has(id)))]
    const publications = this.proposalSource.cachedAskPublications()
    const requestCount = !historiesComplete && activeItems.length ? activeItems.length
      : cards.reduce((sum, card) => {
        const notes = this.context.cachedDecisionHistory(card.id)?.context.blocks ?? []
        return sum + [...projectDecisionHistory(notes, publications).requests.values()].filter(request => request.effective && !request.answers.length).length
      }, 0)
    return { card_ids, history: card_ids.map(id => ({ ...this.preparationHistory.state(id),
      title: String(cards.find(card => card.id === id)?.properties.Name?.value ?? 'Decision card') })),
    coverage: complete ? 'complete' as const : 'unknown' as const, requests: complete && (requestCount > 0 || historiesComplete) ? requestCount : null }
  }

  /** Enqueue only; snapshot delivery and automatic admission never wait for
   * board-wide history. Original history freshness remains authoritative. */
  private async warmPreparationHistory() {
    const ids = this.decisionQueue().card_ids
    const priority = await this.preparation.priorityCards()
    this.preparationHistory.warm(ids, priority)
    await Promise.all(ids.map(id => this.importCommentPackets(id)))
  }

  private async renewPreparedSources() {
    const priority = await this.preparation.priorityCards()
    if (!priority.length) return
    // The existing five-second runner also renews published/in-flight sources
    // with admission off, so a closed Desk does not stop source maintenance.
    await this.snapshot()
    this.preparationHistory.warm([], priority)
  }

  private preparationDiagnostics() {
    const queue = this.decisionQueue()
    return { requests: queue.requests, source_failures: queue.card_ids.flatMap(card_id => {
      const evidence = this.preparationEvidence(card_id)
      const reasons = [...new Set([...evidence.reasons, ...evidence.requests.flatMap(request => request.answered ? [] : request.reasons)])]
      const state = this.preparationHistory.state(card_id)
      if (state.message) reasons.push(state.message)
      return reasons.length ? [{ card_id, reasons }] : []
    }) }
  }

  private importCommentPackets(cardId: string): Promise<void> {
    const history = this.context.cachedDecisionHistory(cardId)
    if (!history || history.context.outcome !== 'available' || history.context.commentsOutcome !== 'available' || Date.parse(history.expires_at) <= Date.now()) return Promise.resolve()
    const observation = decisionMeaning([history.observed_at, history.expires_at, this.preparationEvidence(cardId)])
    const previous = this.commentImports.get(cardId)
    if (previous?.observation === observation) return previous.pending
    const pending = this.preparation.importComments(cardId, history.context.blocks).catch(error => { this.commentImports.delete(cardId); throw error })
    this.commentImports.set(cardId, { observation, pending })
    return pending
  }

  private async preparationCandidates(cardId?: string) {
    if (cardId) {
      // A paced board sweep can outlive property/fleet freshness too. Only an
      // explicit Prepare now waits for source observations, then its own card.
      await this.snapshot()
      if (!this.decisionQueue().card_ids.includes(cardId)) return []
      await this.preparationHistory.read(cardId)
    } else {
      await this.snapshot()
      await this.warmPreparationHistory()
    }
    return this.prepCandidates(cardId)
  }

  /** Eligible-source facts for one preparation pass. Admission itself rechecks leases. */
  private prepCandidates(onlyCard?: string): PrepCandidate[] {
    const snapshot = this.knownSnapshot(), queue = this.decisionQueue()
    const held = this.leases.readStorage(db => new Set(queue.card_ids.filter(id => this.leases.activeInStorage(this.leases.rowInStorage(db, id)) || this.leases.reviewReservedInStorage(db, id))))
    const candidates: PrepCandidate[] = []
    let rank = 0
    for (const cardId of queue.card_ids) {
      if (onlyCard && cardId !== onlyCard) continue
      const card = snapshot.intentions.data?.cards.find(item => item.id === cardId)
      const evidence = this.preparationEvidence(cardId)
      for (const request of evidence.requests) candidates.push({
        rank: rank++, card_id: cardId, request_id: request.request_id ?? request.binding?.request_id ?? '', source_revision: request.binding?.source_revision ?? '',
        card_url: cardSourceUrl(cardId), card_status: card ? String(card.properties.Status?.value ?? '') : null,
        answered: request.answered, leased: held.has(cardId), reasons: [...evidence.reasons, ...request.reasons],
      })
    }
    return candidates
  }

  /** P1 evidence-only projection. Unlike queue()/getWork(refresh), this never
   * refreshes sources, reconciles receipts, or changes source work. */
  preparationEvidence(cardId: string) {
    // A display/admission batch projects many cards from the same known sources.
    // Share only that synchronous queue build, never history or validation TTLs.
    if (!this.preparationProjection) {
      const snapshot = this.knownSnapshot()
      this.preparationProjection = { snapshot, queue: buildQueue(snapshot) }
      queueMicrotask(() => { this.preparationProjection = undefined })
    }
    const { snapshot, queue } = this.preparationProjection
    const renewalUntil = this.preparationHistory.renewalUntil(cardId)
    const history = this.preparationHistory.evidenceHistory(cardId)
    const publications = this.proposalSource.cachedPublications(cardId, history?.context.blocks ?? [])
    const evidence = projectDecisionEvidence(snapshot, cardId, history, Date.now(), this.preparationProperties.get(cardId), queue, renewalUntil, publications)
    const known = this.workReader.lastKnown(cardId)?.card
    // An exact archived read removes the card from the active board census.
    if (!snapshot.intentions.data?.cards.some(card => card.id === cardId) && known && deferredDecisionCard(known)) evidence.deferred = true
    const state = this.preparationHistory.state(cardId)
    if (state.message && !renewalUntil) evidence.reasons.push(state.message)
    return evidence
  }

  invalidateQueueDisplays() {
    for (const entry of this.queueDisplays.values()) {
      entry.value = undefined
      entry.until = 0
      if (entry.pending) entry.again = true
    }
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
      entry.pending = this.queue(req).then(value => { if (!entry.again) entry.value = value }, () => { entry.failed = true }).finally(() => {
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
    const known = needsWill(queue, scene, contexts, null, new Map(), authorized, this.proposalSource.cachedAskPublications())
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

  async card(id: string) { return { ...workReadback(await this.cardDecisionContext(id)), lease: this.leases.status(id) } }

  private async cardDecisionContext(id: string) {
    const [context] = await Promise.all([this.context.details(id), this.askStore.loadProposals()])
    return { ...context, decisionRequests: decisionRequests(context.blocks, projectDecisionHistory(context.blocks, this.proposalSource.cachedAskPublications()).requests) }
  }

  /** The full board can be incomplete without silencing the independent
   * Firstmate-owned active-card census. No additional timer or writer. */
  async checkInSnapshot(force = false): Promise<CheckInSnapshot> {
    const [fleet, checkIns] = await Promise.all([this.fleetSnapshot(force), this.workReader.query({ owner: 'Firstmate', statuses: ['In Progress', 'Waiting For'] }, force)])
    return { generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings,
      fleet, intentions: ageObservation(this.workReader.declarations()), checkIns: ageObservation({ ...checkIns, data: checkIns.data ? { ...checkIns.data, cards: checkIns.data.cards.filter(card => !card.source?.synthetic) } : null }) }
  }

  sourceWriteRecovery() {
    const content = new WorkflowContent(this.workReader)
    return { list: () => this.leases.pendingWrites(), reconcile: (card: string, operation: string, actor: string, reason: string) => this.leases.reconcileWrite(card, operation, actor, reason, intent => content.reservationReadback(card, intent)) }
  }

  recoverSourceWrites() {
    const content = new WorkflowContent(this.workReader)
    return this.sourceWriteRecoveryPass ??= this.leases.recoverStaleWrites((card, intent) => content.reservationReadback(card, intent))
      .finally(() => { this.sourceWriteRecoveryPass = undefined })
  }

  async currentCard(id: string) { return this.workReader.card(id, true) }
  async willAskCensus() { return this.workReader.query({}) }
  mainWaitNotionConfig() { return this.config.notion }
  releaseTransport() { return notionReleaseTransport(this.workReader) }
  async currentCardContext(id: string) { return this.context.checkpoints(id) }

  async scene(force = false, scope: WorkScope = {}) {
    const snapshot = await this.snapshot(force, scope)
    const scene = this.reconciler.reconcile(snapshot)
    if (this.checkInIndicators) {
      const indicators = await this.checkInIndicators()
      for (const card of scene.cards) card.checkInRequest = indicators.get(card.id)
    }
    // Filtered tool reads must not close waits outside their requested scope.
    const filtered = Object.entries(scope).some(([key, value]) => key !== 'history' && value !== undefined)
    const waits = this.waitingOnMain ? await this.waitingOnMain(filtered ? await this.snapshot() : snapshot) : undefined
    return { ...scene, searchIndex: this.search.get(scene), ...(waits ? { waitingOnMain: waits } : {}) }
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
    const text = (name: string) => String(card?.source.properties[name]?.value ?? '')
    const waiting_for_exception = card ? waitingForException({
      cardId: card.id, status: text('Status'), type: text('Waiting For Type'), id: text('Waiting For ID'), waitingFor: text('Waiting For'),
      nextCheckIn: card.source.properties['Next check-in']?.value as { start?: string; time_zone?: string } | null,
      knownWork: scene.cards.map(item => ({ id: item.id, status: String(item.source.properties.Status?.value ?? ''), archived: item.source.archived, in_trash: item.source.in_trash })),
      observedAt: card.source.last_edited_time ?? null, coverage: coverageFromObservation(scene.coverage.intentions.status, scene.coverage.intentions.coverage),
    }) : null
    return workReadback({ card, links, waiting_for_exception, external_workers: externalWorkers(card?.source.properties['Delegated To']?.value), workers: scene.executions.filter(worker => links.some(link => link.executionId === worker.id)),
      findings: scene.findings.filter(finding => finding.cardIds.includes(id)), health: workHealth(scene, id, Date.now()),
      omissions: 'Allowlisted source metadata only; no raw terminal transcripts or secrets. Query pages and on-demand body/comment reads have explicit bounds.',
      pull_requests: [...new Set([...(card ? Object.values(card.source.properties).map(property => String(property.value ?? '')) : []),
        ...scene.executions.filter(worker => links.some(link => link.executionId === worker.id)).map(worker => String(worker.source.pr.url ?? ''))]
        .flatMap(value => value.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g) ?? []))] })
  }
  async getWork(input: unknown) {
    const args = getWorkSchema.parse(input)
    let reconciliationWarning: string | undefined
    try {
      let [card, fleet] = await Promise.all([this.workReader.card(args.card_id, args.refresh), this.fleetSnapshot(args.refresh)])
      if (args.refresh) {
        this.context.invalidate(args.card_id)
        try {
          await this.onWorkRefresh?.([card])
          await this.workflow.reconcileDecisions(card.id, fleet)
        } catch (error) {
          // A refresh may reconcile old receipts. Refusing that background
          // write must not refuse a current source read by another chat.
          if (!(error instanceof CardLeaseError)) throw error
          reconciliationWarning = error.message
        }
        card = await this.workReader.card(card.id, true)
      }
      const intentions = { status: 'fresh' as const, coverage: 'complete' as const, data: { dataSourceId: card.source?.collectionId ?? this.config.notion!.dataSourceId, schema: {}, cards: [card], hasMore: false, truncatedRelations: [], missingSchemaProperties: [], scope: 'exact configured-source card' },
        observedAt: this.workReader.lastKnown(card.id)!.observedAt, attemptedAt: new Date().toISOString(), expiresAt: new Date(Date.parse(this.workReader.lastKnown(card.id)!.observedAt) + 120_000).toISOString(), error: null }
      const scene = this.reconciler.project({ generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings, intentions, fleet })
      const context = args.details ? await this.cardDecisionContext(card.id) : undefined
      const review = reviewView(intentions, new Map(context && (context.commentsOutcome ?? context.outcome) === 'available' ? [[card.id, context.blocks]] : [])).items[0] ?? null
      const result = workReadback({ review, outcome: 'available', scope: { card_id: card.id, source: 'configured-board exact-card read' }, ...this.workRecord(scene, card.id), coverage: scene.coverage,
        ...(context ? { context } : {}) })
      // Explicit full-contract retrieval preserves bytes; routine reads remain bounded.
      return { ...result, lease: this.leases.status(card.id), ...(reconciliationWarning ? { warnings: [reconciliationWarning] } : {}), implementation_contract: args.implementation_contract
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
    return { ...workReadback(result), lease: this.leases.status(input.card_id) }
  }

  async updateWork(input: UpdateWorkInput, actor: string) {
    const result = await this.workflow.update(input, actor)
    if (result.outcome !== 'not-saved') this.context.invalidate(input.card_id)
    const released = input.kind === 'not_for_me' && result.outcome === 'saved' ? await this.leases.releaseCurrent(input.card_id, `Not for me: ${input.reason}`) : undefined
    return { ...workReadback(result), ...(released ? { lease_release: released } : {}), lease: this.leases.status(input.card_id) }
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

  /** Tool reads need a fresh census, not a board-wide write-recovery pass.
   * Reuse the display's shared refresh for recovery and review prose; exact
   * workflow writes still perform their own fresh source/lease checks. */
  async workViews() {
    const queue = await this.queue(undefined, undefined, true, 'read')
    // A fresh tool census can observe source closure outside this process.
    // Do not serve a pre-answer display or publish an older in-flight refresh.
    this.invalidateQueueDisplays()
    void this.queueDisplay().catch(() => {})
    return queue
  }

  /** A claim allocates a card; it must not await the board's comment history
   * or operational reconciliation. Exact active-card validation still happens
   * before allocation, and get_work remains the explicit prose reader. */
  async claimQueue(filters: ClaimFilters = {}) {
    const snapshot = await this.snapshot(), scene = this.reconciler.project(snapshot)
    const queue = buildQueue(snapshot)
    const ids = [...new Set(queue.items.flatMap(item => item.cardIds))]
    this.preparationHistory.warm(ids)
    const contexts = new Map(ids.flatMap(id => {
      const history = this.context.cachedDecisionHistory(id)
      const context = history && Date.parse(history.expires_at) > Date.now() ? history.context : this.context.cachedComments(id)
      return context ? [[id, context] as const] : []
    }))
    const publications = this.proposalSource.cachedAskPublications()
    for (const id of ids) {
      const card = snapshot.intentions.data?.cards.find(card => card.id === id), context = contexts.get(id)
      if (!card || context?.outcome !== 'available') continue
      const summary = await reconcileDecision(card, context.blocks,
        snapshot.fleet, undefined, undefined, await this.proposalSource.read(id, context.blocks), snapshot.intentions, 'observe')
      if (!summary) continue
      for (const item of queue.items.filter(item => item.cardIds.includes(id))) {
        const resolution = summary.requests?.find(result => item.sources.some(source => source.responseAnchor === result.source_anchor || source.id === result.source_anchor)) ?? (!summary.requests ? summary : undefined)
        if (resolution) {
          item.decisionResolution = resolution
          if (resolution.state !== 'resolved') { item.oneTouch = false; item.readiness = 'needs-readiness-verification' }
        }
      }
    }
    queue.needsWill = needsWill(queue, scene, contexts, null, new Map(), false, publications)
    // needsWill exposes open requests for the Desk. Claims also need cached
    // answers so a still-published property ask cannot resurrect one.
    for (const item of queue.needsWill) for (const id of item.cardIds) {
      const notes = contexts.get(id)?.blocks ?? this.context.cachedClaimBlocks(id)
      item.requests.push(...decisionRequests(notes, projectDecisionHistory(notes, publications).requests).filter(request => request.answered)
        .map(request => ({ ...request, cardId: id })))
    }
    const matching = new Set(queue.claimCards.filter(card => matchesClaimFilters(card, filters,
      oldestOpenRequestSince(currentWillRequests(contexts.get(card.id)?.blocks ?? [], card.properties['Will action']?.value, publications)))).map(card => card.id))
    queue.items = queue.items.filter(item => item.cardIds.some(id => matching.has(id)))
    queue.needsWill = queue.needsWill.filter(item => item.cardIds.some(id => matching.has(id)))
    queue.claimCards = queue.claimCards.filter(card => matching.has(card.id))
    if (filters.max_age_days !== undefined) queue.warnings.push('Max age uses recorded request history; cards with unknown request age are excluded. Refresh get_work_views to load request ages.')
    if (queue.needsWill.some(item => !item.proposalHistoryComplete)) queue.warnings.push('Complete cached publication history is unavailable for some claim candidates; bounded background history reads are scheduled.')
    queue.warnings.push('Claim selection uses cached history. Read get_work with details for the selected card before deciding; claims do not wait for history or reconcile answers.')
    return workReadback(queue)
  }

  async queue(req?: IncomingMessage, requestKey?: string, force = false, mode: 'reconcile' | 'read' = 'reconcile') {
    let reviewWarning: string | null = null
    const reviewRecoveries = mode === 'reconcile' ? await this.workflow.reconcileReviews().catch(() => null) : null
    for (const recovered of reviewRecoveries ?? []) this.context.invalidate(recovered.cardId)
    if (mode === 'reconcile') try { await this.reconcileReviewHandoffs?.(!!req && new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1') } catch { reviewWarning = 'Review handoff audit/reconciliation unavailable; retained handoffs remain unconfirmed.' }
    const authorized = !!await this.authorizePulls?.(req)
    const [snapshot, pullRead] = await Promise.all([this.snapshot(force || mode !== 'reconcile'), authorized ? this.readPulls?.(req).catch(() => null) : null])
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
    const collectedContexts = new Map<string, Awaited<ReturnType<CardContextReader['commentDetails']>>>()
    let contexts = collectedContexts
    const historyDeadline = mode === 'read' ? Date.now() + 10_000 : Infinity
    const readContexts = async () => {
      for (let offset = 0; offset < Math.min(ids.length, 20) && Date.now() < historyDeadline; offset += 4) {
        await Promise.all(ids.slice(offset, Math.min(offset + 4, 20)).map(async id => {
          collectedContexts.set(id, await this.context.commentDetails(id, force))
        }))
      }
    }
    if (mode === 'read') {
      // Twenty paced reads can outlive the connector deadline on a slow board.
      // Keep warming the shared cache, but freeze the evidence included in this
      // response after ten seconds. Unfinished histories stay explicitly unknown.
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([readContexts(), new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000) })]) }
      finally { clearTimeout(timer) }
      contexts = new Map(collectedContexts)
    }
    const resolutions = new Map<string, DecisionResolution>()
    const resolutionIds = new Set([...deliveries.flatMap(message => message.decisionResolution ? [message.decisionResolution.cardId] : []), ...queue.items.filter(item => item.sources.some(source => source.kind === 'firstmate')).flatMap(item => item.cardIds)])
    const census = this.workflow.decisionCensus()
    for (const id of ids.filter(id => resolutionIds.has(id)).slice(0, 20)) {
      try {
        const card = snapshot.intentions.data?.cards.find(card => card.id === id)
        // Observe already-read comments with the same binding policy, without
        // a delivery writer or repair pass. Pending answers must not regain
        // ready-now status just because recovery moved off this request path.
        const resolution = mode === 'reconcile' ? await this.workflow.reconcileDecisions(id, snapshot.fleet, false, census)
          : card && contexts.get(id)?.outcome === 'available' ? await reconcileDecision(card,
            contexts.get(id)!.blocks,
            snapshot.fleet, this.workflow.decisionDelivery, undefined, await this.proposalSource.read(id, contexts.get(id)!.blocks), snapshot.intentions, 'observe') : undefined
        if (resolution) resolutions.set(id, resolution)
        if (mode === 'reconcile' && resolution?.state === 'resolved') this.context.invalidate(id)
      } catch { resolutions.set(id, { state: 'verification-needed', message: 'Decision reconciliation needs verification: current Notion history unavailable' }) }
    }
    if (mode === 'read') for (const message of deliveries) {
      const id = message.decisionResolution?.cardId
      if (id && !resolutions.has(id)) resolutions.set(id, { state: 'pending', message: 'Decision recorded · First Mate not yet updated' })
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
    if (mode === 'reconcile') await readContexts()
    if (contexts.size < ids.length) queue.warnings.push(`Request history inspected for ${contexts.size} of ${ids.length} candidate cards. Remaining request ages/answer history are unknown; use get_work for exact context.${mode === 'read' && contexts.size < Math.min(ids.length, 20) ? ' Foreground history wait reached its ten-second budget; unfinished reads continue warming the cache in the background.' : ''}`)
    if ([...contexts.values()].some(context => context.outcome !== 'available')) queue.warnings.push('Some request history is unavailable or partial; retained property asks require verification and their ages may be unknown.')
    const scene = this.reconciler.project(snapshot)
    const reviewNotes = new Map<string, Array<{ text: string }>>()
    for (const item of queue.reviews.items.slice(0, 20)) {
      const context = contexts.get(item.cardId) ?? (mode === 'reconcile' ? await this.context.commentDetails(item.cardId) : this.context.cachedComments(item.cardId))
      if (context?.outcome === 'available') reviewNotes.set(item.cardId, context.blocks)
    }
    queue.reviews = reviewView(snapshot.intentions, reviewNotes)
    try { queue.reviewExceptions = await this.reviewAudit.exceptions() } catch { reviewWarning = 'Review handoff audit could not be read; exception coverage is unknown.' }
    if (!reviewRecoveries || reviewRecoveries.some(row => row.result.outcome !== 'saved')) queue.warnings.push('Some recorded review writes remain unconfirmed; inspect the existing review receipts before claiming acceptance or handoff completion.')
    queue.reviewRecoveries = reviewRecoveries ?? []
    if (reviewWarning) queue.warnings.push(reviewWarning)
    if (mode === 'read') queue.warnings.push('Operational review/decision reconciliation and uncached review submission history refresh in the background. Retained handoffs and deliveries remain unconfirmed; read the canonical card before acting on missing review evidence. Exact workflow writes still validate current sources and leases.')
    const publications = this.proposalSource.cachedAskPublications()
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
