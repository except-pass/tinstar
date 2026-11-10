import { createHash } from 'node:crypto'
import { requestAnchor, firstMateRequestSchema, type FirstMateRequest } from '../../shared/deskSource'
import type { StartWorkResult } from '../../shared/workflow'
import { sourceRequests } from '../fleet/requests'
import type { ListedMessage, OutboxMessage, SubmitResult } from '../fleet/inbox'
import type { SourceSnapshot } from './index'
import type { WorkCard } from './workReader'
import type { WorkflowNote } from './workflowContent'
import { ageObservation } from './observation'

export interface DecisionDelivery {
  submit(input: { requestId: string; anchorKey: string; kind: 'answer'; text: string }, resolution: NonNullable<OutboxMessage['decisionResolution']>): Promise<SubmitResult | null>
  messages(): Promise<ListedMessage[]>
  completeDecision(requestId: string): Promise<void>
}
export interface DecisionBinding {
  source_request: FirstMateRequest
  source_question: string
  source_spawn_gen: string | null
}
export type DecisionResolution = NonNullable<StartWorkResult['decision_resolution']>
const pending = (): DecisionResolution => ({ state: 'pending', message: 'Decision recorded · First Mate not yet updated' })
const verify = (reason: string): DecisionResolution => ({ state: 'verification-needed', message: `Decision reconciliation needs verification: ${reason}` })
export const requestKey = (request: FirstMateRequest) => requestAnchor(request)

export class DecisionSourceError extends Error {}

function sourceState(fleet: SourceSnapshot['fleet'], request: FirstMateRequest, cardId: string) {
  const homes = fleet.filter(home => home.source.home === request.home)
  if (homes.length !== 1) throw new DecisionSourceError('originating home is missing or ambiguous')
  const observation = ageObservation(homes[0]!.observation)
  if (observation.status !== 'fresh' || observation.coverage !== 'complete' || !observation.data) throw new DecisionSourceError('originating source is stale or incomplete')
  const { tasks } = observation.data
  const backlog = observation.data.backlog ?? []
  const workers = tasks.map(task => ({ key: JSON.stringify(task.identity), id: String(task.id), objective: String(task.backlog.title ?? task.id), state: String(task.current_state.state), detail: '', prUrl: null }))
  const entries = sourceRequests(request.home, 0,
    tasks.map(task => ({ ...task, completed: task.queue?.completed, hints: { open_decisions: task.queue?.decisions ?? [] } })),
    backlog.map(row => ({ ...row, hold_kind: row.queue?.holdKind, merged: row.queue?.completed, body_lines: row.queue?.originTaskId ? [`Origin: ${row.queue.originTaskId}`] : [] })), workers)
  const matches = entries.filter(entry => requestKey(entry.request) === requestKey(request))
  if (!matches.length) return null
  if (matches.length !== 1 || !matches[0]!.ownerReady) throw new DecisionSourceError('request is ambiguous or has no authorized answer route')
  const entry = matches[0]!, task = tasks.find(task => task.id === request.taskId), hold = backlog.find(row => row.id === entry.matchedHoldId)
  const refs = [...(task?.cardReferences ?? []), ...(hold?.cardReferences ?? [])]
  // This prevents answering a similarly named request or a second card's ask.
  if (new Set(refs.map(ref => ref.pageId)).size !== 1 || !refs.some(ref => ref.pageId === cardId && ref.basis === 'explicit')) throw new DecisionSourceError('request lacks one explicit canonical card link')
  return { source_request: request, source_question: entry.card.headline, source_spawn_gen: task?.identity.spawn_gen ?? null } satisfies DecisionBinding
}
export function bindDecision(fleet: SourceSnapshot['fleet'], request: FirstMateRequest, cardId: string): DecisionBinding {
  const binding = sourceState(fleet, request, cardId)
  if (!binding) throw new DecisionSourceError('request is no longer open')
  return binding
}
export const decisionRecordRows = (notes: WorkflowNote[], prefix: string) => notes.flatMap(note => {
  const lines = note.text.split('\n'), operation = lines.find(line => line.startsWith('Operation: '))
  if (prefix === 'Tin Star request: ' && operation === 'Operation: answer_decision') {
    const data = lines.filter(line => line.startsWith('Tin Star answer data: ')).at(-1)
    try { const row = data && JSON.parse(data.slice('Tin Star answer data: '.length)); return row?.binding ? [row.binding] : [] } catch { return [] }
  }
  const kind = prefix === 'Tin Star request: ' ? 'request_decision' : prefix === 'Tin Star answer: ' || prefix === 'Tin Star answer data: ' ? 'answer_decision' : null
  // Quoted protocol examples in an edit/comment are not a new owner decision.
  if (kind && (operation ? operation !== `Operation: ${kind}` : !lines[0]?.startsWith(prefix === 'Tin Star answer data: ' ? 'Tin Star answer: ' : prefix))) return []
  if (!kind && !lines[0]?.startsWith(prefix)) return []
  const records = lines.filter(line => line.startsWith(prefix))
  return records.slice(-1).flatMap(line => { try { return [JSON.parse(line.slice(prefix.length))] } catch { return [] } })
})
const rows = decisionRecordRows
export const decisionAnswerText = (note: WorkflowNote) => {
  const data = rows([note], 'Tin Star answer data: ')[0]
  if (data && typeof data.answer === 'string') return data.answer
  const start = note.text.indexOf('\nAnswer: '), end = note.text.indexOf('\nNext owner: ', start)
  return start >= 0 ? note.text.slice(start + '\nAnswer: '.length, end >= 0 ? end : undefined).trim() : null
}
/** Existing Notion history is the durable binding/answer record. The fleet
 * outbox owns delivery, including retries; this adds no queue or writer. */
