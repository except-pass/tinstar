import { createHash } from 'node:crypto'
import { decisionPacketBindingSchema, decisionMeaning, type DecisionDependencyObservation, type DecisionEvidence } from '../../shared/decisionPacket'
import { decisionRequestRevision } from '../../shared/decisionProposal'
import { requestAnchor } from '../../shared/deskSource'
import { decisionRequests, decisionRecordRows, workflowReceipt } from '../../shared/workflowRequests'
import { workflowMarkers } from '../../shared/workflowMarkers'
import { redactSourceText } from '../../shared/searchDocuments'
import type { SourceSnapshot } from './index'
import type { Observation } from './observation'
import type { CardContextRead } from './cardContext'
import { bindDecision, decisionProposals } from './decisionResolution'
import { buildQueue } from './queue'
import { deferredDecisionCard } from './claimPolicy'
import { checkInReport } from './checkInWatchdog'
import { isPreparedPacketComment } from './commentPacket'

export interface CachedDecisionHistory { context: CardContextRead; observed_at: string; expires_at: string }

function sourceComment(note: CardContextRead['blocks'][number]) {
  return note.type === 'comment' && !checkInReport(note.text) && !isPreparedPacketComment(note)
    && !workflowReceipt(note)?.startsWith(`${workflowMarkers.operation} ["waiting-on-main",`)
}

function discussionText(note: CardContextRead['blocks'][number]) {
  const text = redactSourceText(note.text).replace(/\r\n?/g, '\n').trim()
  const request = decisionRecordRows([{ text }], 'Tin Star request: ')[0]
  if (!Array.isArray(request?.options)) return text
  const sorted = [...request.options].sort((a, b) => decisionMeaning(a).localeCompare(decisionMeaning(b)))
  return text.replace(/^Tin Star request: .*$/m, `Tin Star request: ${decisionMeaning({ ...request, options: sorted })}`)
}

/** No I/O, refresh, reconciliation or source writes. A future preparer can
 * inspect already-observed evidence without accidentally repairing an answer.
 * PR/release details are not asserted from a link: they need their own reads. */
