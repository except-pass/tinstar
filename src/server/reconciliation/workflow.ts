import { checkInReport } from './checkInWatchdog'
import { startWorkSchema, updateWorkSchema, createWorkSchema, type UpdateWorkInput, type CreateWorkInput, type StartWorkInput, type StartWorkResult } from '../../shared/workflow'
import { codexTurn } from '../../shared/codexActivity'
import { FIRST_MATE_TASKS, isBlankWorkerLinks, workerLinkRecord } from './workerLinks'
import { checkInTime, checkInCeiling } from '../../shared/checkIn'
import { WorkflowContent, ManagedSectionConflict, NotionWriteError, richText, paragraph, receiptMarker, decisionMarker, sectionMarker, sectionText } from './workflowContent'
import { CreationReceipts } from './workflowReceipts'
import { notionCard } from './notion'
import type { SourceSnapshot } from './index'
import type { WorkReader, WorkCard } from './workReader'

const relevant = (card: WorkCard, kind: StartWorkInput['worker']['kind']) => ({ owner: card.properties.Owner?.value ?? null, status: card.properties.Status?.value ?? null,
  ...(kind === 'firstmate' ? { worker_links: card.properties[FIRST_MATE_TASKS]?.value ?? null } : { external_workers: card.properties['Delegated To']?.value ?? null }), area: card.properties.Area?.value ?? null })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const cardVersion = (card: WorkCard) => JSON.stringify([card.last_edited_time, card.properties, card.archived, card.in_trash])

