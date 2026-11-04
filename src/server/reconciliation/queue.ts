import type { SourceSnapshot } from './index'
import { parsePullUrl } from '../fleet/attention'
import { sourceRequests } from '../fleet/requests'
import { requestAnchor, type FirstMateRequest } from '../../shared/deskSource'
import { ageObservation, type Observation } from './observation'
import { reconcileScene } from './scene'
import { record, text } from './values'
import type { PullReadiness } from './queuePulls'

export type QueueReadiness = 'ready-now' | 'needs-readiness-verification' | 'future-or-conditional'
export interface QueueSource {
  request?: FirstMateRequest | { home: null; taskId: null; id: string; kind: 'notion-card' }
  /** Readiness and response belong to this source, never inherited from another source. */
  readiness?: QueueReadiness
  action?: string | null
  reasons?: string[]
  responseAnchor?: string
  kind: 'notion' | 'firstmate' | 'github'
  id: string
  field: string
  observedAt: string | null
  expiresAt: string | null
  status: Observation<unknown>['status']
  coverage: Observation<unknown>['coverage']
}
export interface QueueItem {
  identities?: string[]
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
  const identities = new Map<QueueItem, string[]>()
  const explicitPulls = new Map<QueueItem, string[]>()
  const pullIds = (values: Array<string | null>) => unique(values.flatMap(value => {
    const pull = value && parsePullUrl(value)
    return pull ? [`pr:https://github.com/${pull.repository}/pull/${pull.number}`] : []
  }))
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
    const item = blank(JSON.stringify(['card', card.id]), word(card, 'Name') ?? card.id, action, merge ? 'merge' : 'decision')
    context(item, card, intentions, now)
    item.sources.push({ ...source('notion', card.id, 'Owner/Status/Will action/Waiting For/Next action/Start Date/Next check-in/Link/Evidence', intentions),
      request: { home: null, taskId: null, id: card.id, kind: 'notion-card' } })
    identities.set(item, [item.id])
    explicitPulls.set(item, pullIds([word(card, 'Link'), word(card, 'Evidence')]))
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
    const workers = tasks.map(task => ({ key: JSON.stringify(task.identity), id: String(task.id), objective: String(task.backlog.title ?? task.id),
      state: String(task.current_state.state), detail: String(task.current_state.detail ?? ''), prUrl: null }))
    const requests = sourceRequests(home.source.home, homeIndex,
      tasks.map(task => ({ ...task, completed: task.queue?.completed,
        hints: { open_decisions: task.queue?.decisions ?? [] } })),
      backlog.map(row => ({ ...row, hold_kind: row.queue?.holdKind, merged: row.queue?.completed,
        body_lines: row.queue?.originTaskId ? [`Origin: ${row.queue.originTaskId}`] : [] })), workers, fresh(observation))
    for (const task of tasks) {
      if (!['needs-decision', 'held'].includes(String(task.current_state.state)) || task.queue?.decisions.length || task.queue?.completed || requests.some(entry => entry.request.taskId === task.id)) continue
      requests.push({ request: { home: home.source.home, taskId: text(task.id), id: null, kind: 'decision' }, ownerReady: false, matchedHoldId: null,
        card: { key: JSON.stringify([home.source.home, task.id, 'unkeyed']), homeIndex, taskId: text(task.id),
          decisionKey: null, holdId: null, dismissal: null, type: 'decision', headline: text(task.current_state.detail) ?? 'Read the source request',
          detail: '', workerKey: null, workerId: text(task.id), ageDays: null, prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown' } })
    }
    for (const entry of requests) {
      const { card: call, request } = entry
      const task = tasks.find(task => task.id === request.taskId)
      const requestId = request.id
      const hold = backlog.find(row => row.id === entry.matchedHoldId)
      const execution = scene.executions.find(e => e.home === home.source.home && e.identity.task_id === call.taskId)
      const refs = unique([...(task?.cardReferences ?? []), ...(hold?.cardReferences ?? [])].map(ref => ref.pageId))
      const known = refs.map(id => cards.get(id)).filter((card): card is Card => !!card)
      const explicitRelationship = refs.length === 1 && known.length === 1 &&
        [...(task?.cardReferences ?? []), ...(hold?.cardReferences ?? [])].some(ref => ref.pageId === refs[0] && ref.basis === 'explicit')
      if (fresh(intentions) && explicitRelationship && known.some(card => card.archived || card.in_trash || complete(word(card, 'Status')))) continue
      const item = blank(call.key, call.headline,
        call.headline.trim() || null, call.type === 'blocked' ? 'blocked' : 'decision')
      restrictAction(item, text(hold?.hold_reason))
      restrictAction(item, text(task?.backlog.hold_reason))
      item.homeIds.push(home.source.home)
      if (execution) item.executionIds.push(execution.id)
      if (requestId && call.type !== 'blocked') item.decisionKeys.push(requestId)
      item.sources.push({ ...source('firstmate', call.key, request.kind === 'decision' ? 'hints.open_decisions' : 'backlog.hold', observation), request,
        ...(entry.ownerReady && request.id ? { responseAnchor: requestAnchor(request) } : {}) })
      // Readiness also depends on the Notion feed staying fresh enough to
      // verify that this request has not already been answered in its context.
      item.sources.push(source('notion', intentions.data?.dataSourceId ?? 'configured-source', 'request-readiness-context', intentions))
      // Request ids are scoped. A shared bare key on two workers is never identity.
      identities.set(item, [call.key, ...(entry.matchedHoldId ? [JSON.stringify(['hold', request.home, entry.matchedHoldId])] : [])])
      link(item, text(task?.pr.url)); link(item, text(hold?.pr_url))
      // Task PR/card membership remains evidence, never request identity. Only
      // this request's own hold field or a URL in its question can unify it.
      const questionLinks = (call.headline.match(/https:\/\/[^\s<>"']+/g) ?? []).map(url => url.replace(/[),.;!?]+$/, '')).filter(url => parsePullUrl(url))
      for (const url of questionLinks) link(item, url)
      explicitPulls.set(item, pullIds([text(hold?.pr_url), ...questionLinks]))
      if (explicitRelationship) for (const card of known) context(item, card, intentions, now)
      if (explicitRelationship && known.some(card => !['firstmate', 'will'].includes(normalize(word(card, 'Owner') ?? '')))) {
        lower(item, 'needs-readiness-verification', 'Card owner is outside the reconciled First Mate/Will request; verify accountability')
      }
      if (refs.length > 0 && !explicitRelationship) {
        lower(item, 'needs-readiness-verification', 'Card relationship is textual, conflicting or outside the readable source; verify context')
      }
      if (!fresh(observation) || !fresh(intentions)) lower(item, 'needs-readiness-verification', 'Fleet/Notion context is stale or unavailable; absence of an answered action cannot be verified')
      if (call.type === 'blocked' || !item.action || !entry.ownerReady) {
        lower(item, 'needs-readiness-verification', 'No owner-actionable record explicitly matches this request ID')
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

  const verifyPull = (item: QueueItem) => {
    const urls = pulls(item)
    if (item.kind === 'merge') {
      if (urls.length !== 1) lower(item, 'needs-readiness-verification', 'A merge request needs exactly one recognized PR evidence link')
      else {
        const observed = pullStates.get(urls[0]!)
        const pr = observed?.expiresAt && Date.parse(observed.expiresAt) <= now ? { ...observed, status: 'stale' as const } : observed
        if (pr && !item.sources.some(source => source.kind === 'github' && source.id === urls[0])) item.sources.push({ kind: 'github', id: urls[0]!, field: 'pull/head/checks/mergeability', observedAt: pr.observedAt,
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
    return true
  }
  // Snapshot source-local readiness BEFORE combining identities. A ready card
  // cannot promote an unverified worker question into an actionable response.
  const retained: QueueItem[] = []
  for (const item of candidates) {
    if (restrictAction(item, item.action)) tagOnlyCandidates.delete(item)
    const merge = item.kind !== 'blocked' && (item.kind === 'merge' || (!!item.action && /^(?:please\s+)?merge\b/i.test(item.action)))
    if (merge) item.kind = 'merge'
    if (!verifyPull(item)) continue
    for (const source of item.sources) if (source.request) Object.assign(source, { readiness: item.readiness, action: item.action, reasons: [...item.reasons] })
    retained.push(item)
    // An explicitly published PR URL is identity. Contextual card membership is not.
    identities.get(item)!.push(...(explicitPulls.get(item) ?? []))
  }
  // Connected components also cover a bridge source sharing a request id with
  // one item and a PR URL with another. Arrival order never loses a source.
  const groups: Array<{ items: QueueItem[]; ids: Set<string> }> = []
  for (const item of retained) {
    const ids = identities.get(item)!
    const matches = groups.filter(group => ids.some(id => group.ids.has(id)))
    const group = { items: [item, ...matches.flatMap(group => group.items)], ids: new Set([...ids, ...matches.flatMap(group => [...group.ids])]) }
    for (const match of matches) groups.splice(groups.indexOf(match), 1)
    groups.push(group)
  }
  const result = groups.map(group => {
    const members = group.items.sort((a, b) => a.id.localeCompare(b.id))
    const item = members[0]!
    const substantive = members.filter(member => !tagOnlyCandidates.has(member))
    const readiness = (substantive.length ? substantive : members).reduce<QueueReadiness>((value, member) => rank[member.readiness] > rank[value] ? member.readiness : value, 'ready-now')
    const preferred = members.find(member => member.readiness === readiness && member.action) ?? members.find(member => member.action)
    item.identities = [...group.ids].sort()
    item.id = item.identities.find(id => id.startsWith('pr:')) ?? item.identities[0]!
    item.readiness = readiness
    item.action = preferred?.action ?? null
    item.kind = members.some(member => member.kind === 'merge') ? 'merge' : item.kind
    item.sources = [...new Map(members.flatMap(member => member.sources).map(source => [JSON.stringify([source.kind, source.id, source.field]), source])).values()]
    item.reasons = members.flatMap(member => member.reasons)
    item.cardIds = unique(members.flatMap(member => member.cardIds))
    item.executionIds = unique(members.flatMap(member => member.executionIds))
    item.homeIds = unique(members.flatMap(member => member.homeIds))
    item.decisionKeys = unique(members.flatMap(member => member.decisionKeys))
    item.evidence = [...new Map(members.flatMap(member => member.evidence).map(evidence => [evidence.url, evidence])).values()]
    return item
  })
  const items = result.filter(item => {
    if (!verifyPull(item)) return false
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
