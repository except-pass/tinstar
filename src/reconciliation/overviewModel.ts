import { homeLabel } from '../shared/reconciliationLabels'
import type { Execution, SceneCard } from '../server/reconciliation/scene'
import { managerCollapsed, type FloorScene, type PresentationState, type Target } from './presentation'

export const cardTitle = (card: SceneCard) => String(card.source.properties.Name?.value || 'Untitled card')
export const cardStatus = (card: SceneCard) => String(card.source.properties.Status?.value || 'Status unknown')
export const visibleOverviewCard = (card: SceneCard) => {
  const status = String(card.source.properties.Status?.value ?? '').trim().toLowerCase()
  return !card.source.archived && !card.source.in_trash && status !== '' && status !== 'archived' && status !== 'unknown'
}
export const workerTitle = (worker: Execution) => String(worker.source.backlog.title || worker.identity.task_id?.replace(/[-_]/g, ' ') || 'Unknown worker')
export const managerName = (scene: FloorScene, home: string) => homeLabel(scene.coverage.homes.find(h => h.source.home === home)?.source ?? { home })
export const rootHome = (scene: FloorScene) => scene.coverage.homes.find(h => !h.source.parentHome && (h.source.label === 'main' || scene.coverage.homes.some(child => child.source.parentHome === h.source.home)))
export const stale = (observation: { status: string; expiresAt: string | null }, now: number) =>
  !['fresh', 'partial'].includes(observation.status) || !!observation.expiresAt && Date.parse(observation.expiresAt) <= now
/** A stale feed cannot make a recorded final report into a current worker.
 * This preserves history placement only; it does not certify present liveness. */
export const historyRecord = (worker: Execution) => ['finished', 'absent'].includes(worker.liveness) || worker.source.endpoint.exists === false ||
  /^(?:done|landed)(?=\s|:|$)/i.test(String(worker.source.lastEventText ?? worker.source.last_event.raw ?? '')) ||
  ['done', 'landed'].includes(String(worker.source.last_event.state))
export const workerState = (worker: Execution, now: number, readFailed = false) => readFailed || stale(worker.observation, now) ? 'Last known' : ({ running: 'Running', waiting: 'Waiting', finished: 'Finished', absent: 'Offline', 'liveness-not-observed': 'State unknown' })[worker.liveness]
export const observedAt = (worker: Execution) => {
  const time = Date.parse(worker.observation.observedAt ?? '')
  const age = worker.source.last_event.age_seconds
  return typeof age === 'number' && Number.isFinite(time) ? time - age * 1000 : 0
}
const priority = (card: SceneCard) => {
  const value = String(card.source.properties.Priority?.value ?? '').toLowerCase()
  const numeric = value.match(/(?:^|\b)p?([0-9]+)(?:\b|$)/)?.[1]
  return numeric ? Number(numeric) : ({ urgent: 0, critical: 0, high: 1, medium: 2, normal: 2, low: 3 }[value] ?? 100)
}
const workRank = (card: SceneCard) => card.expectation === 'expected-now' ? 0 : card.expectation === 'unknown' ? 1 : card.expectation === 'outside' ? 2 : 3
export const workerActivity = (worker: Execution) => {
  const note = String(worker.source.last_event.note ?? '').replace(/^[a-z-]+\s+(?:\[[^\]]+\]\s*)+:?\s*/i, '').trim()
  return !note || /ask-user\s+findings=|(?:^|\s)\/(?:home|tmp|srv)\/|\b[a-f0-9]{32}\b/.test(note) ? '' : note
}
const tie = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
export type Tone = 'linked' | 'gap' | 'orphan' | 'uncertain' | 'quiet'
export function entityTone(scene: FloorScene, kind: 'card' | 'execution', id: string, now: number, readFailed = false): Tone {
  const findings = scene.findings.filter(f => (kind === 'card' ? f.cardIds : f.executionIds).includes(id))
  const absenceSafe = !readFailed && scene.coverage.absenceConclusions === 'sufficient-configured-sources' &&
    !stale(scene.coverage.intentions, now) && scene.coverage.homes.every(h => !stale(h.observation, now))
  if (absenceSafe && findings.some(f => f.kind === 'task-execution-gap')) return 'gap'
  if (absenceSafe && findings.some(f => f.kind === 'untracked-worker')) return 'orphan'
  if (kind === 'card' && findings.some(f => ['legitimate-wait-planned', 'outside-coverage'].includes(f.kind))) return 'quiet'
  const claims = scene.claims.filter(c => (kind === 'card' ? c.cardId : c.executionId) === id)
  if (!readFailed && claims.length && claims.every(c => c.verification === 'confirmed' && c.state === 'current') &&
    !stale(scene.coverage.intentions, now) && claims.every(c => {
      const execution = scene.executions.find(e => e.id === c.executionId)
      return execution && !stale(execution.observation, now)
    })) return 'linked'
  return 'uncertain'
}
export function gapTargets(scene: FloorScene, now: number, readFailed = false): Target[] {
  return [
    ...scene.executions.filter(e => e.kind !== 'secondmate' && entityTone(scene, 'execution', e.id, now, readFailed) === 'orphan').map(e => ({ kind: 'execution' as const, id: e.id })),
    ...scene.cards.filter(c => visibleOverviewCard(c) && entityTone(scene, 'card', c.id, now, readFailed) === 'gap').map(c => ({ kind: 'card' as const, id: c.id })),
  ]
}
/** Presentation membership and visibility follow docs/features/overview.md.
 * Repeated memberships retain one stable identity across groups. */
