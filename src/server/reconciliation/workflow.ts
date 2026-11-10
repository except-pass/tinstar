import { startWorkSchema, type StartWorkInput, type StartWorkResult } from '../../shared/workflow'
import { codexTurn } from '../../shared/codexActivity'
import { FIRST_MATE_TASKS, isBlankWorkerLinks, workerLinkRecord } from './workerLinks'
import type { SourceSnapshot } from './index'
import type { WorkReader, WorkCard } from './workReader'

const richText = (content: string) => {
  const rich_text: Array<{ type: 'text'; text: { content: string } }> = []
  // Keep surrogate pairs intact at Notion's 2,000 UTF-16 character boundary.
  let chunk = ''
  for (const char of content) {
    if (chunk.length + char.length > 2000) { rich_text.push({ type: 'text', text: { content: chunk } }); chunk = '' }
    chunk += char
  }
  if (chunk) rich_text.push({ type: 'text', text: { content: chunk } })
  if (rich_text.length > 100) throw new Error('Worker provenance exceeds Notion property limits')
  return { rich_text }
}
const relevant = (card: WorkCard, kind: StartWorkInput['worker']['kind']) => ({ owner: card.properties.Owner?.value ?? null, status: card.properties.Status?.value ?? null,
  ...(kind === 'firstmate' ? { worker_links: card.properties[FIRST_MATE_TASKS]?.value ?? null } : { external_workers: card.properties['Delegated To']?.value ?? null }), area: card.properties.Area?.value ?? null })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** One mutation, one application implementation. No notes or second Notion
 * request are needed to durably couple a start and its provenance. */
