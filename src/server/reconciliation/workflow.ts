import { releasePull } from '../../shared/pullIdentity'
import { workReadback } from './workReadback'
import { CardLeases, CardLeaseError, leaseFailure, withSourceOperation } from './cardLeases'
import { responsibleMate, strictlyNeedsWill } from './claimPolicy'
import { reviewSubmissions } from '../../shared/reviews'
import { queueRequestKey } from './queue'
import { workProposalMatchesRequest } from '../../shared/decisionProposal'
import { isReviewOperation, writeReview, ReviewWriteError, type ReviewOperation } from './workflowReview'
import { workflowMarkers } from '../../shared/workflowMarkers'
import { workflowReceipt, workflowNoteHasMarker } from '../../shared/workflowRequests'
import { DecisionSourceError, requestKey, bindDecision, reconcileDecision, decisionHistory, decisionProposals, decisionAnswer, decisionAnswerText, decisionRecordRows, type DecisionDelivery } from './decisionResolution'
import { clawsonMergeTitle, type ClawsonMergeInput, type ClawsonMergePlan } from '../../shared/clawsonMerge'
import { checkInReport } from './checkInWatchdog'
import { startWorkSchema, updateWorkSchema, decisionOptionsSchema, createWorkSchema, type SubmitHandoffInput, type UpdateWorkInput, type CreateWorkInput, type StartWorkInput, type StartWorkResult } from '../../shared/workflow'
import { canonicalWorkId, independentWaitIssue, retainedWaitText, typedWaitEntry, waitEntries, waitLine, hasActiveTypedWait, waitingForIssues, waitState, workIdShape } from '../../shared/waitingForPolicy'
import { ContractError, ImplementationContracts } from './implementationContract'
import { HandoffOperations } from './workflowHandoff'
import { codexTurn } from '../../shared/codexActivity'
import { FIRST_MATE_TASKS, isBlankWorkerLinks, workerLinkRecord } from './workerLinks'
import { checkInTime, checkInCeiling } from '../../shared/checkIn'
import { WorkflowContent, ManagedSectionConflict, NotionWriteError, richText, paragraph, heading, codeBlock, createBlockText, type WorkflowCreateBlock, receiptMarker, decisionMarker, sectionMarker, sectionText } from './workflowContent'
import { CreationReceipts } from './workflowReceipts'
import { notionCard } from './notion'
import { JiraWriteError, JiraMappingError, JiraConflictError } from './jira'
import type { SourceSnapshot } from './index'
import type { WorkReader, WorkCard } from './workReader'

const relevant = (card: WorkCard, kind: StartWorkInput['worker']['kind']) => ({ owner: card.properties.Owner?.value ?? null, status: card.properties.Status?.value ?? null,
  waiting_for: card.properties['Waiting For']?.value ?? null, waiting_for_type: card.properties['Waiting For Type']?.value ?? null, waiting_for_id: card.properties['Waiting For ID']?.value ?? null,
  ...(kind === 'firstmate' ? { worker_links: card.properties[FIRST_MATE_TASKS]?.value ?? null } : { external_workers: card.properties['Delegated To']?.value ?? null }), area: card.properties.Area?.value ?? null })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const decisionEffects = (input: Extract<UpdateWorkInput, { kind: 'answer_decision' }>, source?: Extract<UpdateWorkInput, { kind: 'answer_decision' }>['source_request']) => ({
  request_id: input.request_id, answer: input.answer, option_id: input.option_id, next: input.next,
  resolve_wait: input.resolve_wait, legacy_action: input.legacy_action,
  source: input.source_request || source ? requestKey(input.source_request ?? source!) : null,
})

const cardVersion = (card: WorkCard) => JSON.stringify([card.last_edited_time, card.properties, card.archived, card.in_trash])

/** Shared per-card policy/mutation path for UI, MCP and coordinator updates. */
class WorkflowError extends Error { constructor(readonly code: string, message: string, readonly requiresNewOperationId = false) { super(message) } }
export interface WorkflowChange { kind?: UpdateWorkInput['kind']; before?: WorkCard; card: WorkCard; actor: string; operationId: string; properties: Record<string, unknown>; notes?: string[]; sections?: string[]; sectionTexts?: string[] }
export class WorkflowOperations {
  validateReview?: (input: Extract<ReviewOperation, { kind: 'submit_for_review' }>) => Promise<void>
  decisionDelivery?: DecisionDelivery
  onChange?: (change: WorkflowChange) => Promise<void>
  onRecordedChange?: (cardId: string) => void
  deliveryStatus?: (cardId: string, operationId?: string) => Promise<unknown>
  private content: WorkflowContent
  private creations: CreationReceipts
  private reviewCursor = 0
  private noteRepairs = new Map<string, { signature: string; version: string; note: string; result: StartWorkResult }>()
  private decisionRefreshes = new Map<string, { until: number; revision: string; result: Promise<Awaited<ReturnType<WorkflowOperations['performDecisionReconcile']>>> }>()
  private locks = new Map<string, Promise<unknown>>()
  private receipts = new Map<string, { input: string; until: number; result: Promise<StartWorkResult> }>()
  constructor(private reader: WorkReader, private fleet: () => Promise<SourceSnapshot['fleet']>, receiptRoot?: string, private proposals?: import('./proposalSource').ProposalSource) { if (receiptRoot) reader.leases ??= new CardLeases(receiptRoot); this.content = new WorkflowContent(reader); this.creations = new CreationReceipts(receiptRoot) }
  private exclusive<T>(key: string, perform: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(perform)
    this.locks.set(key, result)
    void result.finally(() => { if (this.locks.get(key) === result) this.locks.delete(key) }).catch(() => {})
    return result
  }
  readImplementationContract(id: string, options: { revision?: string; offset: number; limit: number }) {
    return new ImplementationContracts(this.content).read(id, options).catch(error => ({ outcome: 'unavailable', complete_response: false,
      code: error instanceof ContractError ? error.code : 'source-unavailable', message: error instanceof ContractError ? error.message : 'Full specification read unavailable; no completeness claim' }))
  }
  private async guarded<T>(card: string | undefined, operation: string, actor: string, perform: () => Promise<T>, checkBefore = true) {
    try {
      return await withSourceOperation(actor, operation, async () => {
        if (card) { await this.reader.leases?.recoverAppliedWrite(card, intent => this.content.reservationReadback(card, intent)); this.reader.leases?.assertWritable(card, !checkBefore) }
        return perform()
      })
    } catch (error) { if (error instanceof CardLeaseError) return leaseFailure(error, operation); throw error }
  }
  start(input: StartWorkInput, actor: string): Promise<StartWorkResult> {
    return this.guarded(input.card_id, input.operation_id, actor, () => { const { lease_token: _token, ...clean } = input; return this.startUnchecked(clean, actor) })
  }
  update(input: UpdateWorkInput, actor: string): Promise<StartWorkResult> {
    if (input.kind === 'not_for_me' && !this.reader.leases?.status(input.card_id)) return Promise.resolve({ outcome: 'not-saved', code: 'claim-required', message: 'Not for me requires a current card lease', saved_fields: [], operation_id: input.operation_id })
    return this.guarded(input.card_id, input.operation_id, actor, () => { const { lease_token: _token, ...clean } = input; return this.updateUnchecked(clean, actor) }, false)
  }
  /** Desk-only persistence boundary. Legacy update() still waits for its
   * existing reconciliation result; desk advancement never waits for a worker. */
  answerPrepared(input: Extract<UpdateWorkInput, { kind: 'answer_decision' }>, actor: string): Promise<StartWorkResult> {
    return this.guarded(input.card_id, input.operation_id, actor, () => this.exclusive(input.card_id, () => this.performUpdate(input, actor, true)), false)
  }
  async observePreparedAnswer(input: Extract<UpdateWorkInput, { kind: 'answer_decision' }>, actor: string) {
    // Full notes, not a property timestamp or cached UI history. An absent
    // marker in truncated/unavailable history cannot authorize a second write.
    await withSourceOperation(actor, input.operation_id, () => this.content.recoverAppliedWrite(input.card_id))
    const notes = await this.content.notes(input.card_id)
    const intents = decisionRecordRows(notes, 'Tin Star decision intent: ').filter(row => row.input?.request_id === input.request_id)
    const answers = notes.filter(note => workflowReceipt(note)).flatMap(note => decisionRecordRows([note], 'Tin Star answer data: ')).filter(row => row.request_id === input.request_id)
    const matches = (value: unknown) => {
      const parsed = updateWorkSchema.safeParse(value)
      return parsed.success && parsed.data.kind === 'answer_decision' && same(decisionEffects(parsed.data), decisionEffects(input))
    }
    const unrelatedReceipt = notes.some(note => workflowNoteHasMarker(note, receiptMarker(actor, input.operation_id))) && !answers.length && !intents.some(row => row.actor === actor && row.input?.operation_id === input.operation_id)
    const conflict = unrelatedReceipt || intents.some(row => !matches(row.input)) || answers.some(row => row.answer !== input.answer || row.option_id !== input.option_id || !same(row.next, input.next) || row.resolve_wait !== input.resolve_wait || row.legacy_action !== input.legacy_action)
    const own = intents.find(row => row.actor === actor && row.input?.operation_id === input.operation_id && matches(row.input))
    let desired: Record<string, unknown> | undefined
    if (!conflict && !answers.length && own) {
      const card = await this.reader.card(input.card_id, true)
      const planning = { ...card, properties: Object.fromEntries(Object.entries(card.properties).map(([key, property]) => [key,
        key in own.original ? { ...property, value: own.original[key] } : property])) }
      desired = (await this.updatePlan(planning, input, actor, notes)).desired
    }
    return { state: conflict ? 'conflict' as const : answers.length ? 'confirmed' as const : own ? 'pending' as const : 'absent' as const,
      original: own?.original as Record<string, unknown> | undefined, desired }
  }
  async preparedHistory(cardId: string) {
    const [notes, sections] = await Promise.all([this.content.notes(cardId), this.content.sections(cardId, false, true)])
    return [...notes.map(note => ({ ...note, type: 'comment' })), ...sections]
  }
  async submitHandoff(input: SubmitHandoffInput, actor: string) {
    return withSourceOperation(actor, input.submission_id, async () => {
      try {
        if ('card_id' in input.target) {
          await this.reader.leases?.recoverAppliedWrite(input.target.card_id, intent => this.content.reservationReadback((input.target as { card_id: string }).card_id, intent))
          this.reader.leases?.assertWritable(input.target.card_id)
        }
        const { lease_token: _token, ...clean } = input
        return await this.performHandoff(clean, actor)
      } catch (error) {
        if (!(error instanceof CardLeaseError)) throw error
        return { ...leaseFailure(error, input.submission_id), record: { state: 'not-saved' }, assignment: { state: 'unknown' }, delivery: { state: 'unknown' }, execution: { state: 'unknown' }, recovery: { code: 'card-held', message: error.message } }
      }
    })
  }
  private performHandoff(input: SubmitHandoffInput, actor: string) {
    return new HandoffOperations({ reader: this.reader, receipts: this.creations, contracts: new ImplementationContracts(this.content),
      exclusive: (id, perform) => this.exclusive(id, perform),
      create: (create, caller) => this.serialize('create', create, caller, () => this.performCreate(create, caller, { signature: JSON.stringify(create), properties: { Status: 'Backlog' } })),
      update: (update, caller) => this.performUpdate(update, caller),
      hasNote: async (id, caller, operationId) => (await this.content.notes(id)).some(note => note.text.split('\n').includes(receiptMarker(caller, operationId))),
      matches: (card, desired) => Object.entries(desired).every(([name, value]) => this.matches(card, name, this.normalized(card, name, value))),
      notify: async change => { if (change.card.source?.synthetic) return; if (!this.onChange) throw new Error('Firstmate bridge unavailable'); await this.onChange(change) },
      delivery: (id, operationId) => this.reader.jira && id.startsWith('jira:') ? Promise.resolve({ state: 'disabled', reason: 'Synthetic Jira pilot; no live pickup or inbox delivery' }) : this.deliveryStatus?.(id, operationId) ?? Promise.resolve({ state: 'unknown', reason: 'Firstmate bridge observation unavailable' }),
      execution: async card => {
        if (card.properties.Status?.value === 'Queued') return { state: 'queued', worker: null }
        if (card.properties.Status?.value === 'In Progress') {
          const links = card.properties[FIRST_MATE_TASKS]?.workerLinks
          if (links?.status === 'valid') for (const worker of links.tasks) {
            try {
              await this.startPlan(card, { card_id: card.id, operation_id: 'handoff-observe', worker: { kind: 'firstmate', ...worker } }, actor)
              return { state: 'running', worker, evidence: 'Fresh tracked native execution and canonical card worker link' }
            } catch { /* A stale/historical link does not prove execution. */ }
          }
        }
        return { state: 'unknown', worker: null }
      },
    }).submit(input, actor)
  }
  private serialize(cardId: string, input: { operation_id: string }, actor: string, perform: () => Promise<StartWorkResult>) {
    const failed = (code: string, message: string): StartWorkResult => ({ outcome: 'not-saved', code, message, operation_id: input.operation_id, saved_fields: [] })
    if (!actor.trim()) return Promise.resolve(failed('unauthenticated', 'Authenticated caller identity required'))
    for (const [key, receipt] of this.receipts) if (receipt.until < Date.now()) { this.receipts.delete(key); this.noteRepairs.delete(key) }
    const key = JSON.stringify([actor, cardId, input.operation_id]), signature = JSON.stringify(input)
    const previous = this.receipts.get(key)
    if (previous && previous.input !== signature) return Promise.resolve({ ...failed('operation-conflict', 'operation_id was used with different input'), requires_new_operation_id: true })
    if (previous && !this.noteRepairs.has(key)) return previous.result
    const prior = this.locks.get(cardId) ?? Promise.resolve()
    const result = prior.catch(() => {}).then(perform)
    this.locks.set(cardId, result)
    void result.finally(() => { if (this.locks.get(cardId) === result) this.locks.delete(cardId) }).catch(() => {})
    if (this.receipts.size >= 1000) { const oldest = this.receipts.keys().next().value!; this.receipts.delete(oldest); this.noteRepairs.delete(oldest) }
    this.receipts.set(key, { input: signature, until: Date.now() + 600_000, result })
    void result.then(value => { if (value.code === 'firstmate-pending' || value.outcome === 'not-saved' || value.outcome === 'partially-saved' && (!('kind' in input) || input.kind === 'not_for_me')) this.receipts.delete(key) }).catch(() => this.receipts.delete(key))
    return result
  }
  private async changed(change: WorkflowChange) {
    this.onRecordedChange?.(change.card.id)
    // Pilot issues are synthetic: recording a queue/start never offers live pickup.
    if (change.card.source?.synthetic) return
    if (change.kind === 'not_for_me' && !change.notes?.length) return
    if (change.kind === 'not_for_me') await this.onChange?.(change)
    else await this.onChange?.(change).catch(() => {})
  }

