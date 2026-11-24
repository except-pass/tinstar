import { JiraWork } from './jiraWork'
import { CardLeases, CardLeaseError } from './cardLeases'
import { deferredDecisionCard } from './claimPolicy'
import { PreparedSubmissions } from './preparedSubmissions'
import { PreparedReviews } from './preparedReviews'
import { DecisionPackets } from './decisionPackets'
import { DecisionPreparation, PreparationCardExcluded, readClavisValue } from './decisionPrep'
import { cardSourceUrl } from '../../shared/workIdentity'
import { actionableDecisionCard, decisionCardSource, decisionPropertyRevision, prepBlocked } from './decisionEvidence'
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
import type { WorkScope } from './notion'
import type { SceneCard } from './scene'
import { ageObservation, retainMissing } from './observation'
import { CardContextReader, hasUnverifiedRetractions, type CardContextRead } from './cardContext'
import { SceneReconciler } from './scene'
import { buildQueue } from './queue'
import { QueuePullReader, queuePullReadBudget } from './queuePulls'
import { buildWorkerLinkReport } from './workerLinkReport'
import { SearchDocumentCollector } from './searchIndex'
import { NotionApi } from './notionApi'
import { WorkReader, type WorkCard } from './workReader'
import { getConfigRoot } from '../configRoot'
import { WorkflowOperations } from './workflow'
import { externalWorkers, searchWorkSchema, getWorkSchema, type SubmitHandoffInput, type StartWorkInput, type UpdateWorkInput } from '../../shared/workflow'
import { closedWorkBlocker, coverageFromObservation, waitingForIssues, waitingForWorkIds, waitState, type WorkBlocker } from '../../shared/waitingForPolicy'
import { searchSeeds, directNeighbors } from '../../shared/smartSearch'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import { workHealth } from '../../shared/workHealth'
import { workReadback } from './workReadback'
import { executionWarnings } from './workflowViews'
import { needsWill } from './needsWill'
import { reconcileDecision, type DecisionResolution } from './decisionResolution'
import { inventoryPullState, type PullsRead } from '../../shared/pulls'
import type { PullReadiness } from './queuePulls'
import { notionReleaseTransport } from '../releases/writer'
import { ownerCards, ownerReadyRequests, selectJiraMergeRequests, verifyOwnerMerges } from './ownerReady'
import type { OwnerReadyRead } from '../../shared/ownerReady'
import { releasePull } from '../../shared/pullIdentity'

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
  readPullReadiness?: (...args: Parameters<QueuePullReader['get']>) => Promise<Map<string, PullReadiness>>
  readOwnerInventory?: (repositories: ReadonlySet<string>, force: boolean, scene: FloorScene) => Promise<PullsRead>
  onWorkRefresh?: (cards: WorkCard[]) => Promise<void>
  checkInIndicators?: () => Promise<Map<string, NonNullable<SceneCard['checkInRequest']>>>
  private associations: AssociationStore
  private fleet
  private workReader
  readonly askStore
  readonly proposalSource
  readonly workflow
  readonly jiraWork?: JiraWork
  readonly notionApi
  private context
  private sourceWriteRecoveryPass?: Promise<void>
  private reconciler = new SceneReconciler()
  private queuePulls = new QueuePullReader()
  private ownerRecheck?: Promise<OwnerReadyRead>
  private ownerHistoryCursor?: string
  private ownerHistories = new Map<string, CardContextRead>()
  private search = new SearchDocumentCollector((id, revision) => this.context.get(id, revision))
  // Owner-authorized PR evidence must never enter an anonymous display response.
  private queueDisplays = new Map<boolean, { value?: ReturnType<typeof buildQueue>; pending?: Promise<void>; until: number; again: boolean; failed?: boolean }>()

  constructor(private readonly config: ReconciliationConfig = loadReconciliationConfig(), fetcher: typeof fetch = fetch, api?: NotionApi, receiptRoot = getConfigRoot(), preparationSecret = readClavisValue) {
    this.leases = new CardLeases(receiptRoot)
    this.notionApi = api ?? new NotionApi(fetcher)
    if (config.jiraWork) this.jiraWork = new JiraWork(config.jiraWork, receiptRoot, fetcher)
    this.workReader = new WorkReader(config.notion, this.notionApi, config.jira)
    this.workReader.leases = this.leases
    this.associations = new AssociationStore(receiptRoot)
    this.askStore = new AskStore(receiptRoot)
    const content = new WorkflowContent(this.workReader)
    this.proposalSource = new ProposalSource(this.askStore, async id => [...await content.notes(id), ...await content.sections(id)])
    this.workflow = new WorkflowOperations(this.workReader, () => this.fleetSnapshot(true), receiptRoot, this.proposalSource, this.jiraWork)
    this.context = new CardContextReader(config.notion, this.notionApi.backgroundFetch, this.workReader.jira)
    const decisionScope = config.notion?.dataSourceId.replace(/-/g, '').toLowerCase() ?? 'configured-board'
    this.decisionPackets = new DecisionPackets(this.leases, decisionScope)
    this.preparation = new DecisionPreparation(this.decisionPackets, {
      refreshQueue: async () => {
        await this.preparedSubmissions.completeSavedAnswers()
        await this.workReader.query({}, false, true)
        return this.decisionQueue().cards
      },
      read: (card, background, freshHistory, preparing) => this.readDecisionCard(card, background, freshHistory, preparing),
      exclusive: (card, perform) => this.workflow.exclusive(card, perform),
    }, preparationSecret, fetcher)
    this.preparedReviews = new PreparedReviews(this.decisionPackets, () => this.decisionQueue(), id => this.readDecisionCard(id, false), this.preparation)
    this.preparedSubmissions = new PreparedSubmissions(this.preparedReviews, (stored, selection, operation, answerer, canPost) =>
      this.workflow.recordDeskAnswer(stored.packet, selection, operation, () => this.loadDecisionCard(stored.packet.card_id, false), answerer, canPost))
    this.reviewAudit = new ReviewDeploymentAudit(receiptRoot)
    this.workflow.validateReview = async input => this.reviewAudit.validate(input, await this.scene(true), this.associations)
    this.workReader.onConfirmed = card => {
      this.decisionRevisionReads.delete(card.id)
      if (!this.observedDecisionRevision(card)) this.decisionRevisions.delete(card.id)
    }
    this.workflow.onRecordedChange = id => {
      this.decisionRevisionReads.delete(id)
      this.decisionRevisions.delete(id)
      this.context.invalidate(id)
      this.invalidateQueueDisplays()
    }
    this.workflow.onDecisionRetracted = async (id, auditTime) => {
      await this.decisionPackets.initialize()
      await this.leases.writeStorage(db => {
        const packet = this.decisionPackets.currentInStorage(db, id)
        if (packet && (!auditTime || Date.parse(packet.published_at) <= Date.parse(auditTime))) this.decisionPackets.invalidateInStorage(db, id)
      })
    }
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

  async snapshot(force = false, scope: WorkScope = {}, background = false) {
    const [fleet, intentions] = await Promise.all([this.fleetSnapshot(force), this.workReader.query(scope, force, background)])
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

  private decisionRevisionReads = new Map<string, symbol>()
  private decisionRevisions = new Map<string, { edited: string; properties: string; revision: string }>()

  private decisionQueue() {
    const observation = this.workReader.declarations()
    return { cards: (observation.data?.cards ?? []).filter(actionableDecisionCard).sort((a, b) => a.id.localeCompare(b.id)),
      coverage: observation.status === 'fresh' && observation.coverage === 'complete' ? 'complete' as const : 'unknown' as const,
      revisionFor: (card: WorkCard) => this.observedDecisionRevision(card),
    }
  }

  private observedDecisionRevision(card: WorkCard) {
    const observed = this.decisionRevisions.get(card.id)
    return observed?.edited === card.last_edited_time && observed.properties === decisionPropertyRevision(card)
      ? observed.revision : undefined
  }

  private async loadDecisionCard(id: string, background: boolean, freshHistory = false, preparing = false) {
    const observation = Symbol()
    this.decisionRevisionReads.set(id, observation)
    try {
      const signal = AbortSignal.timeout(background ? 60_000 : 20_000)
      const card = await this.workReader.card(id, true, background, signal)
      if (this.decisionRevisionReads.get(id) === observation) {
        this.workReader.confirm(card)
        this.decisionRevisionReads.set(id, observation)
      }
      if (preparing && prepBlocked(card)) throw new PreparationCardExcluded()
      const context = await this.context.decisionDetails(id, signal, background ? this.notionApi.backgroundFetch : this.notionApi.fetch, freshHistory)
      if (context.outcome !== 'available') throw new Error(context.omissions || 'Card content is unavailable')
      await this.context.verifyRetractions(context)
      const source = decisionCardSource(card, context.blocks)
      if (this.decisionRevisionReads.get(id) === observation) {
        this.decisionRevisions.set(id, { edited: card.last_edited_time, properties: source.propertyRevision, revision: source.revision })
      }
      return { card, blocks: context.blocks, source }
    } finally {
      if (this.decisionRevisionReads.get(id) === observation) this.decisionRevisionReads.delete(id)
    }
  }

  private async readDecisionCard(id: string, background: boolean, freshHistory = false, preparing = false) {
    await this.decisionPackets.initialize()
    const observedPacket = this.leases.readStorage(db => this.decisionPackets.currentInStorage(db, id))
    const { source } = await this.loadDecisionCard(id, background, freshHistory, preparing)
    // A slower background read may finish after a newer publication.
    if (observedPacket && observedPacket.packet.source_revision !== source.revision) {
      await this.leases.writeStorage(db => {
        if (this.decisionPackets.currentInStorage(db, id)?.id === observedPacket.id) this.decisionPackets.invalidateInStorage(db, id)
      })
    }
    return source
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
      entry.pending = this.queue(req, undefined, false, 'reconcile', authorized).then(value => { if (!entry.again) entry.value = value }, () => { entry.failed = true }).finally(() => {
        entry.pending = undefined
        entry.until = entry.again ? 0 : Date.now() + 20_000
        entry.again = false
      })
    }
    if (!entry.pending && !entry.failed && entry.value) return { ...entry.value, refreshing: false }

    // Start the normal cached property/fleet reads, but never make list delivery
    // wait for a slow source or for per-card history/reconciliation.
    void this.snapshot(false, {}, true).catch(() => {})
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
    const deferred = new Set(scene.cards.filter(card => deferredDecisionCard(card.source)).map(card => card.id))
    const rows = new Map([...prior].filter(([, item]) => !item.cardIds.length || !item.cardIds.every(id => deferred.has(id))))
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
    const ownerReady = entry.value?.ownerReady
    if (ownerReady) queue.ownerReady = {
      ...ownerReady, warnings: [...ownerReady.warnings, warning],
      repositories: ownerReady.repositories.map(group => ({
        ...group, decisions: group.decisions.map(decision => ({ ...decision, fresh: false })),
        merges: group.merges.map(merge => ({ ...merge, fresh: false,
          ...(merge.live?.state === 'ready' ? { live: { ...merge.live, state: 'unverified' as const } } : {}) })),
      })),
    }
    return workReadback({ ...queue, refreshing: !!entry.pending })
  }

  async card(id: string) {
    const context = await this.context.details(id, false, this.notionApi.parallelFetch)
    const answerSources = await this.context.retractionAnswerSources(context)
    return { ...workReadback({ ...context, ...(answerSources ? { answerSources } : {}) }), lease: this.leases.status(id) }
  }

  /** The full board can be incomplete without silencing the independent
   * Firstmate-owned active-card census. No additional timer or writer. */
  async checkInSnapshot(force = false): Promise<CheckInSnapshot> {
    const [fleet, checkIns] = await Promise.all([this.fleetSnapshot(force), this.workReader.query({ owner: 'Firstmate', statuses: ['In Progress', 'Waiting For'] }, force, true)])
    return { generatedAt: new Date().toISOString(), scope: 'configured-homes-only', warnings: this.config.warnings,
      fleet, intentions: ageObservation(this.workReader.declarations()), checkIns: ageObservation({ ...checkIns, data: checkIns.data ? { ...checkIns.data, cards: checkIns.data.cards.filter(card => !card.source?.synthetic) } : null }) }
  }

  sourceWriteRecovery() {
    const content = new WorkflowContent(this.workReader, this.jiraWork)
    return { list: () => this.leases.pendingWrites(), reconcile: (card: string, operation: string, actor: string, reason: string) => this.leases.reconcileWrite(card, operation, actor, reason, intent => content.reservationReadback(card, intent)) }
  }

  recoverSourceWrites() {
    const content = new WorkflowContent(this.workReader, this.jiraWork)
    return this.sourceWriteRecoveryPass ??= this.leases.recoverStaleWrites((card, intent) => content.reservationReadback(card, intent))
      .finally(() => { this.sourceWriteRecoveryPass = undefined })
  }

  async currentCard(id: string) { return this.workReader.card(id, true) }
  mainWaitNotionConfig() { return this.config.notion }
  releaseTransport() { return notionReleaseTransport(this.workReader) }
  async currentCardContext(id: string) { return this.context.checkpoints(id) }

  async scene(force = false, scope: WorkScope = {}, waitReferences?: 'exact' | 'cached'): Promise<FloorScene & { searchIndex: ReturnType<SearchDocumentCollector['get']> }> {
    const snapshot = await this.snapshot(force, scope)
    const scene = this.reconciler.reconcile(snapshot)
    if (this.checkInIndicators) {
      const indicators = await this.checkInIndicators()
      for (const card of scene.cards) card.checkInRequest = indicators.get(card.id)
    }
    // Filtered tool reads must not close waits outside their requested scope.
    const filtered = Object.entries(scope).some(([key, value]) => key !== 'history' && value !== undefined)
    const waits = this.waitingOnMain ? await this.waitingOnMain(filtered ? await this.snapshot() : snapshot) : undefined
    const work = waitReferences && await this.workReader.waitingForWork(scene.cards.map(card => waitState(card.source)),
      snapshot.intentions.status === 'stale' ? [] : scene.cards.map(card => card.source), { refresh: force, cachedOnly: waitReferences === 'cached' })
    return { ...scene, searchIndex: this.search.get(scene), ...(work && { waitingForWork: [...work.values()] }), ...(waits && { waitingOnMain: waits }) }

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
    const work = await this.workReader.waitingForWork(page.map(card => waitState(card.source)),
      intentions.status === 'stale' ? [] : scene.cards.map(card => card.source), { refresh: args.refresh })
    return { scope, coverage: scene.coverage, warnings: scene.warnings, total: cards.length,
      next_offset: args.offset + args.limit < Math.max(cards.length, workers.length) ? args.offset + args.limit : null,
      worker_total: workers.length, workers: workReadback(workers.slice(args.offset, args.offset + args.limit).map(worker => ({ ...worker,
        links: links.filter(link => link.executionId === worker.id),
        relationship_scope: 'Observed links only; unlinked is not proof of no assignment' }))),
      records: page.map(card => this.workRecord(scene, card, work)), diagnostics: { notion: this.notionApi.diagnostics } }
  }
  private workRecord(scene: ReturnType<SceneReconciler['reconcile']>, card: SceneCard, work: ReadonlyMap<string, WorkBlocker>) {
    const { id } = card
    const links = [...scene.claims, ...scene.claimHistory].filter(claim => claim.cardId === id)
    const state = waitState(card.source)
    const waiting_for_issues = waitingForIssues({ ...state, coverage: coverageFromObservation(scene.coverage.intentions.status, scene.coverage.intentions.coverage) }, work)
    const waiting_for_work = waitingForWorkIds(state).map(id => {
      const target = work.get(id)
      return target ? { ...target, state: closedWorkBlocker(target) ? 'closed' : 'resolved', url: cardSourceUrl(id) } : { id, state: 'unknown' }
    })
    // Source readers already allowlist fields; redact likely credential literals
    // from ordinary properties/evidence as well as body and comments.
    return workReadback({ card, links, waiting_for_exception: waiting_for_issues[0] ?? null, waiting_for_issues, waiting_for_work,
      external_workers: externalWorkers(card.source.properties['Delegated To']?.value), workers: scene.executions.filter(worker => links.some(link => link.executionId === worker.id)),
      findings: scene.findings.filter(finding => finding.cardIds.includes(id)), health: workHealth(scene, id, Date.now()),
      omissions: 'Allowlisted source metadata only; no raw terminal transcripts or secrets. Query pages and on-demand body/comment reads have explicit bounds.',
      pull_requests: [...new Set([...Object.values(card.source.properties).map(property => String(property.value ?? '')),
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
      const context = args.details ? await this.context.details(card.id, false, this.notionApi.parallelFetch) : undefined
      const review = reviewView(intentions, new Map(context && (context.commentsOutcome ?? context.outcome) === 'available' ? [[card.id, context.blocks]] : [])).items[0] ?? null
      const work = await this.workReader.waitingForWork([waitState(card)], [], { refresh: args.refresh })
      const result = workReadback({ review, outcome: 'available', scope: { card_id: card.id, source: 'configured-board exact-card read' }, ...this.workRecord(scene, scene.cards[0]!, work), coverage: scene.coverage,
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
  readImplementationContract(id: string, options: NonNullable<ReturnType<typeof getWorkSchema.parse>['implementation_contract']>) {
    return this.workflow.readImplementationContract(id, options)
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
  async updateContext(id: string, verifyRetractions = false) {
    const context = await this.context.details(id, true)
    return verifyRetractions ? this.context.verifyRetractions(context) : context
  }

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
    const queue = await this.queue(undefined, undefined, true, 'read', true)
    // A fresh tool census can observe source closure outside this process.
    // Do not serve a pre-answer display or publish an older in-flight refresh.
    this.invalidateQueueDisplays()
    void this.queueDisplay().catch(() => {})
    return queue
  }

  /** Callers establish the existing UI owner or MCP PR-read authority before
   * invoking this read-only path. Concurrent return requests share one pass. */
  ownerReadyWithPulls(recheck = false): Promise<OwnerReadyRead> {
    if (!recheck) return this.readOwnerReady(false)
    this.ownerRecheck ??= this.readOwnerReady(true).finally(() => { this.ownerRecheck = undefined })
    return this.ownerRecheck
  }

  private orderOwnerHistories(ids: string[]) {
    const start = ids.indexOf(this.ownerHistoryCursor ?? '') + 1
    return [...ids.slice(start), ...ids.slice(0, start)]
  }

  private projectOwnerReady(snapshot: SourceSnapshot, observed: ReadonlyMap<string, CardContextRead>, jira?: Awaited<ReturnType<JiraWork['ownerRequests']['get']>>) {
    const histories = new Map<string, CardContextRead>()
    for (const card of ownerCards(snapshot)) {
      const current = observed.get(card.id)
      const known = this.ownerHistories.get(card.id)
      const complete = current?.outcome === 'available' && !hasUnverifiedRetractions(current)
      const history = complete ? current : current || known ? {
        ...current, outcome: 'partial' as const,
        blocks: retainMissing(known?.blocks ?? [], current?.blocks ?? [], block => JSON.stringify([block.type, block.id])),
      } : undefined
      if (history) {
        histories.set(card.id, history)
        this.ownerHistories.set(card.id, history)
      }
    }
    return ownerReadyRequests(snapshot, histories, jira)
  }

  private async readOwnerReady(recheck: boolean) {
    const [snapshot, jira] = await Promise.all([this.snapshot(recheck), this.jiraWork?.ownerRequests.get(recheck)])
    const histories = new Map<string, Awaited<ReturnType<CardContextReader['commentDetails']>>>()
    const ids = this.orderOwnerHistories(ownerCards(snapshot).map(card => card.id)), deadline = Date.now() + 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const collect = async () => {
      for (let offset = 0; offset < ids.length && Date.now() < deadline; offset += 4) {
        const batch = ids.slice(offset, offset + 4)
        this.ownerHistoryCursor = batch.at(-1)
        await Promise.all(batch.map(async id => {
          const context = await this.context.commentDetails(id, recheck)
          histories.set(id, await this.context.verifyRetractions(context).catch(() => context))
        }))
      }
    }
    try { await Promise.race([collect(), new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000) })]) }
    finally { clearTimeout(timer) }
    const read = this.projectOwnerReady(snapshot, histories, jira)
    await this.enrichOwnerReady(read, recheck, this.reconciler.project(snapshot), jira)
    return workReadback(read)
  }

  private readOwnerMergeStates(merges: OwnerReadyRead['repositories'][number]['merges'], jira: Awaited<ReturnType<JiraWork['ownerRequests']['get']>> | undefined, inventory: PullsRead | null, force: boolean, readBudget: number) {
    const selected = selectJiraMergeRequests(jira)
    const expectedHeads = new Map<string, string | null>()
    for (const pull of inventory?.pulls ?? []) {
      const id = releasePull(pull.url)?.id
      const selection = id ? selected.get(id) : undefined
      if (pull.freshness === 'fresh' && selection && !selection.unverifiedRequest && selection.merge.head === pull.head) {
        expectedHeads.set(selection.merge.url, pull.head)
      }
    }
    if (force && inventory) {
      const listed = new Set(inventory.pulls.map(pull => pull.id))
      const closed = new Set(inventory.closedPulls)
      const scopes = new Map(inventory.repositories.map(repo => [repo.repository, repo.scope]))
      const associated = new Set(inventory.associations?.filter(pull => pull.links.some(link => link.active)).map(pull => pull.id))
      for (const merge of merges) {
        const pull = merge.url && releasePull(merge.url)
        if (pull && !listed.has(pull.id) && !closed.has(pull.id) &&
            (scopes.get(pull.repository) === 'all-open' || scopes.get(pull.repository) === 'authored-or-associated' && associated.has(pull.id))) expectedHeads.set(pull.url, null)
      }
    }
    const urls = [...expectedHeads.keys()]
    const options = { force, expectedHeads, readBudget }
    return urls.length
      ? (this.readPullReadiness?.(urls, options) ?? this.queuePulls.get(urls, options)).catch(() => new Map<string, PullReadiness>())
      : Promise.resolve(new Map<string, PullReadiness>())
  }

  private async enrichOwnerReady(read: OwnerReadyRead, recheck: boolean, scene: FloorScene, jira: Awaited<ReturnType<JiraWork['ownerRequests']['get']>> | undefined, knownInventory?: PullsRead | null, readBudget = queuePullReadBudget) {
    const merges = read.repositories.flatMap(group => group.merges)
    const repositories = new Set(merges.flatMap(ask => ask.url ? [releasePull(ask.url)!.repository] : []))
    const inventory = knownInventory ?? (repositories.size ? await this.readOwnerInventory?.(repositories, recheck, scene).catch(() => null) : null) ?? null
    const states = await this.readOwnerMergeStates(merges, jira, inventory, recheck, readBudget)
    verifyOwnerMerges(read, inventory, states)
    if (repositories.size && !inventory) read.warnings.push('GitHub inventory is unavailable. Current PR heads could not be verified.')
    if (recheck) read.recheckedAt = new Date().toISOString()
    return read
  }

  async queue(req?: IncomingMessage, requestKey?: string, force = false, mode: 'reconcile' | 'read' = 'reconcile', withOwnerReady = false) {
    let reviewWarning: string | null = null
    const reviewRecoveries = mode === 'reconcile' ? await this.workflow.reconcileReviews().catch(() => null) : null
    for (const recovered of reviewRecoveries ?? []) this.context.invalidate(recovered.cardId)
    if (mode === 'reconcile') try { await this.reconcileReviewHandoffs?.(!!req && new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1') } catch { reviewWarning = 'Review handoff audit/reconciliation unavailable; retained handoffs remain unconfirmed.' }
    const authorized = !!await this.authorizePulls?.(req)
    const jiraOwnerRead = withOwnerReady ? this.jiraWork?.ownerRequests.get(force) : undefined
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
    const ids = [...new Set([...deliveries.flatMap(message => message.decisionResolution ? [message.decisionResolution.cardId] : []), ...queue.items.flatMap(item => item.cardIds),
      ...(withOwnerReady ? ownerCards(snapshot).map(card => card.id) : [])])]
    const historyIds = withOwnerReady ? this.orderOwnerHistories(ids) : ids
    const collectedContexts = new Map<string, Awaited<ReturnType<CardContextReader['commentDetails']>>>()
    let contexts = collectedContexts
    const historyDeadline = mode === 'read' ? Date.now() + 10_000 : Infinity
    const readContexts = async () => {
      for (let offset = 0; offset < Math.min(ids.length, 20) && Date.now() < historyDeadline; offset += 4) {
        const batch = historyIds.slice(offset, Math.min(offset + 4, 20))
        if (withOwnerReady) this.ownerHistoryCursor = batch.at(-1)
        await Promise.all(batch.map(async id => {
          const context = await this.context.commentDetails(id, force)
          collectedContexts.set(id, await this.context.verifyRetractions(context).catch(() => context))
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
            contexts.get(id)!.blocks.map(block => ({ id: block.id, text: block.text, author: block.author ?? undefined })),
            snapshot.fleet, this.workflow.decisionDelivery, undefined, undefined, snapshot.intentions, 'observe') : undefined
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
    const histories = new Map(ids.map(id => [id, contexts.get(id)?.blocks ?? []]))
    const publications = (await Promise.all(queue.items.map(item => this.proposalSource.forRequest(item.id, item.cardIds, histories)))).flat()
    queue.needsWill = needsWill(queue, scene, contexts, pullRead ?? null, states, authorized, publications)
    if (withOwnerReady) {
      const jira = await jiraOwnerRead
      queue.ownerReady = this.projectOwnerReady(snapshot, contexts, jira)
      if (authorized) await this.enrichOwnerReady(queue.ownerReady, false, scene, jira, pullRead, Math.max(0, queuePullReadBudget - new Set(readableUrls).size))
    }
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
  if (!['/api/reconciliation/sources', '/api/reconciliation/scene', '/api/reconciliation/queue', '/api/reconciliation/card-context', '/api/reconciliation/owner-ready'].includes(path)) return false
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
  const query = new URL(req.url!, 'http://localhost').searchParams
  if (path === '/api/reconciliation/owner-ready') {
    if (!await sources.authorizePulls?.(req)) return fail(res, 'FORBIDDEN', 'Authorized tailnet owner required for the owner-ready bundle.', { headers })
    return ok(res, await sources.ownerReadyWithPulls(true), { headers })
  }
  const refresh = query.get('refresh') === '1'
  if (path === '/api/reconciliation/scene') {
    const requestedReferences = query.get('wait_references')
    const waitReferences = requestedReferences === '1' ? 'exact' : requestedReferences === 'cached' ? 'cached' : undefined
    return ok(res, await sources.scene(refresh, { history: query.get('history') === '1' }, waitReferences), { headers })
  }
  if (path === '/api/reconciliation/queue') return ok(res, await sources.queueDisplay(req, refresh), { headers })
  const snapshot = await sources.snapshot()
  const fleet = snapshot.fleet.map(row => {
    const { observation } = row
    const data = observation.data
    if (!data?.parent_resolutions) return row
    const { status, observed_at, mates } = data.parent_resolutions
    const parent_resolutions = { status, observed_at, mates: Object.fromEntries(
      Object.entries(mates).map(([id, mate]) => [id, { status: mate.status, keys: mate.keys }]),
    ) }
    return { ...row, observation: { ...observation, data: { ...data, parent_resolutions } } }
  })
  return ok(res, { ...snapshot, fleet }, { headers })
}