/** Shared per-card policy/mutation path for UI, MCP and coordinator updates. */
class WorkflowError extends Error { constructor(readonly code: string, message: string, readonly requiresNewOperationId = false) { super(message) } }
export interface WorkflowChange { before?: WorkCard; card: WorkCard; actor: string; operationId: string; properties: Record<string, unknown>; notes?: string[]; sections?: string[]; sectionTexts?: string[] }
export class WorkflowOperations {
  onChange?: (change: WorkflowChange) => Promise<void>
  private content: WorkflowContent
  private creations: CreationReceipts
  private noteRepairs = new Map<string, { signature: string; version: string; note: string; result: StartWorkResult }>()
  private locks = new Map<string, Promise<unknown>>()
  private receipts = new Map<string, { input: string; until: number; result: Promise<StartWorkResult> }>()
  constructor(private reader: WorkReader, private fleet: () => Promise<SourceSnapshot['fleet']>, receiptRoot?: string) { this.content = new WorkflowContent(reader); this.creations = new CreationReceipts(receiptRoot) }
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
    void result.then(value => { if (value.outcome === 'not-saved' || value.outcome === 'partially-saved' && !('kind' in input)) this.receipts.delete(key) }).catch(() => this.receipts.delete(key))
    return result
  }
  private async changed(change: WorkflowChange) { await this.onChange?.(change).catch(() => {}) }

  start(input: StartWorkInput, actor: string): Promise<StartWorkResult> {
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
      const { properties } = plan
      desired = plan.desired
      fields = Object.keys(desired)
      // Compare only fields used to validate/build this operation, not unrelated
      // edits or Last edited time. Direct edits can still race Notion PATCH.
      const current = await this.reader.card(input.card_id, true)
      if (!same(relevant(current, input.worker.kind), initial)) return result('not-saved', 'conflict', 'Relevant card properties changed during validation; read and retry', current)
      if (fields.every(field => same(current.properties[field]?.value, desired[field]))) { this.reader.confirm(current); await this.changed({ before: card, card: current, actor, operationId: input.operation_id, properties: {} }); return result('saved', 'already-saved', 'Start work already saved', current, fields) }
      const config = this.reader.config!
      attempted = true
      const response = await this.reader.api.fetch(`https://api.notion.com/v1/pages/${input.card_id}`, { method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${config.token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: Object.fromEntries(Object.entries(properties).filter(([field]) => !same(current.properties[field]?.value, desired[field]))) }) })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status < 500) return result('not-saved', 'notion-rejected', `Notion rejected start work (HTTP ${response.status}); nothing confirmed saved`)
      } else await response.body?.cancel()
      const saved = await this.reader.card(input.card_id, true)
      this.reader.confirm(saved)
      await this.changed({ before: card, card: saved, actor, operationId: input.operation_id, properties: Object.fromEntries(fields.filter(field => same(saved.properties[field]?.value, desired[field])).map(field => [field, desired[field]])) })
      const savedFields = fields.filter(field => same(saved.properties[field]?.value, desired[field]))
      return savedFields.length === fields.length ? result('saved', 'saved', 'Start work saved and confirmed', saved, savedFields)
        : result('partially-saved', 'readback-mismatch', 'Readback differs from the requested start; only listed fields are confirmed. Read the card and retry.', saved, savedFields)
    } catch (error) {
      if (error instanceof WorkflowError && !attempted) return result('not-saved', error.code, error.message)
      return result(attempted ? 'partially-saved' : 'not-saved', attempted ? 'save-unconfirmed' : 'source-unavailable', attempted
        ? 'Start work was submitted but readback could not be confirmed. Refresh and retry the same operation; no offline write is queued.'
        : 'Current source read failed; start work was not submitted')
    }
  }
  update(input: UpdateWorkInput, actor: string): Promise<StartWorkResult> {
    const parsed = updateWorkSchema.safeParse(input)
    if (!parsed.success) return Promise.resolve({ outcome: 'not-saved', code: 'invalid-input', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), operation_id: input?.operation_id ?? '', saved_fields: [] })
    return this.serialize(parsed.data.card_id, parsed.data, actor, () => this.performUpdate(parsed.data, actor))
  }
  create(input: CreateWorkInput, actor: string): Promise<StartWorkResult> {
    const parsed = createWorkSchema.safeParse(input)
    if (!parsed.success) return Promise.resolve({ outcome: 'not-saved', code: 'invalid-input', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), operation_id: input?.operation_id ?? '', saved_fields: [] })
    return this.serialize('create', parsed.data, actor, () => this.performCreate(parsed.data, actor))
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
  private async updatePlan(card: WorkCard, input: UpdateWorkInput, actor: string, notes: Awaited<ReturnType<WorkflowContent['notes']>>) {
    const desired: Record<string, unknown> = {}, properties: Record<string, unknown> = {}, sections: Record<string, string> = {}
    const reads = new Set<string>(), at = new Date().toISOString()
    let note = `Date: ${at}\nBy: ${actor}\nOperation: ${input.kind}`
    const set = (name: string, value: unknown) => { reads.add(name); properties[name] = this.property(card, name, value); desired[name] = this.normalized(card, name, value) }
    const transition = (owner: string, status: string) => {
      reads.add('Owner'); reads.add('Status'); reads.add('Area')
      this.required(card, owner)
      if (owner.toLowerCase() === 'firstmate' && input.kind === 'assign') status = 'Queued'
      set('Owner', owner); set('Status', status)
    }
    const wait = (value: { dependency: string; unblocks_when: string; follow_up_by: string }) => {
      const old = String(desired['Waiting For'] ?? card.properties['Waiting For']?.value ?? '')
      const entryText = (text: string) => /[\r\n]/.test(text) ? JSON.stringify(text) : text
      const line = `Dependency: ${entryText(value.dependency)} | Unblocks when: ${entryText(value.unblocks_when)} | Follow-up: ${entryText(value.follow_up_by)}`
      set('Waiting For', old.split('\n').includes(line) ? old : [old, line].filter(Boolean).join('\n'))
      note += `\n${line}`
    }
    if (input.kind === 'edit') {
      for (const [name, value] of Object.entries(input.properties ?? {})) set(name, value)
      Object.assign(sections, input.content)
      if (input.note) note += `\n${input.note}`
    } else if (input.kind === 'assign') {
      transition(input.owner, input.status)
      if (input.note) note += `\nHandoff: ${input.note}`
    } else if (input.kind === 'wait') {
      transition(String(card.properties.Owner?.value ?? ''), 'Waiting For')
      wait(input)
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
    } else if (input.kind === 'request_decision' || input.kind === 'answer_decision') {
      const requests = notes.flatMap(note => note.text.split('\n').filter(line => line.startsWith('Tin Star request: ')).flatMap(line => {
        try { const row = JSON.parse(line.slice('Tin Star request: '.length)); return typeof row.id === 'string' && typeof row.action === 'string' ? [row as { id: string; action: string; preserve_action: boolean }] : [] } catch { return [] }
      }))
      const answered = new Set(notes.flatMap(note => note.text.split('\n').filter(line => line.startsWith('Tin Star answer: ')).flatMap(line => { try { return [JSON.parse(line.slice('Tin Star answer: '.length))] } catch { return [] } })))
      const tags = card.properties['Will action']?.value
      if (!Array.isArray(tags)) throw new WorkflowError('unsupported-property', 'Will action must be a readable multi-select')
      if (input.kind === 'request_decision') {
        if (requests.some(row => row.id === input.request_id)) throw new WorkflowError('decision-conflict', 'This decision ID already exists; use a new ID for a new request')
        const related = requests.filter(row => row.action === input.action && !answered.has(row.id))
        const preserve = related.length ? related.some(row => row.preserve_action) : tags.includes(input.action)
        set('Will action', [...new Set([...tags, input.action])])
        note += `\n${decisionMarker(input.request_id)}\nRequested from: ${input.requested_from}\nQuestion: ${input.question}\nTin Star request: ${JSON.stringify({ id: input.request_id, action: input.action, preserve_action: preserve })}`
      } else {
        let request = requests.find(row => row.id === input.request_id)
        if (!request && !answered.has(input.request_id)) {
          // Older Notion asks retain their actual paragraph/comment identity.
          // The caller explicitly judges which aggregate action tag is resolved;
          // absent that judgment, leave every legacy action tag untouched.
          const source = notes.find(note => note.id === input.request_id) ?? (await this.content.sections(card.id)).find(block => block.id === input.request_id)
          if (source && source.text.trim()) {
            if (input.legacy_action && !tags.includes(input.legacy_action)) throw new WorkflowError('decision-conflict', 'The explicitly resolved legacy action tag is no longer present')
            request = { id: input.request_id, action: input.legacy_action ?? '', preserve_action: !input.legacy_action }
          }
        }
        if (!request || answered.has(input.request_id)) throw new WorkflowError('decision-not-open', 'This specific recorded decision is absent or already answered; no other ask was cleared')
        transition(input.next.owner, input.next.status)
        if (input.next.status === 'In Progress') {
          if (!input.next.worker) throw new WorkflowError('worker-required', 'Returning to In Progress requires current tracked worker evidence; Queued is available without a worker')
          const start = await this.startPlan(card, { card_id: card.id, operation_id: input.operation_id, worker: input.next.worker }, actor)
          Object.assign(desired, start.desired); Object.assign(properties, start.properties)
          reads.add(input.next.worker.kind === 'firstmate' ? FIRST_MATE_TASKS : 'Delegated To')
        }
        if (['Done', 'Archived'].includes(input.next.status)) {
          if (!input.next.disposition || !input.next.evidence) throw new WorkflowError('disposition-required', 'Closing through a decision answer requires explicit supported disposition and evidence')
          note += `\nDisposition: ${input.next.disposition}\nEvidence: ${input.next.evidence}`
        }
        if (input.next.status === 'Waiting For') {
          if (!input.next.wait) throw new WorkflowError('wait-required', 'Entering Waiting For requires dependency, unblock condition and follow-up owner')
          wait(input.next.wait)
        }
        const action = request.action
        const others = requests.some(row => row.id !== input.request_id && row.action === action && !answered.has(row.id))
        set('Will action', request.preserve_action || others ? tags : tags.filter(tag => tag !== request.action))
        if (input.resolve_wait) {
          const old = String(desired['Waiting For'] ?? card.properties['Waiting For']?.value ?? '')
          const entries = old.split('\n'), resolved = input.resolve_wait
          if (entries.filter(entry => entry === resolved).length !== 1) throw new WorkflowError('wait-conflict', 'The explicitly resolved wait must match one current wait; refresh and retry')
          set('Waiting For', entries.filter(entry => entry !== resolved).join('\n'))
        }
        note += `\n${decisionMarker(input.request_id)}\nTin Star answer: ${JSON.stringify(input.request_id)}\nAnswer: ${input.answer}\nNext owner: ${input.next.owner}\nNext status: ${input.next.status}`
      }
    } else if (input.kind === 'complete' || input.kind === 'park') {
      // Closing/corrective transitions remain possible on an imperfect old card.
      set('Status', input.kind === 'complete' ? 'Done' : input.status)
      note += `\nDisposition: ${input.disposition}${input.kind === 'complete' ? `\nEvidence: ${input.evidence}` : ''}`
    }
    set('Last touched by', actor)
    const sectionOriginal: Record<string, string> = {}
    if (Object.keys(sections).length) {
      const blocks = await this.content.sections(card.id)
      for (const name of Object.keys(sections)) sectionOriginal[name] = blocks.find(block => block.text.split('\n')[0] === sectionMarker(name))?.text ?? ''
    }
    const original = { ...input.expected, ...Object.fromEntries([...reads].map(name => [name, card.properties[name]?.value ?? null])) }
    return { desired, properties, original, sections, sectionOriginal, note }
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
  private async performUpdate(input: UpdateWorkInput, actor: string): Promise<StartWorkResult> {
    const key = JSON.stringify([actor, input.card_id, input.operation_id]), marker = receiptMarker(actor, input.operation_id)
    let attempted = false, card: WorkCard | undefined, contentBefore: WorkCard | undefined, notePending: string | undefined
    const repair = this.noteRepairs.get(key)
    const saved: string[] = [...(repair?.result.saved_fields ?? [])], sections: string[] = [], sectionTexts: string[] = []
    const result = (outcome: StartWorkResult['outcome'], code: string, message: string): StartWorkResult => ({ outcome, code, message, operation_id: input.operation_id, saved_fields: [...saved], ...(card ? { card } : {}) })
    try {
      card = await this.reader.card(input.card_id, true)
      const before = card, notes = await this.content.notes(card.id)
      const receipt = notes.find(note => note.text.split('\n').includes(marker))
      if (receipt) {
        this.noteRepairs.delete(key)
        this.reader.confirm(card)
        await this.changed({ card, actor, operationId: input.operation_id, properties: {}, notes: [receipt.text] })
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
        if (input.expected && Object.entries(input.expected).some(([name, value]) => !this.matches(card!, name, value))) throw new WorkflowError('conflict', 'A requested precondition changed; refresh and re-issue with a new operation_id', true)
        const plan = await this.updatePlan(card, input, actor, notes)
        const current = await this.reader.card(card.id, true)
        for (const [name, value] of Object.entries(plan.original)) {
          if (name !== 'Last touched by' && !this.matches(current, name, value)) throw new WorkflowError('conflict', `${name} changed during this operation; unrelated work was preserved. Refresh and re-issue with a new operation_id.`, true)
        }
        card = current
        const missing = Object.fromEntries(Object.entries(plan.properties).filter(([name]) => !this.matches(current, name, plan.desired[name])))
        if (Object.keys(missing).length) {
          attempted = true
          await this.content.request(`pages/${card.id}`, 'PATCH', { properties: missing })
          card = await this.reader.card(card.id, true)
        }
        this.reader.confirm(card)
        saved.push(...Object.keys(plan.desired).filter(name => this.matches(card!, name, plan.desired[name])))
        await this.changed({ before, card, actor, operationId: input.operation_id, properties: Object.fromEntries(saved.map(name => [name, card!.properties[name]?.value])) })
        if (saved.length !== Object.keys(plan.desired).length) return { ...result('partially-saved', 'readback-mismatch', 'Only listed properties confirmed saved. Review current state and re-issue with a new operation_id; no properties will be replayed.'), requires_new_operation_id: true }
        contentBefore = card
        for (const [name, text] of Object.entries(plan.sections)) {
          attempted = true
          await this.content.section(card.id, name, text, plan.sectionOriginal[name])
          saved.push(name); sections.push(name); sectionTexts.push(sectionText(name, text))
        }
        card = await this.reader.card(card.id, true)
        notePending = plan.note
      }
      attempted = true
      await this.content.note(card.id, notePending, marker)
      saved.push('note')
      this.noteRepairs.delete(key)
      card = await this.reader.card(card.id, true); this.reader.confirm(card)
      await this.changed({ before: contentBefore, card, actor, operationId: input.operation_id, properties: {}, notes: [notePending], sections, sectionTexts })
      return result('saved', 'saved', 'Workflow changes and history saved and confirmed')
    } catch (error) {
      if (error instanceof ManagedSectionConflict) return { ...result(saved.length ? 'partially-saved' : 'not-saved', 'conflict', `${error.message}. Review current state and re-issue with a new operation_id.`), requires_new_operation_id: true }
      if (error instanceof NotionWriteError && error.status < 500 && !saved.length) return result('not-saved', 'notion-rejected', `Notion rejected the write (HTTP ${error.status}); no fields confirmed saved`)
      const partial = error instanceof WorkflowError ? { ...result(saved.length ? 'partially-saved' : 'not-saved', error.code, error.message), ...(error.requiresNewOperationId ? { requires_new_operation_id: true } : {}) }
        : result(attempted || saved.length ? 'partially-saved' : 'not-saved', attempted || saved.length ? 'save-unconfirmed' : 'source-unavailable',
          notePending ? 'Listed steps saved; note unconfirmed. This process can repair only the note if the card stays unchanged. Otherwise review and re-issue with a new operation_id.'
            : saved.length ? 'Listed steps previously saved; current source read failed. No further write submitted.' : attempted ? 'Write unconfirmed; only listed steps are confirmed saved. Read current state to reconcile this uncertain write; no automatic replay.' : 'Current source read failed; nothing submitted')
      if (notePending && card && !saved.includes('note')) this.noteRepairs.set(key, { signature: JSON.stringify(input), version: cardVersion(card), note: notePending, result: partial })
      return partial
    }
  }
  private async performCreate(input: CreateWorkInput, actor: string): Promise<StartWorkResult> {
    let attempted = false, card: WorkCard | undefined
    const marker = receiptMarker(actor, input.operation_id), key = JSON.stringify([actor, input.operation_id]), signature = JSON.stringify(input)
    const result = (outcome: StartWorkResult['outcome'], code: string, message: string, saved_fields: string[] = []): StartWorkResult => ({ outcome, code, message, operation_id: input.operation_id, saved_fields, ...(card ? { card } : {}) })
    try {
      const config = this.reader.config
      if (!config) throw new Error('Not configured')
      const previous = await this.creations.get(key)
      if (previous && previous.input !== signature) throw new WorkflowError('operation-conflict', 'operation_id was used with different creation input')
      if (previous?.cardId) { card = await this.reader.card(previous.cardId, true); this.reader.confirm(card); return result('saved', 'already-saved', 'Card creation previously confirmed; current card returned', ['card']) }
      // A creation receipt is in the initial page children, so lost responses and
      // restarts can recover it without an authoritative offline queue or schema.
      const candidates = await this.content.request(`data_sources/${config.dataSourceId}/query`, 'POST', { page_size: 100, filter: { property: 'Name', title: { equals: input.name } } })
      if (!Array.isArray(candidates.results) || candidates.has_more !== false) throw new WorkflowError('create-scope-incomplete', 'Matching-name search is incomplete; cannot safely deduplicate creation')
      for (const raw of candidates.results) {
        const candidate = notionCard(raw)
        if ((await this.content.sections(candidate.id)).some(section => section.text.split('\n').includes(marker))) {
          card = await this.reader.card(candidate.id, true); this.reader.confirm(card)
          await this.creations.put(key, signature, card.id)
          await this.changed({ card, actor, operationId: input.operation_id, properties: {} })
          return result('saved', 'already-saved', 'Card creation already saved', ['card'])
        }
      }
      if (previous) return result('partially-saved', 'create-unconfirmed', 'An earlier creation is unconfirmed and its receipt is not visible in the current name search. Reconcile that card before using a new operation_id; this retry will not create a duplicate.')
      const schema = await this.content.request(`data_sources/${config.dataSourceId}`)
      const template = { properties: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) => [name, { type: (value as { type: string }).type }])) } as WorkCard
      const values = { ...input.properties, Name: input.name, Owner: input.owner, Area: input.area,
        Status: input.owner.toLowerCase() === 'firstmate' ? 'Queued' : input.status, 'Last touched by': actor }
      const properties = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, this.property(template, name, value)]))
      const children = [paragraph(`Created by: ${actor}\n${marker}`), ...Object.entries(input.content ?? {}).map(([name, value]) => paragraph(sectionText(name, value)))]
      await this.creations.put(key, signature)
      attempted = true
      const created = await this.content.request('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: config.dataSourceId }, properties, children })
      const parsed = notionCard(created)
      card = await this.reader.card(parsed.id, true); this.reader.confirm(card)
      const fields = Object.keys(values).filter(name => this.matches(card!, name, this.normalized(card!, name, values[name as keyof typeof values])))
      const sections = await this.content.sections(card.id)
      const complete = fields.length === Object.keys(values).length && children.every(child => sections.some(section => section.text === child.paragraph.rich_text.map(r => r.text.content).join('')))
      if (complete) await this.creations.put(key, signature, card.id)
      await this.changed({ card, actor, operationId: input.operation_id, properties: Object.fromEntries(fields.map(name => [name, card!.properties[name]?.value])), sections: Object.keys(input.content ?? {}), sectionTexts: children.map(child => child.paragraph.rich_text.map(r => r.text.content).join('')) })
      return result(complete ? 'saved' : 'partially-saved', complete ? 'saved' : 'readback-mismatch', complete ? 'Card and content created and confirmed' : 'Card created; only listed properties confirmed; refresh this card before correction', ['card', ...fields])
    } catch (error) {
      if (error instanceof WorkflowError) return result('not-saved', error.code, error.message)
      if (error instanceof NotionWriteError && error.status < 500 && attempted) { await this.creations.remove(key); return result('not-saved', 'notion-rejected', `Notion rejected creation (HTTP ${error.status})`) }
      return result(attempted ? 'partially-saved' : 'not-saved', attempted ? 'create-unconfirmed' : 'source-unavailable', attempted ? 'Creation submitted but unconfirmed; retry identical input to find its receipt before creating again' : 'Current source unavailable; card not created')
    }
  }

}