export class WorkflowOperations {
  private locks = new Map<string, Promise<unknown>>()
  private receipts = new Map<string, { input: string; until: number; result: Promise<StartWorkResult> }>()
  constructor(private reader: WorkReader, private fleet: () => Promise<SourceSnapshot['fleet']>) {}
  start(input: StartWorkInput, actor: string): Promise<StartWorkResult> {
    const parsed = startWorkSchema.safeParse(input)
    const failed = (code: string, message: string): StartWorkResult => ({ outcome: 'not-saved', code, message, operation_id: input?.operation_id ?? '', saved_fields: [] })
    if (!parsed.success) return Promise.resolve(failed('invalid-input', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')))
    if (!actor.trim()) return Promise.resolve(failed('unauthenticated', 'Authenticated caller identity required'))
    input = parsed.data
    for (const [key, receipt] of this.receipts) if (receipt.until < Date.now()) this.receipts.delete(key)
    const key = JSON.stringify([actor, input.card_id, input.operation_id]), signature = JSON.stringify(input)
    const previous = this.receipts.get(key)
    if (previous) return previous.input === signature ? previous.result : Promise.resolve(failed('operation-conflict', 'operation_id was used with different input'))
    const prior = this.locks.get(input.card_id) ?? Promise.resolve()
    const result = prior.catch(() => {}).then(() => this.perform(input, actor))
    this.locks.set(input.card_id, result)
    void result.finally(() => { if (this.locks.get(input.card_id) === result) this.locks.delete(input.card_id) })
    if (this.receipts.size >= 1000) this.receipts.delete(this.receipts.keys().next().value!)
    this.receipts.set(key, { input: signature, until: Date.now() + 600_000, result })
    // A failed attempt can be retried after the source recovers. Re-read current
    // properties on every retry; the patch is a merge and adds no repeated note.
    void result.then(value => { if (value.outcome !== 'saved') this.receipts.delete(key) })
    return result
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
      const status = card.properties.Status?.type, touched = card.properties['Last touched by']?.type
      if (!['select', 'status'].includes(status ?? '') || !['select', 'rich_text'].includes(touched ?? '')) return result('not-saved', 'unsupported-properties', 'Status or Last touched by has an unsupported property type', card)
      const properties: Record<string, unknown> = { Status: { [status!]: { name: 'In Progress' } },
        'Last touched by': touched === 'select' ? { select: { name: actor } } : richText(actor) }
      desired = { Status: 'In Progress', 'Last touched by': actor }
      if (input.worker.kind === 'firstmate') {
        const worker = input.worker
        const homes = await this.fleet(), home = homes.find(row => row.source.home === worker.fm_home)
        if (!home || home.observation.status !== 'fresh' || home.observation.coverage !== 'complete' || !home.observation.data || Date.parse(home.observation.expiresAt ?? '') <= Date.now()) return result('not-saved', 'worker-unknown', 'Worker source is missing, partial or stale; current execution is unknown', card)
        const matches = home.observation.data.tasks.filter(task => task.identity.task_id === worker.task_id)
        if (matches.length !== 1 || matches[0]!.identity.spawn_gen !== worker.first_observed_spawn_gen) return result('not-saved', 'worker-untracked', 'Exact home/task/spawn generation is not currently tracked', card)
        const task = matches[0]!, state = task.current_state
        // Historical status-log verbs and endpoint existence cannot authorize a
        // new start. Use fresh native pane/run-step or Codex turn observations.
        const current = ['pane', 'run-step'].includes(String(state.source)) && state.freshness === 'fresh' && ['working', 'running', 'executing'].includes(String(state.state))
        const alive = task.endpoint.exists !== false && task.endpoint.agent_alive !== 'dead' && task.endpoint.status !== 'dead'
        if (task.kind === 'secondmate' || !alive || !(current || codexTurn(task, Date.now()) === true)) return result('not-saved', 'worker-not-executing', 'Tracked worker has no current execution evidence; owner names, historical reports and waits do not establish execution', card)
        const property = card.properties[FIRST_MATE_TASKS], links = property?.workerLinks
        if (property?.type !== 'rich_text' || !links || links.status !== 'valid' && !isBlankWorkerLinks(links)) return result('not-saved', 'worker-links-unreadable', 'Existing First Mate tasks cannot be safely merged; correct that property first', card)
        const tasks = links.status === 'valid' ? [...links.tasks] : []
        const existing = tasks.find(task => task.fm_home === worker.fm_home && task.task_id === worker.task_id)
        if (existing && existing.first_observed_spawn_gen !== worker.first_observed_spawn_gen) return result('not-saved', 'worker-generation-conflict', 'Existing native task has a different spawn generation; preserve and reconcile its history', card)
        if (!existing) tasks.push({ fm_home: worker.fm_home, task_id: worker.task_id, first_observed_spawn_gen: worker.first_observed_spawn_gen })
        const record = workerLinkRecord(tasks)
        Object.assign(properties, record.properties); desired[FIRST_MATE_TASKS] = record.json
      } else {
        const worker = input.worker, age = Date.now() - Date.parse(worker.observed_at)
        if (worker.card_id !== input.card_id || age < -30_000 || age >= 300_000) return result('not-saved', 'external-evidence-stale', 'External run must reference this card and include a current running observation within five minutes', card)
        const evidence = card.properties['Delegated To']
        if (evidence?.type !== 'rich_text' || evidence.hasMore) return result('not-saved', 'external-evidence-property', 'External worker provenance requires a readable Delegated To rich-text property', card)
        const entry = JSON.stringify({ schema: 'tinstar.external-worker.v1', ...worker, reported_by: actor })
        const old = String(evidence.value ?? '')
        const value = old.includes(entry) ? old : `${old}${old ? '\n' : ''}${entry}`
        properties['Delegated To'] = richText(value); desired['Delegated To'] = value
      }
      fields = Object.keys(desired)
      // Compare only fields used to validate/build this operation, not unrelated
      // edits or Last edited time. Direct edits can still race Notion PATCH.
      const current = await this.reader.card(input.card_id, true)
      if (!same(relevant(current, input.worker.kind), initial)) return result('not-saved', 'conflict', 'Relevant card properties changed during validation; read and retry', current)
      if (fields.every(field => same(current.properties[field]?.value, desired[field]))) { this.reader.confirm(current); return result('saved', 'already-saved', 'Start work already saved', current, fields) }
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
      const savedFields = fields.filter(field => same(saved.properties[field]?.value, desired[field]))
      return savedFields.length === fields.length ? result('saved', 'saved', 'Start work saved and confirmed', saved, savedFields)
        : result('partially-saved', 'readback-mismatch', 'Readback differs from the requested start; only listed fields are confirmed. Read the card and retry.', saved, savedFields)
    } catch {
      return result(attempted ? 'partially-saved' : 'not-saved', attempted ? 'save-unconfirmed' : 'source-unavailable', attempted
        ? 'Start work was submitted but readback could not be confirmed. Refresh and retry the same operation; no offline write is queued.'
        : 'Current source read failed; start work was not submitted')
    }
  }
}