  private startUnchecked(input: StartWorkInput, actor: string): Promise<StartWorkResult> {
    const parsed = startWorkSchema.safeParse(input)
    const failed = (code: string, message: string): StartWorkResult => ({ outcome: 'not-saved', code, message, operation_id: input?.operation_id ?? '', saved_fields: [] })
    if (!parsed.success) return Promise.resolve(failed('invalid-input', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')))
    if (!actor.trim()) return Promise.resolve(failed('unauthenticated', 'Authenticated caller identity required'))
    input = parsed.data
    return this.serialize(input.card_id, input, actor, () => this.perform(input, actor))
  }
  private async startPlan(card: WorkCard, input: StartWorkInput, actor: string) {
    const status = card.properties.Status?.type, touched = card.properties['Last touched by']?.type
    if (!['select', 'status'].includes(status ?? '') || !['select', 'rich_text'].includes(touched ?? '')) throw new WorkflowError('unsupported-properties', 'Status or Last touched by has an unsupported property type')
    const properties: Record<string, unknown> = { Status: { [status!]: { name: 'In Progress' } },
      'Last touched by': touched === 'select' ? { select: { name: actor } } : richText(actor) }
    const desired: Record<string, unknown> = { Status: 'In Progress', 'Last touched by': actor }
    if (input.worker.kind === 'firstmate') {
      const worker = input.worker
      const homes = await this.fleet(), home = homes.find(row => row.source.home === worker.fm_home)
      if (!home || home.observation.status !== 'fresh' || home.observation.coverage !== 'complete' || !home.observation.data || Date.parse(home.observation.expiresAt ?? '') <= Date.now()) throw new WorkflowError('worker-unknown', 'Worker source is missing, partial or stale; current execution is unknown')
      const matches = home.observation.data.tasks.filter(task => task.identity.task_id === worker.task_id)
      if (matches.length !== 1 || matches[0]!.identity.spawn_gen !== worker.first_observed_spawn_gen) throw new WorkflowError('worker-untracked', 'Exact home/task/spawn generation is not currently tracked')
      const task = matches[0]!, state = task.current_state
      // Historical status-log verbs and endpoint existence cannot authorize a
      // new start. Use fresh native pane/run-step or Codex turn observations.
      const current = ['pane', 'run-step'].includes(String(state.source)) && state.freshness === 'fresh' && ['working', 'running', 'executing'].includes(String(state.state))
      const alive = task.endpoint.exists !== false && task.endpoint.agent_alive !== 'dead' && task.endpoint.status !== 'dead'
      if (task.kind === 'secondmate' || !alive || !(current || codexTurn(task, Date.now()) === true)) throw new WorkflowError('worker-not-executing', 'Tracked worker has no current execution evidence; owner names, historical reports and waits do not establish execution')
      const property = card.properties[FIRST_MATE_TASKS], links = property?.workerLinks
      if (property?.type !== 'rich_text' || !links || links.status !== 'valid' && !isBlankWorkerLinks(links)) throw new WorkflowError('worker-links-unreadable', 'Existing First Mate tasks cannot be safely merged; correct that property first')
      const tasks = links.status === 'valid' ? [...links.tasks] : []
      const existing = tasks.find(task => task.fm_home === worker.fm_home && task.task_id === worker.task_id)
      if (existing && existing.first_observed_spawn_gen !== worker.first_observed_spawn_gen) throw new WorkflowError('worker-generation-conflict', 'Existing native task has a different spawn generation; preserve and reconcile its history')
      if (!existing) tasks.push({ fm_home: worker.fm_home, task_id: worker.task_id, first_observed_spawn_gen: worker.first_observed_spawn_gen })
      const record = workerLinkRecord(tasks)
      Object.assign(properties, record.properties); desired[FIRST_MATE_TASKS] = record.json
    } else {
      const worker = input.worker, age = Date.now() - Date.parse(worker.observed_at)
      if (worker.card_id !== input.card_id || age < -30_000 || age >= 300_000) throw new WorkflowError('external-evidence-stale', 'External run must reference this card and include a current running observation within five minutes')
      const evidence = card.properties['Delegated To']
      if (evidence?.type !== 'rich_text' || evidence.hasMore) throw new WorkflowError('external-evidence-property', 'External worker provenance requires a readable Delegated To rich-text property')
      const entry = JSON.stringify({ schema: 'tinstar.external-worker.v1', ...worker, reported_by: actor })
      const old = String(evidence.value ?? '')
      const value = old.includes(entry) ? old : `${old}${old ? '\n' : ''}${entry}`
      properties['Delegated To'] = richText(value); desired['Delegated To'] = value
    }
    return { properties, desired }
  }
  private async perform(input: StartWorkInput, actor: string): Promise<StartWorkResult> {
    let attempted = false
    let fields: string[] = [], desired: Record<string, unknown> = {}
    const result = (outcome: StartWorkResult['outcome'], code: string, message: string, card?: WorkCard, saved_fields: string[] = []): StartWorkResult =>
      ({ outcome, code, message, operation_id: input.operation_id, saved_fields, ...(card ? { card } : {}) })
    try {
      const card = await this.reader.card(input.card_id, true)
      if (card.archived || card.in_trash) return result('not-saved', 'archived', 'Restore this card before starting work')
      const initial = relevant(card, input.worker.kind)
      if (input.expected && !same(input.expected, { owner: initial.owner, status: initial.status, worker_links: card.properties[FIRST_MATE_TASKS]?.value ?? null })) return result('not-saved', 'conflict', 'Owner, Status or worker links changed; read the card and retry', card)
      if (typeof initial.owner !== 'string' || !initial.owner.trim() || !initial.area || typeof initial.area === 'string' && !initial.area.trim() || Array.isArray(initial.area) && !initial.area.length) return result('not-saved', 'required-fields', 'Start work requires an existing Owner and Area; Tin Star does not infer them', card)
      const plan = await this.startPlan(card, input, actor)
      await this.validateWaitState(card, plan.desired)
      const { properties } = plan
      desired = plan.desired
      fields = Object.keys(desired)
      // Compare only fields used to validate/build this operation, not unrelated
      // edits or Last edited time. Direct edits can still race Notion PATCH.
      const current = await this.reader.card(input.card_id, true)
      if (!same(relevant(current, input.worker.kind), initial)) return result('not-saved', 'conflict', 'Relevant card properties changed during validation; read and retry', current)
      if (fields.every(field => same(current.properties[field]?.value, desired[field]))) { this.reader.confirm(current); await this.changed({ before: card, card: current, actor, operationId: input.operation_id, properties: {} }); return result('saved', 'already-saved', 'Start work already saved', current, fields) }
      attempted = true
      let saved: WorkCard
      if (card.source?.provider === 'jira') {
        saved = await this.content.patchProperties(input.card_id, Object.fromEntries(Object.entries(properties).filter(([field]) => !same(current.properties[field]?.value, desired[field])))) as WorkCard
      } else {
        await this.content.patchProperties(input.card_id, Object.fromEntries(Object.entries(properties).filter(([field]) => !same(current.properties[field]?.value, desired[field]))))
        saved = await this.reader.card(input.card_id, true)
      }
      this.reader.confirm(saved)
      await this.changed({ before: card, card: saved, actor, operationId: input.operation_id, properties: Object.fromEntries(fields.filter(field => same(saved.properties[field]?.value, desired[field])).map(field => [field, desired[field]])) })
      const savedFields = fields.filter(field => same(saved.properties[field]?.value, desired[field]))
      return savedFields.length === fields.length ? result('saved', 'saved', 'Start work saved and confirmed', saved, savedFields)
        : result('partially-saved', 'readback-mismatch', 'Readback differs from the requested start; only listed fields are confirmed. Read the card and retry.', saved, savedFields)
    } catch (error) {
      if (error instanceof CardLeaseError) throw error
      if (error instanceof NotionWriteError && error.status < 500) return result('not-saved', 'notion-rejected', `Notion rejected start work (HTTP ${error.status}); nothing confirmed saved`)
      if (error instanceof WorkflowError && !attempted) return result('not-saved', error.code, error.message)
      if (error instanceof JiraMappingError) return result('not-saved', 'jira-incompatible', error.message)
      if (error instanceof JiraWriteError && error.method !== 'GET' && error.status < 500 && !error.partial) return result('not-saved', 'jira-rejected', `Jira rejected start work (HTTP ${error.status})`)
      if (input.card_id.startsWith('jira:') && attempted) {
        const current = await this.reader.card(input.card_id, true).catch(() => undefined)
        if (current) return result('partially-saved', 'save-unconfirmed', 'Only listed start fields confirmed after a Jira write failure; inspect current state before retrying.', current, fields.filter(field => same(current.properties[field]?.value, desired[field])))
      }
      return result(attempted ? 'partially-saved' : 'not-saved', attempted ? 'save-unconfirmed' : 'source-unavailable', attempted
        ? 'Start work was submitted but readback could not be confirmed. Refresh and retry the same operation; no offline write is queued.'
        : 'Current source read failed; start work was not submitted')
    }
  }
  private updateUnchecked(input: UpdateWorkInput, actor: string): Promise<StartWorkResult> {
    const parsed = updateWorkSchema.safeParse(input)
    if (!parsed.success) return Promise.resolve({ outcome: 'not-saved', code: 'invalid-input', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), operation_id: input?.operation_id ?? '', saved_fields: [] })
    if (isReviewOperation(parsed.data)) {
      const review = parsed.data
      return this.exclusive(review.card_id, () => writeReview(review, actor, { reader: this.reader, content: this.content, receipts: this.creations,
        property: (card, field, value) => this.property(card, field, value), changed: change => this.changed(change),
        validate: input => this.validateReview ? this.validateReview(input) : Promise.reject(new ReviewWriteError('deployment-unavailable', 'Verified guarded deployment evidence is unavailable')),
      }))
    }
    this.decisionRefreshes.delete(parsed.data.card_id)
    return this.serialize(parsed.data.card_id, parsed.data, actor, async () => {
      const result = await this.performUpdate(parsed.data, actor)
      if (parsed.data.kind !== 'answer_decision' || result.outcome !== 'saved') return result
      const answeredId = parsed.data.request_id
      const summary = await this.performDecisionReconcile(parsed.data.card_id).catch(() => ({ state: 'pending' as const, message: 'Decision recorded · First Mate not yet updated' }))
      const resolution = summary && 'requests' in summary ? summary.requests?.find(request => request.request_id === answeredId) ?? summary : summary
      if (!resolution) return result
      return { ...result, decision_resolution: resolution, ...(resolution.state !== 'resolved' ? {
        outcome: 'partially-saved' as const, code: 'firstmate-pending', message: resolution.message,
      } : { message: 'Decision recorded · First Mate reconciled' }) }
    })
  }
  async savedReviewAssociations() {
    return (await this.creations.list('review:')).flatMap(([, receipt]) => receipt.cardId && receipt.review?.done
      ? reviewSubmissions([{ text: receipt.review.note }]).flatMap(submission => submission.pulls.map(pull => ({ cardId: receipt.cardId!, pull: pull.url }))) : [])
  }
  async pendingReviewCount() {
    return (await this.creations.list('review:')).filter(([, receipt]) => receipt.review && !receipt.review.done).length
  }
  async reconcileReviews() {
    const pending = (await this.creations.list('review:')).filter(([, receipt]) => receipt.review && !receipt.review.done)
    const results: Array<{ cardId: string; result: StartWorkResult }> = []
    const start = this.reviewCursor % Math.max(pending.length, 1)
    for (let offset = 0; offset < Math.min(pending.length, 8); offset++) {
      const index = (start + offset) % pending.length
      this.reviewCursor = index + 1
      const [, receipt] = pending[index]!
      const parsed = updateWorkSchema.safeParse(receipt.review?.input)
      if (parsed.success && isReviewOperation(parsed.data)) results.push({ cardId: parsed.data.card_id, result: await this.update(parsed.data, receipt.review!.actor) })
    }
    return results
  }
  decisionCensus() {
    let census: Promise<SourceSnapshot['intentions']> | undefined
    return () => census ??= this.reader.query({}, true)
  }
  async reconcileDecisions(cardId: string, fleet?: SourceSnapshot['fleet'], force = true, census = this.decisionCensus()) {
    const revision = JSON.stringify([this.reader.lastKnown(cardId)?.card.last_edited_time, fleet?.map(home => [home.source.home, home.observation.observedAt, home.observation.status]), await this.proposals?.revision()])
    const cached = this.decisionRefreshes.get(cardId)
    if (!force && cached && cached.until > Date.now() && cached.revision === revision) return cached.result
    const prior = this.locks.get(cardId) ?? Promise.resolve()
    const result = prior.catch(() => {}).then(() => this.performDecisionReconcile(cardId, fleet, true, census))
    this.locks.set(cardId, result)
    if (this.decisionRefreshes.size >= 200) this.decisionRefreshes.delete(this.decisionRefreshes.keys().next().value!)
    this.decisionRefreshes.set(cardId, { until: Date.now() + 30_000, revision, result })
    void result.catch(() => this.decisionRefreshes.delete(cardId))
    void result.finally(() => { if (this.locks.get(cardId) === result) this.locks.delete(cardId) }).catch(() => {})
    return result
  }
  private async performDecisionReconcile(cardId: string, fleet?: SourceSnapshot['fleet'], repair = false, census = this.decisionCensus()) {
    let card = await this.reader.card(cardId, true)
    if (card.source?.synthetic) return null
    let notes = [...await this.content.notes(cardId), ...await this.content.sections(cardId)]
    const jsonLines = (prefix: string) => decisionRecordRows(notes, prefix)
    const recordedRequests = decisionHistory(notes, await this.proposals?.read(cardId, notes))
    if (repair) {
      // Recover a property/comment interruption from the same durable Notion
      // history, including after restart. Never replay a different user edit.
      for (const intent of jsonLines('Tin Star decision intent: ')) {
        const input = updateWorkSchema.safeParse(intent.input)
        if (!input.success || input.data.card_id !== cardId || input.data.kind !== 'answer_decision' || typeof intent.actor !== 'string') continue
        const result = await this.performUpdate(input.data, intent.actor)
        if (result.outcome !== 'saved') return { state: 'pending' as const, message: 'Decision recorded · First Mate not yet updated' }
      }
      // Explicit direct Notion answers use the same scoped workflow plan. A
      // prose approval without proposal/answer/next-state fields is ambiguous.
      for (const request of recordedRequests.filter(row => row.source_request)) {
        const direct = notes.filter(note => decisionRecordRows([note], 'Tin Star answer: ').includes(request.id) && !workflowReceipt(note))
        if (!direct.length) continue
        if (new Set(direct.map(note => JSON.stringify(decisionAnswer(note)))).size !== 1) return { state: 'verification-needed' as const, message: 'Decision reconciliation needs verification: contradictory direct answers' }
        const parsedAnswer = decisionAnswer(direct[0]!)
        const { answer, owner, status, wait } = parsedAnswer ?? {}
        const input = updateWorkSchema.safeParse({ kind: 'answer_decision', card_id: cardId, operation_id: `notion-answer-${direct[0]!.id}`, request_id: request.id, answer,
          next: { owner, status }, ...(wait ? { resolve_wait: wait } : {}) })
        if (!input.success) return { state: 'verification-needed' as const, message: 'Decision reconciliation needs verification: explicit answer and next owner/status required' }
        const result = await this.performUpdate(input.data, 'Notion decision')
        if (result.code === 'decision-not-open') continue
        if (result.outcome !== 'saved') return { state: 'verification-needed' as const, message: `Decision reconciliation needs verification: ${result.message}` }
      }
      card = await this.reader.card(cardId, true)
      notes = [...await this.content.notes(cardId), ...await this.content.sections(cardId)]
    }
    return reconcileDecision(card, notes, fleet ?? await this.fleet(), this.decisionDelivery,
      async (text, marker) => { await this.content.note(cardId, text, marker); this.onRecordedChange?.(cardId) }, await this.proposals?.read(cardId, notes), census)
  }
  create(input: CreateWorkInput, actor: string): Promise<StartWorkResult> {
    const parsed = createWorkSchema.safeParse(input)
    if (!parsed.success) return Promise.resolve({ outcome: 'not-saved', code: 'invalid-input', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), operation_id: input?.operation_id ?? '', saved_fields: [] })
    return this.serialize(parsed.data.provider === 'jira' ? 'create:jira' : 'create', parsed.data, actor, () => this.performCreate(parsed.data, actor))
  }
  /** Owner-only PR handoff; shares create_work's Notion writer and durable receipts. */
  createClawsonMerge(input: ClawsonMergeInput, actor: string, prepare: () => Promise<ClawsonMergePlan>): Promise<StartWorkResult> {
    const signature = JSON.stringify({ kind: 'clawson-merge', ...input })
    return this.serialize('create', input, actor, async () => {
      try {
        const previous = await this.creations.get(JSON.stringify([actor, input.operation_id]))
        if (previous && previous.input !== signature) return { outcome: 'not-saved', code: 'operation-conflict', message: 'This click was already used with a different selection.', operation_id: input.operation_id, saved_fields: [] }
        if (previous?.cardId) {
          const card = await this.reader.card(previous.cardId, true)
          return { outcome: 'saved', code: 'already-saved', message: 'Already sent to Clawson.', operation_id: input.operation_id, saved_fields: ['card'], card }
        }
        if (previous) {
          const card = await this.findCreation(actor, input.operation_id, clawsonMergeTitle(input))
          if (!card) return { outcome: 'partially-saved', code: 'create-unconfirmed', message: 'Earlier creation remains unconfirmed; this retry will not create a duplicate.', operation_id: input.operation_id, saved_fields: [] }
          await this.creations.put(JSON.stringify([actor, input.operation_id]), signature, card.id)
          const current = await this.reader.card(card.id, true)
          this.reader.confirm(current)
          await this.changed({ card: current, actor, operationId: input.operation_id, properties: {} })
          return { outcome: 'saved', code: 'already-saved', message: 'Already sent to Clawson.', operation_id: input.operation_id, saved_fields: ['card'], card: current }
        }
      } catch {
        return { outcome: 'partially-saved', code: 'create-unconfirmed', message: 'Earlier creation could not be reconciled; retry to retrieve its receipt.', operation_id: input.operation_id, saved_fields: [] }
      }
      let prepared: ClawsonMergePlan
      try { prepared = await prepare() } catch (error) {
        return { outcome: 'not-saved', code: 'merge-refused', message: (error as Error).message, operation_id: input.operation_id, saved_fields: [] }
      }
      const create = createWorkSchema.parse({ operation_id: input.operation_id, name: prepared.name, owner: 'Clawson', area: 'CI', status: 'Queued', content: { brief: prepared.brief } })
      return this.performCreate(create, actor, { signature, properties: { Status: 'In Progress', 'Next check-in': prepared.at, 'Will action': ['Merge'] }, children: [
        heading('Authority'), paragraph(prepared.brief), heading('Step 1 (run once)'), codeBlock(prepared.script),
        paragraph('If any check line fails (head moved, not mergeable, a red or pending check): STOP and post the output. Otherwise post the final lines and hand back. Nothing else: no other PR, no deploy.'),
        heading('Return'), paragraph('Post one comment per PR on this card with its PR URL, exact head SHA, command result, and final state + merge commit (with the commit URL on success). On any stop, post the output and do not continue the batch.'),
      ] })
    })
  }
  private property(card: WorkCard, name: string, value: unknown) {
    const prop = card.properties[name], type = prop?.type
    if (prop?.hasMore) throw new WorkflowError('property-truncated', `${name} is truncated; it cannot safely be replaced`)
    if (type === 'rich_text' || type === 'title') {
      if (value !== null && typeof value !== 'string') throw new WorkflowError('property-type', `${name} requires text`)
      return { [type]: richText(String(value ?? '')).rich_text }
    }
    if (type === 'status' || type === 'select') {
      if (value !== null && typeof value !== 'string') throw new WorkflowError('property-type', `${name} requires an option name`)
      return { [type]: value === null ? null : { name: value } }
    }
    if (type === 'multi_select' || type === 'relation') {
      const values = value === null ? [] : typeof value === 'string' && type === 'multi_select' ? [value] : value
      if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw new WorkflowError('property-type', `${name} requires ${type === 'relation' ? 'canonical related page IDs' : 'option names'}`)
      return { [type]: values.map(v => type === 'relation' ? { id: v } : { name: v }) }
    }
    if (type === 'date') {
      if (value === null) return { date: null }
      if (typeof value !== 'string' || !Number.isFinite(checkInTime(value))) throw new WorkflowError('invalid-date', `${name} requires a valid date or timestamp`)
      return { date: { start: value } }
    }
    if (type === 'url') return { url: value }
    throw new WorkflowError('unsupported-property', `${name} is absent or has an unsupported property type`)
  }
  private normalized(card: WorkCard, name: string, value: unknown): unknown {
    const type = card.properties[name]?.type
    if (type === 'date' && typeof value === 'string') return { start: value, end: null, time_zone: null }
    if (type === 'multi_select' && typeof value === 'string') return [value]
    if (value === null && (type === 'title' || type === 'rich_text')) return ''
    if (value === null && (type === 'relation' || type === 'multi_select')) return []
    return value
  }
  private required(card: WorkCard, owner = card.properties.Owner?.value) {
    const area = card.properties.Area?.value
    if (typeof owner !== 'string' || !owner.trim() || !area || Array.isArray(area) && !area.length) throw new WorkflowError('required-fields', 'This transition requires a declared Owner and Area')
  }
  private validateCheckpoint(card: WorkCard, appointment: string) {
    const next = checkInTime(appointment), now = Date.now()
    if (!Number.isFinite(next) || next <= now) throw new WorkflowError('invalid-checkpoint', 'Next check-in must be a future appointment; date-only means 9 AM America/New_York')
    if (card.properties.Status?.value === 'In Progress' && next > checkInCeiling(now)) throw new WorkflowError('checkpoint-ceiling', `Next check-in exceeds the board ceiling (${new Date(checkInCeiling(now)).toISOString()})`)
    return next
  }
  private futureCheckIn(card: WorkCard, appointment: string) {
    const next = checkInTime(appointment), now = Date.now()
    if (!Number.isFinite(next) || next <= now) throw new WorkflowError('invalid-check-in', 'Next check-in must be a future appointment; date-only means 9 AM America/New_York. Nothing was written.')
    if (card.source?.provider === 'jira') return next
    // Notion truncates date writes to the minute. Match its storage precision
    // up front so readback is exact and a near-term appointment stays future.
    const minute = Math.floor(next / 60_000) * 60_000
    return minute > now ? minute : minute + 60_000
  }
  private async validateWaitState(card: WorkCard, desired: Record<string, unknown>, resolve?: string) {
    if (!['Status', 'Waiting For', 'Waiting For Type', 'Waiting For ID', 'Next check-in'].some(name => name in desired)) return
    const value = (name: string) => name in desired ? desired[name] : card.properties[name]?.value
    const status = String(value('Status') ?? '')
    if ((card.properties.Status?.value === 'Waiting For' || hasActiveTypedWait({ type: String(card.properties['Waiting For Type']?.value ?? ''), id: String(card.properties['Waiting For ID']?.value ?? ''), waitingFor: String(card.properties['Waiting For']?.value ?? '') })) && status !== 'Waiting For') {
      const current = waitState(card)
      const entries = waitEntries(current.waitingFor, current).map(entry => entry.text)
      if (!resolve || entries.filter(line => line === resolve).length !== 1 || entries.some(line => line !== resolve) || String(value('Waiting For') ?? '').trim()) throw new WorkflowError('wait-unresolved', 'Leaving Waiting For requires exact resolution of every active blocker through assign or answer_decision. Nothing was written.')
    }
    const state = { ...waitState(card), status, type: String(value('Waiting For Type') ?? ''), id: String(value('Waiting For ID') ?? ''),
      waitingFor: String(value('Waiting For') ?? ''), nextCheckIn: value('Next check-in') as ReturnType<typeof waitState>['nextCheckIn'] }
    const references = await this.reader.waitingForWork([state], [], { refresh: true })
    const [issue] = waitingForIssues({ ...state, coverage: 'complete' }, references)
    if (issue) {
      const code = issue.category === 'reference' ? issue.code : 'wait-invalid'
      throw new WorkflowError(code, `${issue.field}: ${issue.reason} Repair the active wait fields before this transition. Nothing was written.`)
    }
  }
  private async updatePlan(card: WorkCard, input: UpdateWorkInput, actor: string, notes: Awaited<ReturnType<WorkflowContent['notes']>>) {
    const desired: Record<string, unknown> = {}, properties: Record<string, unknown> = {}, sections: Record<string, string> = {}
    const reads = new Set<string>(), at = new Date().toISOString()
    let answerBinding: Record<string, unknown> | undefined
    let heldWait = false
    let note = `Date: ${at}\nBy: ${actor}\nOperation: ${input.kind}`
    const set = (name: string, value: unknown) => { reads.add(name); properties[name] = this.property(card, name, value); desired[name] = this.normalized(card, name, value) }
    const transition = (owner: string, status: string) => {
      reads.add('Owner'); reads.add('Status'); reads.add('Area')
      this.required(card, owner)
      if (owner.toLowerCase() === 'firstmate' && input.kind === 'assign') status = 'Queued'
      set('Owner', owner); set('Status', status)
    }
    const originalWaitText = String(card.properties['Waiting For']?.value ?? '')
    const waitIdentity = () => ({
      type: String(('Waiting For Type' in desired ? desired['Waiting For Type'] : card.properties['Waiting For Type']?.value) ?? ''),
      id: String(desired['Waiting For ID'] ?? card.properties['Waiting For ID']?.value ?? ''),
    })
    let editedWaits: ReturnType<typeof waitEntries> | undefined
    const currentWaits = () => editedWaits ?? waitEntries(originalWaitText, waitIdentity())
    const wait = async (value: { type: 'Actor' | 'Event' | 'Work'; id: string; dependency: string; unblocks_when: string; follow_up_by: string; next_check_in: string }, replace?: string) => {
      if (String(card.properties.Status?.value ?? '') === 'Waiting for Prod Release') throw new WorkflowError('release-lifecycle', 'Waiting for Prod Release stays on the release lifecycle. This operation does not convert it to generic Waiting For. Nothing was written.')
      const issue = independentWaitIssue(value)
      if (issue) throw new WorkflowError(issue.code, `${issue.message} Nothing was written.`)
      const shape = value.type === 'Work' ? workIdShape(card.id, value.id) : null
      if (shape) throw new WorkflowError(shape.code, `${shape.message} Nothing was written.`)
      const id = value.type === 'Work' ? canonicalWorkId(value.id)! : value.id.trim()
      const line = waitLine({ ...value, id })
      const entries = currentWaits()
      const added = { text: line, fields: { ...value, id } }
      if (replace !== undefined) {
        const matches = entries.filter(entry => entry.text === replace)
        const entry = matches.length === 1 ? matches[0] : undefined
        if (!entry || typedWaitEntry(entry) || (['dependency', 'unblocks_when', 'follow_up_by'] as const).some(field => entry.fields[field]?.trim() && entry.fields[field] !== value[field])) {
          throw new WorkflowError('wait-repair-conflict', 'Each repair must match exactly one incomplete or legacy wait and preserve its recorded dependency, unblock condition and follow-up owner. Nothing was written.')
        }
        editedWaits = entries.map(item => item === entry ? added : item)
        set('Waiting For Type', value.type); set('Waiting For ID', id)
        note += `\nRepaired legacy wait: ${JSON.stringify(replace)}`
      } else {
        editedWaits = entries.some(entry => entry.text === line) ? entries : [...entries, added]
      }
      const { type: primaryType, id: primaryId } = waitIdentity()
      const samePrimary = primaryType === value.type && (value.type === 'Work'
        ? canonicalWorkId(primaryId.trim()) === id : primaryId.trim().toLowerCase() === id.toLowerCase())
      const appointment = this.futureCheckIn(card, value.next_check_in)
      const currentAppointment = checkInTime(((desired['Next check-in'] ?? card.properties['Next check-in']?.value) as { start?: string } | null)?.start ?? null, ((desired['Next check-in'] ?? card.properties['Next check-in']?.value) as { time_zone?: string } | null)?.time_zone)
      if (!primaryType || !primaryId || samePrimary) { set('Waiting For Type', value.type); set('Waiting For ID', id) }
      if (!primaryType || !primaryId || samePrimary || !Number.isFinite(currentAppointment) || currentAppointment <= Date.now() || appointment < currentAppointment) set('Next check-in', new Date(appointment).toISOString())
      note += `\n${line}`
    }
    const resolveWait = (resolve: string | undefined, requestedStatus: string) => {
      const wasWaiting = String(card.properties.Status?.value ?? '') === 'Waiting For' || hasActiveTypedWait({ type: String(card.properties['Waiting For Type']?.value ?? ''), id: String(card.properties['Waiting For ID']?.value ?? ''), waitingFor: String(card.properties['Waiting For']?.value ?? '') })
      const entries = currentWaits()
      if (!wasWaiting) {
        if (!resolve) return
        if (entries.filter(entry => entry.text === resolve).length !== 1) throw new WorkflowError('wait-conflict', 'The explicitly resolved wait must match one current wait; refresh and retry. Nothing was written.')
        editedWaits = entries.filter(entry => entry.text !== resolve)
        if (input.kind === 'assign') note += `\nResolved wait: ${JSON.stringify(resolve)}`
        return
      }
      if (requestedStatus === 'Waiting For' && !resolve) return
      const blockers = entries.map(entry => entry.text)
      if (!resolve) throw new WorkflowError('wait-unresolved', `Leaving Waiting For requires the exact current wait text.${blockers.length ? ` Current wait: ${blockers[0]}` : ' Waiting For text is empty, so there is no exact wait to resolve. Repair it with a typed wait, or refresh the card.'} Nothing was written.`)
      if (entries.filter(entry => entry.text === resolve).length !== 1) throw new WorkflowError('wait-conflict', 'The explicitly resolved wait must match one current wait; refresh and retry. Nothing was written.')
      const still = entries.filter(entry => entry.text !== resolve)
      editedWaits = still
      if (input.kind === 'assign') note += `\nResolved wait: ${JSON.stringify(resolve)}`
      const successor = still.map(typedWaitEntry).find(parsed => parsed)
      const clearBlocker = () => {
        if (card.properties['Waiting For Type']) set('Waiting For Type', null)
        if (card.properties['Waiting For ID']) set('Waiting For ID', '')
      }
      if (still.length > 0 && !successor) throw new WorkflowError('wait-repair-required', 'A remaining legacy wait has no typed identity. Repair it with a typed wait before resolving this blocker. Nothing was written.')
      if (still.length === 0) clearBlocker()
      else if (successor) { set('Waiting For Type', successor.type); set('Waiting For ID', successor.id) }
      if (still.length > 0 && requestedStatus !== 'Waiting For') { set('Status', 'Waiting For'); heldWait = true; note += '\nStatus retained: Waiting For. Another independent wait remains.' }
    }
    if (input.kind === 'close_worker') {
      const property = card.properties[FIRST_MATE_TASKS], links = property?.workerLinks
      if (property?.type !== 'rich_text' || property.hasMore || links?.status !== 'valid') throw new WorkflowError('worker-links-unreadable', 'Close-out requires a complete valid First Mate tasks declaration; nothing was removed')
      const worker = input.worker
      const existing = links.tasks.find(task => task.fm_home === worker.fm_home && task.task_id === worker.task_id)
      if (existing && existing.first_observed_spawn_gen !== worker.first_observed_spawn_gen) throw new WorkflowError('worker-generation-conflict', 'The declared worker has a different spawn generation; nothing was removed')
      // An absent exact identity is a supported idempotent close-out, including
      // recovery after the property saved but its audit comment did not.
      const record = workerLinkRecord(links.tasks.filter(task => task !== existing))
      set(FIRST_MATE_TASKS, record.json)
      note += `\nWorker close-out: ${JSON.stringify({ worker, disposition: input.disposition, evidence: input.evidence, previously_declared: !!existing })}`
    } else if (input.kind === 'release_wait') {
      reads.add('Status')
      if (card.properties.Status?.value !== 'Waiting for Prod Release') throw new WorkflowError('release-lifecycle', 'Record release PRs only on Waiting for Prod Release cards')
      const current = card.properties['GitHub PRs']
      if (current?.type !== 'rich_text' || current.hasMore) throw new WorkflowError('unsupported-property', 'GitHub PRs must be complete readable rich text')
      const old = String(current.value ?? '')
      const urls = new Set((old.match(/https:\/\/github\.com\/[^\s<>"\[\]()]+/gi) ?? []).flatMap(value => releasePull(value)?.url ?? []))
      const added = [...new Set(input.pulls.map(value => releasePull(value)!.url))].filter(url => !urls.has(url))
      set('GitHub PRs', [old, ...added].filter(Boolean).join('\n'))
      note += `\nAwaited production PRs: ${JSON.stringify(input.pulls.map(value => releasePull(value)!.url))}\nEvidence: ${input.evidence}`
    } else if (input.kind === 'edit') {
      for (const [name, value] of Object.entries(input.properties ?? {})) set(name, value)
      Object.assign(sections, input.content)
      if (input.note) note += `\n${input.note}`
    } else if (input.kind === 'assign') {
      const requested = input.owner.toLowerCase() === 'firstmate' ? 'Queued' : input.status
      transition(input.owner, input.status)
      resolveWait(input.resolve_wait, requested)
      if (input.note) note += `\nHandoff: ${input.note}`
    } else if (input.kind === 'wait') {
      if (input.repair_waits) {
        if (card.properties.Status?.value !== 'Waiting For' || ['Status', 'Waiting For', 'Waiting For Type', 'Waiting For ID'].some(name => !input.expected || !(name in input.expected) || !this.matches(card, name, input.expected[name]))) throw new WorkflowError('wait-repair-precondition', 'Legacy wait repair requires exact expected Status, Waiting For, Waiting For Type and Waiting For ID from the current card. Nothing was written.')
        for (const repair of input.repair_waits) await wait(repair.replacement, repair.current)
      }
      transition(String(card.properties.Owner?.value ?? ''), 'Waiting For')
      await wait(input)
      if (input.note) note += `\n${input.note}`
    } else if (input.kind === 'checkpoint') {
      const cp = input.checkpoint, next = this.validateCheckpoint(card, cp.next_check_in)
      const proseLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, ' ')
      reads.add('Status')
      // Normalize meaning so Notion timezone/format rendering cannot reject a save.
      set('Next check-in', new Date(next).toISOString())
      if (card.properties['Next action']) set('Next action', cp.next_action)
      note = `${cp.request_id ? `Check-in request: ${cp.request_id}\n` : ''}Date: ${at}\nBy: ${actor}\nProgress: ${proseLine(cp.assessment)}\nEvidence: ${proseLine(cp.evidence)}\nBlocker/owner: ${proseLine(cp.blocker ?? 'none')}\nNext action: ${proseLine(cp.next_action)}\nNext check-in: ${new Date(next).toISOString()}\nAppointment: ${cp.confirmation}`
      const requestId = cp.request_id ?? 'unrequested-checkpoint'
      if (!checkInReport(cp.request_id ? note : `Check-in request: ${requestId}\n${note}`, requestId)) throw new WorkflowError('invalid-checkpoint', 'Serialized checkpoint must satisfy the existing watchdog requirements for substantive progress/evidence and non-placeholder fields')
    } else if (input.kind === 'not_for_me') {
      if (!this.onChange) throw new WorkflowError('bridge-unavailable', 'The Firstmate workflow bridge is unavailable; the claim is retained.')
      if (!strictlyNeedsWill(card)) throw new WorkflowError('ask-changed', 'This card no longer has the same structured Will ask. Refresh before returning it.')
      const mate = responsibleMate(card, notes)
      if (!mate) throw new WorkflowError('mate-unknown', 'No responsible mate is declared in First Mate tasks or Last touched by. Firstmate must repair the route; the claim is retained.')
      transition(mate.owner, 'Waiting For')
      const remaining = currentWaits().filter(({ text, fields }) => !(text.startsWith('Will:') || fields.type === 'Actor' && fields.id === 'Will'))
      const returned = { type: 'Actor', id: mate.id, dependency: `Review the owner's not-for-me return: ${input.reason}`, unblocks_when: 'The responsible mate corrects the request or supplies the missing work', follow_up_by: mate.owner }
      editedWaits = [{ text: waitLine(returned), fields: returned }, ...remaining]
      set('Waiting For Type', 'Actor'); set('Waiting For ID', mate.id)
      set('Will action', [])
      set('Next check-in', new Date(checkInCeiling(Date.now())).toISOString())
      note += `\nNot for me: ${input.reason}\nReturned to: ${mate.id}\nPrevious Will ask: ${JSON.stringify(originalWaitText)}`
    } else if (input.kind === 'request_decision' || input.kind === 'answer_decision') {
      const publications = await this.proposals?.read(card.id, notes)
      const requests = (input.kind === 'answer_decision' ? decisionHistory(notes, publications) : decisionProposals(notes, publications)).filter(row => typeof row.id === 'string' && typeof row.action === 'string')
      const answered = new Set(decisionRecordRows(notes, 'Tin Star answer: '))
      const tags = card.properties['Will action']?.value
      if (!Array.isArray(tags)) throw new WorkflowError('unsupported-property', 'Will action must be a readable multi-select')
      if (input.kind === 'request_decision') {
        if (decisionRecordRows(notes, 'Tin Star request: ').some(row => row.id === input.request_id)) throw new WorkflowError('decision-conflict', 'This decision ID already exists; use a new ID for a new request')
        const fleet = input.source_request ? await this.fleet() : undefined
        const sourceRequestKey = input.proposal && input.source_request ? queueRequestKey(card, fleet!, input.source_request) : undefined
        if (input.proposal && (!input.source_request || !workProposalMatchesRequest(input.proposal, input.source_request, sourceRequestKey, card.id))) throw new WorkflowError('decision-conflict', 'Published proposal request_key must match its bound First Mate source request and canonical card')
        const related = requests.filter(row => row.action === input.action && !answered.has(row.id))
        const preserve = related.length ? related.some(row => row.preserve_action) : tags.includes(input.action)
        set('Will action', [...new Set([...tags, input.action])])
        const binding = input.source_request ? bindDecision(fleet!, input.source_request, card.id, await this.reader.query({}, true)) : {}
        note += `\n${decisionMarker(input.request_id)}\nRequested from: ${input.requested_from}\nQuestion: ${input.question}\n${workflowMarkers.request} ${JSON.stringify({ id: input.request_id, action: input.action, preserve_action: preserve, ...(input.options ? { options: input.options } : {}), ...(input.proposal ? { proposal: input.proposal, source_request_key: sourceRequestKey } : {}), ...binding })}`
      } else {
        let request = requests.find(row => row.id === input.request_id)
        if (!request && !decisionRecordRows(notes, 'Tin Star request: ').some(row => row.id === input.request_id) && (!answered.has(input.request_id) || input.source_request)) {
          // Older Notion asks retain their actual paragraph/comment identity.
          // The caller explicitly judges which aggregate action tag is resolved;
          // absent that judgment, leave every legacy action tag untouched.
          const source = notes.find(note => note.id === input.request_id) ?? (await this.content.sections(card.id)).find(block => block.id === input.request_id)
          if (source && source.text.trim()) {
            if (input.legacy_action && !tags.includes(input.legacy_action)) throw new WorkflowError('decision-conflict', 'The explicitly resolved legacy action tag is no longer present')
            request = { id: input.request_id, action: input.legacy_action ?? '', preserve_action: !input.legacy_action }
          }
        }
        const savedAnswers = notes.filter(note => decisionRecordRows([note], 'Tin Star answer: ').includes(input.request_id))
        const published = requests.find(row => row.id === input.request_id)
        if (!request || answered.has(input.request_id) && (!(published?.source_request || input.source_request) || savedAnswers.some(note => decisionAnswerText(note) !== input.answer))) throw new WorkflowError('decision-not-open', 'This specific recorded decision is absent or already answered; no other ask was cleared')
        if ((published?.source_request || input.source_request) && ['In Progress', 'Done', 'Archived'].includes(input.next.status)) throw new WorkflowError('decision-work-queued', 'Source decision approval queues implementation; start work separately with a real worker')
        if (input.source_request) {
          if (published?.source_request && requestKey(published.source_request) !== requestKey(input.source_request)) throw new WorkflowError('decision-conflict', 'This proposal is already bound to a different First Mate request')
          if (!published?.source_request) {
            const binding = bindDecision(await this.fleet(), input.source_request, card.id, await this.reader.query({}, true))
            answerBinding = { id: input.request_id, action: request.action, preserve_action: request.preserve_action, ...binding }
            note += `\n${decisionMarker(input.request_id)}\n${workflowMarkers.request} ${JSON.stringify(answerBinding)}`
          }
        }
        transition(input.next.owner, input.next.status)
        if (input.next.status === 'Waiting For') {
          if (!input.next.wait) throw new WorkflowError('wait-required', 'Entering Waiting For requires type, id, dependency, unblock condition, follow-up owner and a future Next check-in')
          await wait(input.next.wait)
        }
        resolveWait(input.resolve_wait, input.next.status)
        if (input.next.status === 'In Progress' && !heldWait) {
          if (!input.next.worker) throw new WorkflowError('worker-required', 'Returning to In Progress requires current tracked worker evidence; Queued is available without a worker')
          const start = await this.startPlan(card, { card_id: card.id, operation_id: input.operation_id, worker: input.next.worker }, actor)
          Object.assign(desired, start.desired); Object.assign(properties, start.properties)
          reads.add(input.next.worker.kind === 'firstmate' ? FIRST_MATE_TASKS : 'Delegated To')
        }
        if (['Done', 'Archived'].includes(input.next.status) && !heldWait) {
          if (!input.next.disposition || !input.next.evidence) throw new WorkflowError('disposition-required', 'Closing through a decision answer requires explicit supported disposition and evidence')
          note += `\nDisposition: ${input.next.disposition}\nEvidence: ${input.next.evidence}`
        }
        const action = request.action
        const others = requests.some(row => row.id !== input.request_id && row.action === action && !answered.has(row.id))
        set('Will action', request.preserve_action || others ? tags : tags.filter(tag => tag !== request.action))
        note += `\n${decisionMarker(input.request_id)}\n${workflowMarkers.answer} ${JSON.stringify(input.request_id)}\nAnswer: ${input.answer}\nNext owner: ${input.next.owner}\nNext status: ${input.next.status}\n${workflowMarkers.answerData} ${JSON.stringify({ request_id: input.request_id, answer: input.answer, option_id: input.option_id, legacy_action: input.legacy_action, next: input.next, resolve_wait: input.resolve_wait, binding: answerBinding })}`
      }
    } else if (input.kind === 'complete' || input.kind === 'park') {
      // Closing/corrective transitions remain possible on an imperfect old card.
      set('Status', input.kind === 'complete' ? 'Done' : input.status)
      note += `\nDisposition: ${input.disposition}${input.kind === 'complete' ? `\nEvidence: ${input.evidence}` : ''}`
    }
    if (editedWaits) {
      const primary = waitIdentity()
      set('Waiting For', editedWaits.map(entry => retainedWaitText(entry, primary)).join('\n'))
    }
    await this.validateWaitState(card, desired, 'resolve_wait' in input ? input.resolve_wait : undefined)
    for (const name of ['Status', 'Waiting For', 'Waiting For Type', 'Waiting For ID', 'Next check-in']) if (name in desired || 'Status' in desired) reads.add(name)
    set('Last touched by', actor)
    const sectionOriginal: Record<string, string> = {}
    if (Object.keys(sections).length) {
      const blocks = await this.content.sections(card.id)
      for (const name of Object.keys(sections)) sectionOriginal[name] = blocks.find(block => block.text.split('\n')[0] === sectionMarker(name))?.text ?? ''
    }
    const original = { ...input.expected, ...Object.fromEntries([...reads].map(name => [name, card.properties[name]?.value ?? null])) }
    return { desired, properties, original, sections, sectionOriginal, note, heldWait }
  }
  private matches(card: WorkCard, name: string, value: unknown) {
    const actual = card.properties[name]?.value ?? null
    if (card.properties[name]?.type === 'date' && value && actual) {
      const target = value as { start?: string; time_zone?: string }, saved = actual as typeof target
      return checkInTime(target.start ?? null, target.time_zone) === checkInTime(saved.start ?? null, saved.time_zone) &&
        (actual as { end?: string }).end == (value as { end?: string }).end
    }
    if (Array.isArray(value) && Array.isArray(actual)) return same([...value].sort(), [...actual].sort())
    return same(actual, value)
  }
  private async performUpdate(input: UpdateWorkInput, actor: string, prepared = false): Promise<StartWorkResult> {
    const key = JSON.stringify([actor, input.card_id, input.operation_id]), marker = receiptMarker(actor, input.operation_id)
    let attempted = false, card: WorkCard | undefined, contentBefore: WorkCard | undefined, notePending: string | undefined, heldWait = false
    let stage = 'read canonical card'
    let requested: Record<string, unknown> = {}
    const repair = this.noteRepairs.get(key)
    const saved: string[] = [...(repair?.result.saved_fields ?? [])]
    const result = (outcome: StartWorkResult['outcome'], code: string, message: string): StartWorkResult => ({ outcome, code, message, operation_id: input.operation_id, saved_fields: [...saved], ...(card ? { card } : {}) })
    try {
      card = await this.reader.card(input.card_id, true)
      if (card.source?.synthetic && 'source_request' in input && input.source_request) throw new WorkflowError('synthetic-source', 'Synthetic Jira decisions cannot deliver to live First Mate requests')
      const before = card
      stage = 'read card comments'
      const notes = await this.content.notes(card.id)
      stage = 'read decision publications'
      const publications = input.kind === 'answer_decision' ? await this.proposals?.read(card.id, notes) : undefined
      const intents = input.kind === 'answer_decision' ? decisionRecordRows(notes, 'Tin Star decision intent: ').flatMap(row => {
        const parsed = updateWorkSchema.safeParse(row.input)
        return parsed.success && parsed.data.kind === 'answer_decision' && parsed.data.card_id === input.card_id && parsed.data.request_id === input.request_id && typeof row.actor === 'string'
          ? [{ actor: row.actor as string, input: parsed.data }] : []
      }) : []
      const recorded = intents.length > 0 || input.kind === 'answer_decision' && notes.some(note => workflowReceipt(note) && decisionRecordRows([note], 'Tin Star answer data: ').some(row => row.request_id === input.request_id))
      const eligibleRequests = input.kind === 'answer_decision' ? recorded ? decisionHistory(notes, publications) : decisionProposals(notes, publications) : []
      if (input.kind === 'answer_decision' && decisionRecordRows(notes, 'Tin Star request: ').some(row => row.id === input.request_id && row.proposal) && !eligibleRequests.some(row => row.id === input.request_id)) throw new WorkflowError('decision-not-open', 'This proposal is no longer current')
      if (input.kind === 'answer_decision' && !recorded) {
        const published = eligibleRequests.find(row => row.id === input.request_id)
        const request = published?.source_request ?? input.source_request
        if (request) {
          // Refresh the census so a cached task link cannot authorize an answer
          // after that link was removed or a second card declared the same task.
          const live = bindDecision(await this.fleet(), request, card.id, await this.reader.query({}, true))
          if (published?.source_request && (published.source_question !== live.source_question || (published.source_spawn_gen ?? null) !== live.source_spawn_gen)) throw new DecisionSourceError('source request changed since publication; refresh before answering')
        }
      }
      if (input.kind === 'answer_decision' && input.option_id) {
        const proposals = eligibleRequests.filter(row => row.id === input.request_id)
        const options = proposals.length === 1 ? decisionOptionsSchema.safeParse(proposals[0].options) : null
        const option = options?.success ? options.data.find(option => option.id === input.option_id) : undefined
        // The identity must be current; the owner's words can qualify the choice.
        if (!option) throw new WorkflowError('decision-option-conflict', 'The selected option must exist in this published proposal; refresh its choices')
      }
      if (input.kind === 'answer_decision') {
        const first = intents[0]
        if (first) {
          const source = first.input.source_request ?? eligibleRequests.find(row => row.id === input.request_id)?.source_request
          const effects = decisionEffects(first.input, source)
          if (!same(effects, decisionEffects(input, source)) || intents.some(intent => !same(effects, decisionEffects(intent.input, source)))) throw new WorkflowError('decision-conflict', 'This proposal already has a different durable answer intent or effects')
          if (first.actor !== actor || first.input.operation_id !== input.operation_id) {
            const recovered = await this.performUpdate(first.input, first.actor, prepared)
            return { ...recovered, operation_id: input.operation_id }
          }
        }
      }
      const pendingMarker = `${workflowMarkers.decisionPending} ${JSON.stringify([actor, input.operation_id])}`
      const pending = decisionRecordRows(notes, 'Tin Star decision intent: ').find(row => row.actor === actor && row.input?.operation_id === input.operation_id)
      const receipt = notes.find(note => workflowNoteHasMarker(note, marker))
      if (input.kind === 'answer_decision' && eligibleRequests.some(row => row.id === input.request_id && row.source_request)) {
        const existing = notes.find(note => decisionRecordRows([note], 'Tin Star answer: ').includes(input.request_id) && workflowReceipt(note))
        if (existing) {
          const data = decisionRecordRows([existing], 'Tin Star answer data: ')[0]
          const proposal = eligibleRequests.find(row => row.id === input.request_id)
          const intent = decisionRecordRows(notes, 'Tin Star decision intent: ').find(row => row.input?.request_id === input.request_id && row.input?.answer === data?.answer)
          if (input.source_request && requestKey(proposal.source_request) !== requestKey(input.source_request)) throw new WorkflowError('decision-conflict', 'This proposal is already bound to a different First Mate request')
          if (!data || data.answer !== input.answer || !same(data.next, input.next) || data.resolve_wait !== input.resolve_wait || data.option_id !== input.option_id || (data.legacy_action ?? intent?.input?.legacy_action) !== input.legacy_action) throw new WorkflowError('decision-conflict', 'This proposal already has a different durable answer or next state')
          return { ...result('saved', 'already-saved', 'This exact proposal answer is already recorded; no comment or property changes replayed'), saved_fields: ['note'] }
        }
      }
      if (receipt) {
        this.noteRepairs.delete(key)
        this.reader.confirm(card)
        await this.changed({ kind: input.kind, card, actor, operationId: input.operation_id, properties: {}, notes: [receipt.text] })
        return { ...result('saved', 'already-saved', 'This operation is already recorded; no changes replayed'), saved_fields: [...(repair?.result.saved_fields ?? []), 'note'] }
      }
      if (repair) {
        if (repair.signature !== JSON.stringify(input)) throw new WorkflowError('operation-conflict', 'operation_id was used with different input', true)
        if (cardVersion(card) !== repair.version) {
          this.noteRepairs.delete(key)
          return { ...result('partially-saved', 'card-changed', 'Previously listed steps saved; the card changed since that partial write. Nothing else submitted. Review current state and re-issue with a new operation_id.'), requires_new_operation_id: true }
        }
        contentBefore = card
        notePending = repair.note
      } else {
        if (!pending && input.expected && Object.entries(input.expected).some(([name, value]) => !this.matches(card!, name, value))) throw new WorkflowError('conflict', 'A requested precondition changed; refresh and re-issue with a new operation_id', true)
        if (pending && JSON.stringify(pending.input) !== JSON.stringify(input)) throw new WorkflowError('operation-conflict', 'operation_id was used with different input', true)
        const planningCard = pending ? { ...card, properties: Object.fromEntries(Object.entries(card.properties).map(([name, property]) => [name,
          name in pending.original ? { ...property, value: pending.original[name] } : property])) } : card
        // Rebuild policy from validated input; a human-editable note never
        // supplies a raw PATCH plan or bypasses tracked-worker requirements.
        stage = `plan ${input.kind}`
        const plan = await this.updatePlan(planningCard, input, actor, notes)
        heldWait = plan.heldWait
        if (card.source?.provider === 'jira') this.reader.jira?.validateProperties(plan.properties)
        this.reader.leases?.assertWritable(card.id)
        requested = plan.desired
        stage = 'read card before applying changes'
        const current = await this.reader.card(card.id, true)
        for (const [name, value] of Object.entries(plan.original)) {
          if (name !== 'Last touched by' && !this.matches(current, name, value) && !(pending && this.matches(current, name, plan.desired[name]))) throw new WorkflowError('conflict', `${name} changed during this operation; unrelated work was preserved. Refresh and re-issue with a new operation_id.`, true)
        }
        card = current
        if (!pending && input.kind === 'answer_decision' && (input.source_request || notes.some(note => note.text.includes('"source_request":')))) {
          attempted = true
          await this.content.note(card.id, `${workflowMarkers.decisionIntent} ${JSON.stringify({ actor, input, original: plan.original })}`, pendingMarker)
          saved.push('decision-answer')
        }
        const missing = Object.fromEntries(Object.entries(plan.properties).filter(([name]) => !this.matches(current, name, plan.desired[name])))
        if (Object.keys(missing).length) {
          attempted = true
          const recheck = prepared ? async () => {
            const latest = await this.reader.card(input.card_id, true)
            for (const name of Object.keys(missing)) {
              if (name !== 'Last touched by' && !this.matches(latest, name, plan.original[name]) && !this.matches(latest, name, plan.desired[name])) throw new WorkflowError('conflict', `${name} changed before the reserved answer write; unrelated work was preserved`)
            }
            return Object.keys(missing).every(name => this.matches(latest, name, plan.desired[name]))
          } : undefined
          stage = 'write card properties'
          const patched = await this.content.patchProperties(card.id, missing, recheck)
          card = card.source?.provider === 'jira' ? patched as WorkCard : await this.reader.card(card.id, true)
        }
        this.reader.confirm(card)
        saved.push(...Object.keys(plan.desired).filter(name => this.matches(card!, name, plan.desired[name])))
        await this.changed({ kind: input.kind, before, card, actor, operationId: input.operation_id, properties: Object.fromEntries(Object.keys(plan.desired).filter(name => saved.includes(name)).map(name => [name, card!.properties[name]?.value])) })
        if (Object.keys(plan.desired).some(name => !this.matches(card!, name, plan.desired[name]))) return { ...result('partially-saved', 'readback-mismatch', 'Only listed properties confirmed saved. Review current state and re-issue with a new operation_id; no properties will be replayed.'), requires_new_operation_id: true }
        contentBefore = card
        for (const [name, text] of Object.entries(plan.sections)) {
          attempted = true
          await this.content.section(card.id, name, text, plan.sectionOriginal[name])
          saved.push(name)
          await this.changed({ kind: input.kind, before: card, card, actor, operationId: input.operation_id, properties: {}, sections: [name], sectionTexts: [sectionText(name, text)] })
        }
        card = await this.reader.card(card.id, true)
        notePending = plan.note
      }
      attempted = true
      stage = 'write workflow receipt'
      await this.content.note(card.id, notePending, marker)
      saved.push('note')
      this.noteRepairs.delete(key)
      card = await this.reader.card(card.id, true); this.reader.confirm(card)
      await this.changed({ kind: input.kind, before: contentBefore, card, actor, operationId: input.operation_id, properties: {}, notes: [notePending] })
      return result('saved', heldWait ? 'wait-remains' : 'saved', heldWait
        ? 'The named wait was resolved, but another independent wait remains, so status stayed Waiting For. Other asks, tags and worker history were preserved.'
        : 'Workflow changes and history saved and confirmed')
    } catch (error) {
      if (error instanceof CardLeaseError) return result(saved.length ? 'partially-saved' : 'not-saved', error.lease ? 'card-held' : 'claim-lost', error.message)
      if (card?.source?.provider === 'jira' && attempted) {
        const current = await this.reader.card(card.id, true).catch(() => undefined)
        if (current) {
          card = current; this.reader.confirm(current)
          if (!(error instanceof JiraMappingError) && !(error instanceof JiraWriteError && error.method !== 'GET' && error.status < 500 && !error.partial)) saved.push(...Object.keys(requested).filter(name => !saved.includes(name) && this.matches(current, name, requested[name])))
        }
      }
      if (error instanceof DecisionSourceError) return result('not-saved', 'decision-verification-needed', error.message)
      if (error instanceof ManagedSectionConflict || error instanceof JiraConflictError) return { ...result(saved.length ? 'partially-saved' : 'not-saved', 'conflict', `${error.message}. Review current state and re-issue with a new operation_id.`), requires_new_operation_id: true }
      if (error instanceof JiraMappingError) return result('not-saved', 'jira-incompatible', error.message)
      if (error instanceof JiraWriteError && error.method !== 'GET' && error.status < 500 && !error.partial && !saved.length) return result('not-saved', 'jira-rejected', `Jira rejected the request (HTTP ${error.status})`)
      if (error instanceof NotionWriteError && error.method !== 'GET' && error.status < 500 && !saved.length) return result('not-saved', 'notion-rejected', `Notion rejected the write (HTTP ${error.status}); no fields confirmed saved`)
      const cause = workReadback(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 1000)
      if (!(error instanceof WorkflowError)) console.error('[workflow] update failed', workReadback({ card_id: input.card_id, operation_id: input.operation_id, kind: input.kind, stage,
        cause, stack: error instanceof Error ? error.stack?.slice(0, 6000) : undefined }))
      const partial = error instanceof WorkflowError ? { ...result(saved.length ? 'partially-saved' : 'not-saved', error.code, error.message), ...(error.requiresNewOperationId ? { requires_new_operation_id: true } : {}) }
        : result(attempted || saved.length ? 'partially-saved' : 'not-saved', attempted || saved.length ? 'save-unconfirmed' : 'source-unavailable',
          notePending ? `Listed steps saved; note unconfirmed during ${stage} (${cause}). This process can repair only the note if the card stays unchanged. Otherwise review and re-issue with a new operation_id.`
            : saved.length ? `Listed steps previously saved; ${stage} failed (${cause}). No further write submitted.` : attempted ? `Write unconfirmed during ${stage} (${cause}); only listed steps are confirmed saved. Read current state to reconcile this uncertain write; no automatic replay.` : `Current source read failed during ${stage} (${cause}); nothing submitted`)
      if (notePending && card && !saved.includes('note')) this.noteRepairs.set(key, { signature: JSON.stringify(input), version: cardVersion(card), note: notePending, result: partial })
      return partial
    }
  }
  private async findCreation(actor: string, operationId: string, name: string, provider?: CreateWorkInput['provider']): Promise<WorkCard | undefined> {
    if (provider === 'jira') {
      if (!this.reader.jira) throw new Error('Jira is not configured')
      const result = await this.reader.jira.list()
      if (result.hasMore) throw new WorkflowError('create-scope-incomplete', 'Jira creation search is incomplete')
      const matches: WorkCard[] = []
      for (const card of result.cards) if ((await this.content.sections(card.id)).some(section => workflowNoteHasMarker(section, receiptMarker(actor, operationId)))) matches.push(card)
      if (matches.length > 1) throw new WorkflowError('create-conflict', 'Multiple Jira issues have this creation receipt; inspect them before continuing')
      return matches[0]
    }
    const config = this.reader.config
    if (!config) throw new Error('Not configured')
    const marker = receiptMarker(actor, operationId)
    let cursor: string | undefined
    const cursors = new Set<string>()
    for (;;) {
      const candidates = await this.content.request(`data_sources/${config.dataSourceId}/query`, 'POST', { page_size: 100, filter: { property: 'Name', title: { equals: name } }, ...(cursor ? { start_cursor: cursor } : {}) })
      if (!Array.isArray(candidates.results)) throw new WorkflowError('create-scope-incomplete', 'Creation search is incomplete; cannot safely deduplicate creation')
      for (const raw of candidates.results) {
        const candidate = notionCard(raw)
        if ((await this.content.sections(candidate.id)).some(section => workflowNoteHasMarker(section, marker))) return candidate
      }
      if (candidates.has_more === false) return
      const nextCursor = candidates.next_cursor
      if (candidates.has_more !== true || typeof nextCursor !== 'string' || !nextCursor || cursors.has(nextCursor)) throw new WorkflowError('create-scope-incomplete', 'Creation search is incomplete; cannot safely deduplicate creation')
      cursor = nextCursor
      cursors.add(nextCursor)
    }
  }
  private async jiraCreationReadback(card: WorkCard, input: CreateWorkInput, actor: string, handoff?: { properties: Record<string, unknown>; children?: WorkflowCreateBlock[] }): Promise<StartWorkResult> {
    const values = { ...input.properties, Name: input.name, Owner: input.owner, Area: input.area, Status: input.owner.toLowerCase() === 'firstmate' ? 'Queued' : input.status, 'Last touched by': actor, ...handoff?.properties }
    const fields = Object.entries(values).filter(([name, value]) => this.matches(card, name, this.normalized(card, name, value))).map(([name]) => name)
    const sections = await this.content.sections(card.id, true)
    const children = handoff?.children ?? Object.entries(input.content ?? {}).map(([name, value]) => paragraph(sectionText(name, value)))
    const complete = fields.length === Object.keys(values).length && children.every(child => sections.some(section => section.text === createBlockText(child)))
    return { outcome: complete ? 'saved' : 'partially-saved', code: complete ? 'already-saved' : 'readback-mismatch', message: complete ? 'Existing Jira creation and content confirmed' : 'Existing Jira issue found; only listed fields confirmed. Correct this same issue explicitly; creation was not replayed.', operation_id: input.operation_id, saved_fields: ['card', ...fields], card }
  }
  private async performCreate(input: CreateWorkInput, actor: string, handoff?: { signature: string; properties: Record<string, unknown>; children?: WorkflowCreateBlock[] }): Promise<StartWorkResult> {
    let attempted = false, card: WorkCard | undefined
    const saved: string[] = []
    const marker = receiptMarker(actor, input.operation_id), key = JSON.stringify(input.provider === 'jira' ? [actor, 'jira', input.operation_id] : [actor, input.operation_id]), signature = handoff?.signature ?? JSON.stringify(input)
    const result = (outcome: StartWorkResult['outcome'], code: string, message: string, saved_fields: string[] = saved): StartWorkResult => ({ outcome, code, message, operation_id: input.operation_id, saved_fields, ...(card ? { card } : {}) })
    try {
      const config = this.reader.config
      if (input.provider === 'jira' ? !this.reader.jira : !config) throw new Error('Requested provider is not configured')
      const previous = await this.creations.get(key)
      if (previous && previous.input !== signature) throw new WorkflowError('operation-conflict', 'operation_id was used with different creation input')
      if (previous?.cardId) {
        saved.push('card'); card = await this.reader.card(previous.cardId, true); this.reader.confirm(card)
        if (input.provider === 'jira') return this.jiraCreationReadback(card, input, actor, handoff)
        return result('saved', 'already-saved', 'Card creation previously confirmed; current card returned', ['card'])
      }
      const candidate = await this.findCreation(actor, input.operation_id, input.name, input.provider)
      if (candidate) {
        card = candidate; saved.push('card')
        await this.creations.put(key, signature, card.id)
        card = await this.reader.card(candidate.id, true); this.reader.confirm(card)
        await this.changed({ card, actor, operationId: input.operation_id, properties: {} })
        if (input.provider === 'jira') return this.jiraCreationReadback(card, input, actor, handoff)
        return result('saved', 'already-saved', 'Card creation already saved', ['card'])
      }
      if (previous) return result('partially-saved', 'create-unconfirmed', 'An earlier creation is unconfirmed and its receipt is not visible in the current name search. Reconcile that card before using a new operation_id; this retry will not create a duplicate.')
      const schema = input.provider === 'jira' ? this.reader.jira!.schema() : await this.content.request(`data_sources/${config!.dataSourceId}`)
      const template = { properties: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) => [name, { type: (value as { type: string }).type }])) } as WorkCard
      const values = { ...input.properties, Name: input.name, Owner: input.owner, Area: input.area,
        Status: input.owner.toLowerCase() === 'firstmate' ? 'Queued' : input.status, 'Last touched by': actor, ...handoff?.properties }
      const properties = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, this.property(template, name, value)]))
      const children = [paragraph(`Created by: ${actor}\n${marker}`), ...(handoff?.children ?? Object.entries(input.content ?? {}).map(([name, value]) => paragraph(sectionText(name, value))))]
      const beforeWrite = async () => {
        await this.creations.put(key, signature)
        attempted = true
      }
      if (input.provider !== 'jira') await beforeWrite()
      let created: Awaited<ReturnType<WorkflowContent['request']>>
      try {
        created = input.provider === 'jira' ? await this.reader.jira!.create(properties, children.map(child => ({ type: child.type, text: createBlockText(child) })), beforeWrite) : await this.content.request('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: config!.dataSourceId }, properties, children })
      } catch (error) {
        if (error instanceof NotionWriteError && error.status < 500) {
          await this.creations.remove(key)
          return result('not-saved', 'notion-rejected', `Notion rejected creation (HTTP ${error.status})`)
        }
        throw error
      }
      card = input.provider === 'jira' ? created as WorkCard : notionCard(created)
      saved.push('card')
      await this.creations.put(key, signature, card.id)
      card = await this.reader.card(card.id, true); this.reader.confirm(card)
      const fields = Object.keys(values).filter(name => this.matches(card!, name, this.normalized(card!, name, values[name as keyof typeof values])))
      saved.push(...fields)
      const sections = await this.content.sections(card.id, true)
      const complete = fields.length === Object.keys(values).length && children.every(child => sections.some(section => section.type === child.type && section.text === createBlockText(child)))
      await this.changed({ card, actor, operationId: input.operation_id, properties: Object.fromEntries(fields.map(name => [name, card!.properties[name]?.value])), sections: Object.keys(input.content ?? {}), sectionTexts: children.map(createBlockText) })
      return result(complete ? 'saved' : 'partially-saved', complete ? 'saved' : 'readback-mismatch', complete ? 'Card and content created and confirmed' : 'Card created; only listed properties confirmed; refresh this card before correction', ['card', ...fields])
    } catch (error) {
      if (error instanceof CardLeaseError) return result(saved.length ? 'partially-saved' : 'not-saved', error.lease ? 'card-held' : 'claim-lost', error.message, saved)
      if (error instanceof WorkflowError) return result(saved.length ? 'partially-saved' : 'not-saved', error.code, error.message)
      if (error instanceof JiraMappingError && !attempted) return result('not-saved', 'jira-incompatible', error.message)
      return result(attempted || saved.length ? 'partially-saved' : 'not-saved', attempted || saved.length ? 'create-unconfirmed' : 'source-unavailable', saved.length ? 'Card created; only listed steps confirmed saved. Current verification failed; retry identical input to retrieve the existing card.' : attempted ? 'Creation submitted but unconfirmed; retry identical input to find its receipt before creating again' : 'Current source unavailable; card not created')
    }
  }

}