export function projectDecisionEvidence(snapshot: SourceSnapshot, cardId: string, history: CachedDecisionHistory | undefined, now: number, cardObservation?: Pick<Observation<unknown>, 'status' | 'coverage' | 'observedAt' | 'expiresAt'>, projectedQueue?: ReturnType<typeof buildQueue>, renewalUntil?: string | null): DecisionEvidence {
  const card = snapshot.intentions.data?.cards.find(card => card.id === cardId)
  const reasons: string[] = []
  const deferred = !!card && deferredDecisionCard(card)
  if (!card) reasons.push('Canonical card is not in the observed configured board')
  const renewing = !!renewalUntil && Date.parse(renewalUntil) > now
  if (cardObservation && (cardObservation.status !== 'fresh' || cardObservation.coverage !== 'complete' || !cardObservation.expiresAt || Date.parse(cardObservation.expiresAt) <= now && !renewing)) reasons.push('Canonical card property evidence is unavailable or stale')
  if (deferred) reasons.push('Source card is deferred or closed')
  const completeHistory = history?.context.outcome === 'available' && history.context.commentsOutcome === 'available'
  const freshHistory = completeHistory && Number.isFinite(Date.parse(history!.observed_at)) && Date.parse(history!.observed_at) <= now && (Date.parse(history!.expires_at) > now || renewing)
  if (!freshHistory) reasons.push('Complete cached decision history is unavailable')
  const notes = history?.context.blocks ?? []
  // Bind substantive discussion once per card, without persisting its prose
  // or invalidating on connector ordering, timestamps, or prep-bot output.
  const commentText = notes.filter(sourceComment).map(discussionText).sort()
  const discussionRevision = commentText.length ? createHash('sha256').update(decisionMeaning({ comments: commentText })).digest('hex') : null
  const rows = decisionRequests(notes)
  if (freshHistory && !rows.length) reasons.push('No decision request is recorded in the complete card history')
  let currentRequests: string[] = []
  try { currentRequests = decisionProposals(notes.map(({ id, text }) => ({ id, text }))).map(row => row.id) }
  catch { reasons.push('Decision publication history is contradictory or incomplete') }
  const queue = projectedQueue ?? buildQueue(snapshot, new Map(), now)
  const items = queue.items.filter(item => item.cardIds.includes(cardId))
  const observation = snapshot.intentions
  const base = (kind: DecisionDependencyObservation['kind'], key: string, revision: string | null, source: Pick<Observation<unknown>, 'status' | 'coverage' | 'observedAt' | 'expiresAt'> = observation): DecisionDependencyObservation => ({ kind, key, revision,
    status: source.status, coverage: source.coverage, observed_at: source.observedAt, expires_at: source.expiresAt })
  const requests = rows.map(row => {
    const issues: string[] = []
    const cardNative = !row.hasSourceBinding
    if (!currentRequests.includes(row.id)) issues.push('Source proposal is superseded or its binding history is invalid')
    if (row.proposal) issues.push('Complete cross-channel proposal publication coverage is not available in this cached-history projection')
    if (!cardNative && !row.sourceRequest) issues.push('Request has no exact First Mate source binding')
    if (cardNative && (row.requestedFrom !== 'Will' || row.action !== 'Decision')) issues.push('Card-native preparation requires a Decision requested from Will')
    if (!row.options?.length) issues.push('Source-supported option identities are unavailable')
    if (!row.question) issues.push('Exact source question is unavailable')
    const anchor = row.sourceRequest ? requestAnchor(row.sourceRequest) : decisionMeaning(['card-request', cardId, row.id])
    const matches = items.filter(item => item.sources.some(source => source.request && source.request.home !== null && requestAnchor(source.request) === anchor))
    const item = matches.length === 1 ? matches[0] : undefined
    if (!cardNative && (!item || item.readiness !== 'ready-now')) issues.push(...(item?.reasons ?? ['Exact source request is not uniquely present in the observed queue']))
    if (row.sourceRequest) {
      try {
        const live = bindDecision(snapshot.fleet, row.sourceRequest, cardId, snapshot.intentions, now)
        if (live.source_question !== row.sourceQuestion || live.source_spawn_gen !== row.sourceSpawnGen) issues.push('Source question or worker generation changed')
      } catch (error) { issues.push(error instanceof Error ? error.message : 'Source binding cannot be verified') }
    }
    const proposal = row.proposal ? { ...row.proposal, published_at: undefined } : null
    const revision = decisionMeaning([item ? decisionRequestRevision(item) : null, row.id, row.sourceId, row.question, row.options?.slice().sort((a, b) => a.id.localeCompare(b.id)), proposal,
      ...(cardNative ? [row.action, row.preserveAction, row.requestedFrom] : []), ...(discussionRevision ? [discussionRevision] : [])])
    const binding = decisionPacketBindingSchema.safeParse({ card_id: cardId, request_key: cardNative ? anchor : item?.id, source_request: cardNative ? null : row.sourceRequest,
      request_id: row.id, source_id: row.sourceId, source_question: cardNative ? row.question : row.sourceQuestion, source_spawn_gen: cardNative ? null : row.sourceSpawnGen,
      source_revision: revision, options: row.options })
    if (!binding.success) issues.push(`Incomplete source binding: ${binding.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
    const dependencies = [base('request', anchor, revision), base('card', cardId, card ? decisionMeaning([card.archived, card.in_trash,
      Object.fromEntries(['Name', 'Owner', 'Status', 'Will action', 'Waiting For', 'Waiting For ID', 'Next action', 'Start Date', 'First Mate tasks', 'Link', 'Evidence'].map(key => {
        let value = card.properties[key]?.value
        if (key === 'Will action' && Array.isArray(value)) value = [...value].sort()
        if (key === 'First Mate tasks' && typeof value === 'string') {
          try { const links = JSON.parse(value); value = { ...links, tasks: Array.isArray(links.tasks) ? [...links.tasks].sort((a, b) => decisionMeaning(a).localeCompare(decisionMeaning(b))) : links.tasks } } catch { /* Invalid link meaning stays visible and blocks canonical binding. */ }
        }
        return [key, value]
      }))]) : null, cardObservation ?? observation),
    { ...base('answer', row.id, decisionMeaning(decisionRecordRows(notes, 'Tin Star answer data: ').filter(answer => answer.request_id === row.id))),
      status: freshHistory ? 'fresh' as const : 'unknown' as const, coverage: completeHistory ? 'complete' as const : 'unknown' as const,
      observed_at: history?.observed_at ?? null, expires_at: history?.expires_at ?? null }]
    if (row.sourceRequest) {
      const home = snapshot.fleet.find(home => home.source.home === row.sourceRequest!.home)
      const task = home?.observation.data?.tasks.find(task => task.id === row.sourceRequest!.taskId)
      dependencies[0] = { ...dependencies[0]!, status: home?.observation.status ?? 'unknown', coverage: home?.observation.coverage ?? 'unknown', observed_at: home?.observation.observedAt ?? null, expires_at: home?.observation.expiresAt ?? null }
      if (row.sourceRequest.taskId) dependencies.push({ ...base('worker', decisionMeaning([row.sourceRequest.home, row.sourceRequest.taskId]), task ? decisionMeaning([task.identity, task.current_state.state, task.endpoint.exists, task.endpoint.status, task.pr.head]) : null),
        status: home?.observation.status ?? 'unknown', coverage: home?.observation.coverage ?? 'unknown', observed_at: home?.observation.observedAt ?? null, expires_at: home?.observation.expiresAt ?? null })
    } else if (cardNative) {
      // The request lives in card history; fleet availability cannot establish
      // or invalidate its revision. Partial history still blocks stale answers.
      dependencies[0] = { ...dependencies[0]!, status: freshHistory ? 'fresh' : 'unknown', coverage: completeHistory ? 'complete' : 'unknown',
        observed_at: history?.observed_at ?? null, expires_at: history?.expires_at ?? null }
    }
    // Only the two sources this queue actually renews can use its last-good
    // window. Fleet, PR and release freshness protections stay independent.
    for (const dependency of dependencies) if (dependency.kind === 'card' || dependency.kind === 'answer' || cardNative && dependency.kind === 'request') dependency.renewal_until = renewalUntil
    for (const url of new Set(item?.evidence.filter(reference => reference.kind === 'pull-request').map(reference => reference.url) ?? [])) dependencies.push({ ...base('pr-head', url, null), status: 'unknown', coverage: 'unknown', observed_at: null, expires_at: null })
    return { binding: binding.success ? binding.data : null, question: row.question, dependencies, reasons: issues, answered: row.answered }
  })
  return { card_id: cardId, requests, reasons, ...(deferred ? { deferred } : {}), observed_at: observation.observedAt,
    omissions: ['Projection of cached observations only; no source refresh or answer reconciliation.', 'Cross-channel Ask publication coverage, PR details and release proofs are not collected here; material missing evidence blocks readiness.', ...(history?.context.omissions ? [history.context.omissions] : [])] }
}

/** Forced-submit projection can discount only this operation's own readback-
 * verified partial property effects. Other concurrent edits remain visible. */
export function projectPreparedSubmitEvidence(snapshot: SourceSnapshot, cardId: string, blocks: CardContextRead['blocks'],
  original?: Record<string, unknown>, desired?: Record<string, unknown>, now = Date.now()) {
  const copy = structuredClone(snapshot)
  const card = copy.intentions.data?.cards.find(card => card.id === cardId)
  if (card && original && desired) for (const [name, value] of Object.entries(original)) {
    const actual = card.properties[name]?.value
    if (name === 'Last touched by' || decisionMeaning(actual) === decisionMeaning(value) || name in desired && decisionMeaning(actual) === decisionMeaning(desired[name])) {
      if (card.properties[name]) card.properties[name] = { ...card.properties[name]!, value }
    }
  }
  return projectDecisionEvidence(copy, cardId, { context: { outcome: 'available', commentsOutcome: 'available', blocks },
    observed_at: new Date(now).toISOString(), expires_at: new Date(now + 30_000).toISOString() }, now)
}