export async function reconcileDecision(card: WorkCard, notes: WorkflowNote[], fleet: SourceSnapshot['fleet'], delivery?: DecisionDelivery,
  confirm?: (text: string, marker: string) => Promise<void>): Promise<DecisionResolution | undefined> {
  const requests = rows(notes, 'Tin Star request: ')
  const bound = requests.filter(row => row && 'source_request' in row)
  if (!bound.length) {
    const linkedSource = fleet.some(home => [...(home.observation.data?.backlog ?? []), ...(home.observation.data?.tasks ?? [])].some(record =>
      record.cardReferences.some(ref => ref.pageId === card.id && ref.basis === 'explicit')))
    return linkedSource && rows(notes, 'Tin Star answer: ').length ? verify('answered proposal has no explicit First Mate request binding') : undefined
  }
  const sources = new Set<string>()
  const results: DecisionResolution[] = []
  for (const row of bound) {
    const parsed = firstMateRequestSchema.safeParse(row.source_request)
    if (!parsed.success || typeof row.id !== 'string' || typeof row.source_question !== 'string' || !(row.source_spawn_gen === null || typeof row.source_spawn_gen === 'string')) return verify('published source binding is incomplete')
    const request = parsed.data, key = requestKey(request)
    if (sources.has(key)) return verify('multiple proposals bind the same source request')
    sources.add(key)
  }
  // Validate every binding before sending any answer from this card.
  const reconcile = async (row: typeof bound[number]): Promise<DecisionResolution> => {
    const request = firstMateRequestSchema.parse(row.source_request)
    const answers = notes.filter(note => rows([note], 'Tin Star answer: ').includes(row.id))
    if (!answers.length) throw new Error('No answer')
    const texts = [...new Set(answers.map(decisionAnswerText))]
    if (texts.length !== 1 || !texts[0]) return verify('answer is missing or contradictory')
    const answer = texts[0]
    // One immutable answer per published proposal. Semantic identity survives
    // refresh, process restarts and a different caller's operation_id.
    const digest = createHash('sha256').update(JSON.stringify([requestKey(request), card.id, row.id])).digest('hex').slice(0, 32)
    const deliveryId = `tinstar-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`
    const marker = `Tin Star reconciled: ${JSON.stringify([requestKey(request), row.id, answer])}`
    try {
      const current = sourceState(fleet, request, card.id)
      if (current && (current.source_question !== row.source_question || current.source_spawn_gen !== row.source_spawn_gen)) return verify('source request changed since the proposal was published')
      if (notes.some(note => note.text.split('\n').includes(marker))) {
        if (current) return verify('a previously reconciled request is open again')
        await delivery?.completeDecision(deliveryId)
        return { state: 'resolved', message: 'Resolved', delivery_id: deliveryId }
      }
      if (!delivery) return pending()
      const messages = await delivery.messages(), previous = messages.find(message => message.requestId === deliveryId)
      if (!current && !previous) return verify('source disappeared without a confirmed matching delivery receipt')
      if (!previous || previous.state === 'sending' || previous.state === 'unknown' || previous.announced === false) {
        const submitted = await delivery.submit({ requestId: deliveryId, anchorKey: requestKey(request), kind: 'answer',
          text: `Notion card: ${card.id}\nDecision proposal: ${row.id}\nExact owner answer:\n${answer}\nReconcile only this source request. Keep implementation Queued until a real worker starts; preserve other asks. Report the source reconciliation through the existing receipt path.` },
        { cardId: card.id, requestId: row.id, answerId: row.id })
        if (!submitted?.saved) return { ...pending(), delivery_id: deliveryId }
      }
      // Origin freshness/closure was checked above. Fleet-wide readiness can
      // remain unknown because of an unrelated home; its error must not veto
      // this source's own acknowledged receipt.
      if (!current && previous && ['done', 'acknowledged'].includes(previous.state)) {
        if (!confirm) return pending()
        await confirm('First Mate acknowledged this exact answer and its source request is closed.', marker)
        await delivery.completeDecision(deliveryId)
        return { state: 'resolved', message: 'Resolved', delivery_id: deliveryId }
      }
      return { ...pending(), delivery_id: deliveryId }
    } catch (error) {
      // Stale/ambiguous source state never becomes authorization to deliver.
      return error instanceof DecisionSourceError ? verify(error.message) : pending()
    }
  }
  for (const row of bound) {
    if (!notes.some(note => rows([note], 'Tin Star answer: ').includes(row.id))) continue
    results.push({ ...await reconcile(row), source_anchor: requestKey(row.source_request), request_id: row.id })
  }
  if (!results.length) return undefined
  const summary = results.find(result => result.state === 'verification-needed') ?? results.find(result => result.state === 'pending') ?? results[0]!
  return { ...summary, requests: results }
}