export function overviewGroups(scene: FloorScene, state: PresentationState, now: number, readFailed = false) {
  const currentWorkers = scene.executions.filter(e => e.kind !== 'secondmate' && !historyRecord(e))
  const workers = currentWorkers.filter(e => !managerCollapsed(scene, state, e.home))
  const compareWorkers = (a: Execution, b: Execution) => observedAt(b) - observedAt(a) || tie(a, b)
  const compareCards = (a: SceneCard, b: SceneCard) => priority(a) - priority(b) || workRank(a) - workRank(b) || cardTitle(a).localeCompare(cardTitle(b)) || tie(a, b)
  const globalWorkers = [...workers].sort(compareWorkers), globalCards = [...scene.cards].sort(compareCards)
  const rankWorker = new Map(globalWorkers.map((e, i) => [e.id, i])), rankCard = new Map(globalCards.map((c, i) => [c.id, i]))
  const relatedRank = (id: string, side: 'worker' | 'card') => Math.min(Infinity, ...scene.claims.filter(c => side === 'worker' ? c.executionId === id : c.cardId === id)
    .map(c => (side === 'worker' ? rankCard.get(c.cardId) : rankWorker.get(c.executionId)) ?? Infinity))
  return scene.arrangements[state.arrangement].map(group => {
    const ws = workers.filter(e => group.executionIds.includes(e.id) && (!state.exceptionsOnly || entityTone(scene, 'execution', e.id, now, readFailed) === 'orphan'))
    const unaffiliated = state.arrangement === 'secondMate' && group.label === 'Unassigned / unknown'
    const cardIds = state.arrangement === 'secondMate'
      ? currentWorkers.filter(e => group.homeIds.includes(e.home) && ['running', 'waiting'].includes(e.liveness)).flatMap(e => e.source.cardReferences.map(ref => ref.pageId))
      : group.cardIds
    const cs = unaffiliated ? [] : scene.cards.filter(c => visibleOverviewCard(c) && cardIds.includes(c.id) && (!state.exceptionsOnly || entityTone(scene, 'card', c.id, now, readFailed) === 'gap'))
    ws.sort(state.sort !== 'activity' ? (a, b) => (relatedRank(a.id, 'worker') - relatedRank(b.id, 'worker') || compareWorkers(a, b)) : compareWorkers)
    cs.sort(state.sort === 'activity' ? (a, b) => (relatedRank(a.id, 'card') - relatedRank(b.id, 'card') || compareCards(a, b)) : compareCards)
    const label = state.arrangement === 'secondMate' && group.homeIds[0] ? managerName(scene, group.homeIds[0]) : group.label
    return { ...group, cardIds: cs.map(card => card.id), label, workers: ws, cards: cs }
  }).filter(group => group.workers.length || group.cards.length).sort((a, b) => Number(a.label === 'Unassigned / unknown') - Number(b.label === 'Unassigned / unknown'))
}
