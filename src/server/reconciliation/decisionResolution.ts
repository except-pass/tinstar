import { currentDecisionProposal, decisionProposalSchema } from '../../shared/decisionProposal'
import { decisionRecordRows, workflowNoteHasMarker } from '../../shared/workflowRequests'
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
export { decisionRecordRows } from '../../shared/workflowRequests'
const rows = decisionRecordRows
export function decisionProposals(notes: WorkflowNote[]) {
  const entries = notes.flatMap(note => {
    const data = rows([note], 'Tin Star answer data: ')[0]
    return rows([note], 'Tin Star request: ').map(row => {
      if (data?.binding && row.id !== data.request_id) throw new DecisionSourceError('answer binding does not match its proposal identity')
      return { row, added: !!data?.binding }
    })
  })
  const history = [...new Set(entries.map(entry => entry.row.id))].flatMap(id => {
    const matching = entries.filter(entry => entry.row.id === id)
    if (matching.length === 1) return [matching[0]!.row]
    const published = matching.filter(entry => !entry.added), added = matching.filter(entry => entry.added)
    if (published.length !== 1 || added.length !== 1) throw new DecisionSourceError('proposal identity has conflicting records')
    const original = published[0]!.row, binding = added[0]!.row
    if (original.source_request || !binding.source_request || original.action !== binding.action || original.preserve_action !== binding.preserve_action) throw new DecisionSourceError('proposal identity has conflicting binding metadata')
    return [{ ...original, source_request: binding.source_request, source_question: binding.source_question, source_spawn_gen: binding.source_spawn_gen }]
  })
  const bound = new Map<string, typeof history>()
  for (const row of history.filter(row => row.source_request)) {
    const request = firstMateRequestSchema.safeParse(row.source_request)
    if (!request.success) throw new DecisionSourceError('published source binding is incomplete')
    const key = requestKey(request.data)
    bound.set(key, [...(bound.get(key) ?? []), row])
  }
  const current = [...bound.values()].map(group => {
    return currentDecisionProposal(group.map(row => ({ row, value: row.proposal })))?.row
  })
  return history.filter(row => !row.source_request || !decisionProposalSchema.safeParse(row.proposal).success || current.includes(row))
}
export function decisionAnswer(note: WorkflowNote) {
  const data = rows([note], 'Tin Star answer data: ')[0]
  if (data && typeof data.answer === 'string') return { answer: data.answer as string, owner: data.next?.owner as string | undefined, status: data.next?.status as string | undefined, wait: data.resolve_wait as string | undefined }
  const start = note.text.indexOf('\nAnswer: ')
  const footer = /\nNext owner: ([^\r\n]+)\nNext status: ([^\r\n]+)(?:\nResolved wait: ([^\r\n]+))?(?:\nTin Star operation: [^\r\n]+)?\n?$/.exec(note.text)
  if (start < 0 || !footer || footer.index <= start) return null
  return { answer: note.text.slice(start + '\nAnswer: '.length, footer.index).trim(), owner: footer[1], status: footer[2], wait: footer[3] }
}
export const decisionAnswerText = (note: WorkflowNote) => decisionAnswer(note)?.answer ?? null
/** Existing Notion history is the durable binding/answer record. The fleet
 * outbox owns delivery, including retries; this adds no queue or writer. */
export async function reconcileDecision(card: WorkCard, notes: WorkflowNote[], fleet: SourceSnapshot['fleet'], delivery?: DecisionDelivery,
  confirm?: (text: string, marker: string) => Promise<void>): Promise<DecisionResolution | undefined> {
  let requests: ReturnType<typeof decisionProposals>
  try { requests = decisionProposals(notes) } catch (error) { return verify((error as Error).message) }
  const bound = requests.filter(row => row && 'source_request' in row)
  if (!bound.length) {
    const linkedSource = fleet.some(home => [...(home.observation.data?.backlog ?? []), ...(home.observation.data?.tasks ?? [])].some(record =>
      record.cardReferences.some(ref => ref.pageId === card.id && ref.basis === 'explicit')))
    return linkedSource && rows(notes, 'Tin Star answer: ').length ? verify('answered proposal has no explicit First Mate request binding') : undefined
  }
  const results: DecisionResolution[] = []
  for (const row of bound) {
    const parsed = firstMateRequestSchema.safeParse(row.source_request)
    if (!parsed.success || typeof row.id !== 'string' || typeof row.source_question !== 'string' || !(row.source_spawn_gen === null || typeof row.source_spawn_gen === 'string')) return verify('published source binding is incomplete')
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
      if (notes.some(note => workflowNoteHasMarker(note, marker))) {
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

