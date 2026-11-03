import type { SourceSnapshot } from './index'
import { buildAttentionCards, parsePullUrl } from '../fleet/attention'
import { ageObservation, type Observation } from './observation'
import { reconcileScene } from './scene'
import { record, text } from './values'
import type { PullReadiness } from './queuePulls'

export type QueueReadiness = 'ready-now' | 'needs-readiness-verification' | 'future-or-conditional'
export interface QueueSource {
  kind: 'notion' | 'firstmate' | 'github'
  id: string
  field: string
  observedAt: string | null
  expiresAt: string | null
  status: Observation<unknown>['status']
  coverage: Observation<unknown>['coverage']
}
export interface QueueItem {
  id: string
  title: string
  action: string | null
  kind: 'decision' | 'blocked' | 'merge'
  readiness: QueueReadiness
  reasons: string[]
  cardIds: string[]
  executionIds: string[]
  homeIds: string[]
  decisionKeys: string[]
  evidence: Array<{ url: string; kind: 'card' | 'pull-request' | 'reference' }>
  sources: QueueSource[]
  checkpoint: string | null
  // Read/navigation never answers a decision. No domain action is exposed here.
  oneTouch: boolean
}

type Card = NonNullable<SourceSnapshot['intentions']['data']>['cards'][number]
const prop = (card: Card, name: string) => card.properties[name]?.value
const word = (card: Card, name: string) => text(prop(card, name))?.trim() || null
const date = (card: Card, name: string) => text(record(prop(card, name)).start)
const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
const complete = (value: unknown) => ['done', 'archived', 'completed', 'answered', 'resolved', 'merged'].includes(normalize(String(value)))
const future = (value: string | null, now: number) => !!value && Date.parse(value) > now
const fresh = (observation: Observation<unknown>) => (observation.status === 'fresh' || observation.status === 'partial') && !!observation.data
const source = (kind: QueueSource['kind'], id: string, field: string, observation: Observation<unknown>): QueueSource => ({
  kind, id, field, observedAt: observation.observedAt, expiresAt: observation.expiresAt, status: observation.status, coverage: observation.coverage,
})
const rank: Record<QueueReadiness, number> = { 'ready-now': 0, 'needs-readiness-verification': 1, 'future-or-conditional': 2 }
const unique = <T>(items: T[]) => [...new Set(items)]
const safeUrl = (value: string | null) => {
  try { const url = new URL(value!); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}
const pulls = (item: QueueItem) => item.evidence.filter(e => e.kind === 'pull-request').map(e => e.url)
function link(item: QueueItem, value: string | null, kind: 'card' | 'reference' = 'reference') {
  const url = safeUrl(value)
  const pull = url ? parsePullUrl(url) : null
  const canonical = pull ? `https://github.com/${pull.repository}/pull/${pull.number}` : url
  if (canonical && !item.evidence.some(e => e.url === canonical)) item.evidence.push({ url: canonical, kind: pull ? 'pull-request' : kind })
}
function lower(item: QueueItem, readiness: QueueReadiness, reason: string) {
  if (rank[readiness] > rank[item.readiness]) item.readiness = readiness
  item.reasons.push(reason)
}
function restrictAction(item: QueueItem, value: string | null): boolean {
  const action = value?.replace(/^(?:decide|choose|determine)\s+(?:if|when)\b/i, '')
  let restricted = false
  if (action && /\b(?:when|after|once|until|pending|awaiting|if|later|tomorrow|not yet|blocked by|release-blocked)\b/i.test(action)) {
    restricted = true
    lower(item, 'future-or-conditional', 'Next action contains a future condition/prerequisite; it is retained in work context')
  }
  if (value && /\bthen\b|;\s*\w|\band\s+(?:review|verify|test|build|run|deploy|release|merge|approve)\b/i.test(value)) {
    restricted = true
    lower(item, 'needs-readiness-verification', 'Next action still contains multiple steps; verify the one-touch owner decision')
  }
  return restricted
}
function context(item: QueueItem, card: Card, observation: SourceSnapshot['intentions'], now: number) {
  for (const name of ['Next action', 'Next Action']) restrictAction(item, word(card, name))
  item.cardIds.push(card.id)
  item.sources.push(source('notion', card.id, 'Owner/Status/Will action/Waiting For/Next action/Start Date/Next check-in/Link/Evidence', observation))
  link(item, card.url ?? `https://www.notion.so/${card.id}`, 'card')
  link(item, word(card, 'Link')); link(item, word(card, 'Evidence'))
  item.checkpoint = date(card, 'Next check-in')
  const status = normalize(word(card, 'Status') ?? '')
  if (future(date(card, 'Start Date'), now) || ['backlog', 'todo', 'queued', 'planned', 'spare tokens'].includes(status)) {
    lower(item, 'future-or-conditional', 'Planned work or an agreed future start; no immediate owner decision')
  }
  const wait = word(card, 'Waiting For')
  if (wait) lower(item, 'future-or-conditional', `Published dependency/wait: ${wait}`)
  else if (status === 'waiting for') lower(item, 'future-or-conditional', 'Waiting For status without a named next action; verify the prerequisite')
  if (!fresh(observation)) lower(item, 'needs-readiness-verification', 'Notion observation is stale or unavailable; last-known action only')
  if (card.properties['Will action']?.hasMore || !word(card, 'Owner') || !word(card, 'Status')) {
    lower(item, 'needs-readiness-verification', 'Owner, status or action context is incomplete')
  }
}

/** Read-only, deterministic projection; a checkpoint is ordering context, never readiness proof. */
export function buildQueue(input: SourceSnapshot, pullStates: ReadonlyMap<string, PullReadiness> = new Map(), now = Date.now()) {
  const intentions = ageObservation(input.intentions, now)
  const fleet = input.fleet.map(home => ({ ...home, observation: ageObservation(home.observation, now) }))
  const scene = reconcileScene({ ...input, intentions, fleet }, now)
  const cards = new Map((intentions.data?.cards ?? []).map(card => [card.id, card]))
  const candidates: QueueItem[] = []
  const tagOnlyCandidates = new Set<QueueItem>()
  const blank = (id: string, title: string, action: string | null, kind: QueueItem['kind']): QueueItem => ({
    id, title, action, kind, readiness: 'ready-now', reasons: [], cardIds: [], executionIds: [], homeIds: [], decisionKeys: [], evidence: [], sources: [], checkpoint: null, oneTouch: false,
  })

  for (const card of cards.values()) {
    if (fresh(intentions) && (card.archived || card.in_trash || complete(word(card, 'Status')))) continue
    const actions = prop(card, 'Will action')
    const tags = Array.isArray(actions) ? actions.filter((a): a is string => typeof a === 'string') : []
    const owner = normalize(word(card, 'Owner') ?? '')
    // A mention in a title is not an owner request. Tags only create candidates.
    const waitingForWill = /\bWill\b/.test(word(card, 'Waiting For') ?? '')
    if (owner !== 'will' && !tags.length && !waitingForWill) continue
    const action = word(card, 'Next action') ?? word(card, 'Next Action')
    const merge = tags.some(tag => normalize(tag) === 'merge')
    const item = blank(JSON.stringify(['card', card.id, action ? normalize(action) : 'verify-action']), word(card, 'Name') ?? card.id, action, merge ? 'merge' : 'decision')
    context(item, card, intentions, now)
    if (owner !== 'will' || !action) {
      if (item.readiness === 'ready-now') tagOnlyCandidates.add(item)
      lower(item, 'needs-readiness-verification', 'A Will action tag/owner alone does not establish a concrete owner-only next action')
    }
    if (!merge && tags.some(tag => !['decision'].includes(normalize(tag)))) {
      tagOnlyCandidates.delete(item)
      lower(item, 'needs-readiness-verification', 'Command/release readiness requires prerequisite and authority verification')
    }
    if (item.readiness === 'ready-now') item.reasons.push('Published owner Will and a concrete next action, with no published dependency')
    candidates.push(item)
  }

  fleet.forEach((home, homeIndex) => {
    const observation = home.observation
    const tasks = observation.data?.tasks ?? []
    const backlog = observation.data?.backlog ?? []
    const attention = buildAttentionCards(homeIndex,
      tasks.map(task => ({ id: task.id, hints: { open_decisions: task.queue?.decisions ?? [] } })),
      backlog.map(row => ({ ...row, state: undefined, hold_kind: row.queue?.holdKind, merged: row.queue?.completed,
        body_lines: row.queue?.originTaskId ? [`Origin: ${row.queue.originTaskId}`] : [] })),
      tasks.map(task => ({ key: JSON.stringify(task.identity), id: String(task.id), objective: String(task.backlog.title ?? task.id),
        state: String(task.current_state.state), detail: String(task.current_state.detail ?? ''), prUrl: null })), new Map())
      .filter(call => call.type === 'decision' || call.type === 'blocked')
    for (const task of tasks) {
      if (!['needs-decision', 'held'].includes(String(task.current_state.state)) || attention.some(call => call.taskId === task.id)) continue
      attention.push({ key: JSON.stringify([home.source.home, task.id, 'unkeyed']), homeIndex, taskId: text(task.id),
        decisionKey: null, holdId: null, dismissal: null, type: 'decision', headline: text(task.current_state.detail) ?? `${task.id} needs decision context`,
        detail: '', workerKey: null, workerId: text(task.id), ageDays: null, prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown' })
    }
    for (const call of attention) {
      const task = tasks.find(task => task.id === call.taskId)
      const hold = backlog.find(row => row.id === (call.holdId ?? call.taskId))
      if (fresh(observation) && (task?.queue?.completed || hold?.queue?.completed || complete(hold?.state) || complete(task?.backlog.state) ||
        (task?.current_state.freshness === 'fresh' && complete(task.current_state.state)))) continue
      const execution = scene.executions.find(e => e.home === home.source.home && e.identity.task_id === call.taskId)
      const refs = unique([...(task?.cardReferences ?? []), ...(hold?.cardReferences ?? [])].map(ref => ref.pageId))
      const known = refs.map(id => cards.get(id)).filter((card): card is Card => !!card)
      const explicitRelationship = refs.length === 1 && known.length === 1 &&
        [...(task?.cardReferences ?? []), ...(hold?.cardReferences ?? [])].some(ref => ref.pageId === refs[0] && ref.basis === 'explicit')
      if (fresh(intentions) && explicitRelationship && known.some(card => card.archived || card.in_trash || complete(word(card, 'Status')))) continue
      const item = blank(JSON.stringify(['firstmate', home.source.home, call.taskId, call.type === 'blocked' ? call.key.replace(/^attention-\d+:/, '') : call.decisionKey ?? call.holdId ?? 'blocked']), call.headline,
        call.headline.trim() || null, call.type === 'blocked' ? 'blocked' : 'decision')
      restrictAction(item, text(hold?.hold_reason))
      restrictAction(item, text(task?.backlog.hold_reason))
      item.homeIds.push(home.source.home)
      if (execution) item.executionIds.push(execution.id)
      if (call.decisionKey) item.decisionKeys.push(call.decisionKey)
      item.sources.push(source('firstmate', JSON.stringify([home.source.home, call.taskId]), call.decisionKey ? `hints.open_decisions:${call.decisionKey}` : 'backlog.hold/current_state', observation))
      link(item, text(task?.pr.url)); link(item, text(hold?.pr_url))
      if (explicitRelationship) for (const card of known) context(item, card, intentions, now)
      if (explicitRelationship && known.some(card => !['firstmate', 'will'].includes(normalize(word(card, 'Owner') ?? '')))) {
        lower(item, 'needs-readiness-verification', 'Card owner is outside the reconciled First Mate/Will request; verify accountability')
      }
      if (refs.length > 0 && !explicitRelationship) {
        lower(item, 'needs-readiness-verification', 'Card relationship is textual, conflicting or outside the readable source; verify context')
      }
      if (!fresh(observation) || !fresh(intentions)) lower(item, 'needs-readiness-verification', 'Fleet/Notion context is stale or unavailable; absence of an answered action cannot be verified')
      const keyed = !!call.decisionKey && task?.queue?.decisions.some(decision => decision.key === call.decisionKey && decision.verb === 'needs-decision' && !!decision.summary?.trim())
      const ownerRouted = hold?.captain_actionable === true
      if (!ownerRouted) lower(item, 'needs-readiness-verification', 'No published owner-only routing; a keyed worker question may belong to its manager')
      if (call.type === 'blocked' || !item.action || (!keyed && hold?.captain_actionable !== true)) {
        lower(item, 'needs-readiness-verification', 'Blocked/held state alone does not identify an owner-only decision')
      }
      if (future(text(hold?.hold_until), now) || future(text(task?.backlog.hold_until), now) || text(hold?.blocked_by) || text(task?.backlog.blocked_by)) {
        lower(item, 'future-or-conditional', 'Published hold/dependency must clear before the decision is immediate')
      }
      for (const timing of [hold?.hold_until, task?.backlog.hold_until]) {
        if (timing && !Number.isFinite(Date.parse(String(timing)))) lower(item, 'needs-readiness-verification', 'Hold timing is not a verifiable date')
      }
      if (item.readiness === 'ready-now') item.reasons.push('First Mate publishes an owner-routed keyed decision or an explicitly captain-actionable hold')
      candidates.push(item)
    }
  })

  const result = new Map<string, QueueItem>()
  for (const item of candidates) {
    if (restrictAction(item, item.action)) tagOnlyCandidates.delete(item)
    const urls = pulls(item)
    // Exact PR identity unifies merge requests only. Other decisions on the same
    // card/PR remain independent; title similarity never collapses decisions.
    const merge = item.kind !== 'blocked' && (item.kind === 'merge' || (!!item.action && /^(?:please\s+)?merge\b/i.test(item.action)))
    if (merge) item.kind = 'merge'
    const duplicateKey = merge && urls.length === 1 ? `merge:${urls[0]}` : item.kind !== 'blocked' && item.cardIds.length === 1 && item.action
      ? JSON.stringify(['decision', item.cardIds[0], normalize(item.action)]) : item.id
    const existing = result.get(duplicateKey)
    if (existing) {
      // An incomplete tag may be corroborated by a current explicit First Mate
      // request. Stale/conflicting context and published dependencies still win.
      if (tagOnlyCandidates.has(existing) && item.readiness === 'ready-now') existing.readiness = 'ready-now'
      else if (!(tagOnlyCandidates.has(item) && existing.readiness === 'ready-now')) lower(existing, item.readiness, 'Same decision observed in multiple sources')
      if (!tagOnlyCandidates.has(item)) tagOnlyCandidates.delete(existing)
      existing.action ??= item.action
      existing.reasons.push(...item.reasons)
      existing.cardIds = unique([...existing.cardIds, ...item.cardIds]); existing.executionIds = unique([...existing.executionIds, ...item.executionIds])
      existing.homeIds = unique([...existing.homeIds, ...item.homeIds]); existing.decisionKeys = unique([...existing.decisionKeys, ...item.decisionKeys])
      existing.sources.push(...item.sources)
      for (const evidence of item.evidence) if (!existing.evidence.some(e => e.url === evidence.url)) existing.evidence.push(evidence)
    } else { item.id = duplicateKey; result.set(duplicateKey, item) }
  }
  const items = [...result.values()].filter(item => {
    const urls = pulls(item)
    if (item.kind === 'merge') {
      if (urls.length !== 1) lower(item, 'needs-readiness-verification', 'A merge request needs exactly one recognized PR evidence link')
      else {
        const observed = pullStates.get(urls[0]!)
        const pr = observed?.expiresAt && Date.parse(observed.expiresAt) <= now ? { ...observed, status: 'stale' as const } : observed
        if (pr) item.sources.push({ kind: 'github', id: urls[0]!, field: 'pull/head/checks/mergeability', observedAt: pr.observedAt,
          expiresAt: pr.expiresAt, status: pr.status, coverage: pr.status === 'fresh' ? 'complete' : 'unknown' })
        if (pr?.status === 'fresh' && (pr.state === 'merged' || pr.state === 'closed')) return false
        if (pr?.status !== 'fresh') lower(item, 'needs-readiness-verification', 'PR state/checks are unavailable or stale')
        else if (pr.draft || pr.checks === 'pending' || pr.checks === 'failed' || pr.mergeability === 'blocked') lower(item, 'future-or-conditional', 'PR is draft, blocked, or still requires passing checks')
        else if (pr.state !== 'open' || pr.checks !== 'passed' || pr.mergeability !== 'ready') lower(item, 'needs-readiness-verification', 'Current PR head/checks/mergeability do not yet prove merge readiness')
        else if (scene.executions.some(execution => item.executionIds.includes(execution.id) &&
          /^[a-f0-9]{40,64}$/.test(String(execution.source.pr.head)) && execution.source.pr.head !== pr.head)) {
          lower(item, 'needs-readiness-verification', 'Published execution PR head conflicts with the checked PR head')
        }
        else item.reasons.push('Current PR is open, ready for merge, with passing checks on its observed head; this does not prove delivery')
      }
    }
    item.oneTouch = item.readiness === 'ready-now' && !!item.action
    item.reasons = unique(item.reasons)
    return true
  }).sort((a, b) => rank[a.readiness] - rank[b.readiness] ||
    (Date.parse(a.checkpoint ?? '') || Infinity) - (Date.parse(b.checkpoint ?? '') || Infinity) || a.id.localeCompare(b.id))
  const meta = <T>(observation: Observation<T>) => { const { data: _data, ...rest } = observation; return rest }
  return { generatedAt: new Date(now).toISOString(), scope: input.scope, readOnly: true as const,
    coverage: { intentions: meta(intentions), fleet: fleet.map(home => ({ home: home.source.home, ...meta(home.observation) })),
      wholeFarm: 'not-certified' as const, cardBodies: 'not-collected' as const, emptyQueueMeansAllClear: false as const },
    warnings: [...input.warnings, 'Card-body-only next actions/evidence are not collected; verify candidates against the card. A checkpoint is not readiness proof.'],
    items, counts: Object.fromEntries(Object.keys(rank).map(readiness => [readiness, items.filter(item => item.readiness === readiness).length])),
  }
}
