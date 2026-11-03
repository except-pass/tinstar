import type { Execution, SceneCard } from '../server/reconciliation/scene'
import { managerCollapsed, type FloorScene, type PresentationState, type Target } from './presentation'

export const cardTitle = (card: SceneCard) => String(card.source.properties.Name?.value || 'Untitled card')
export const cardStatus = (card: SceneCard) => String(card.source.properties.Status?.value || 'Status unknown')
export const workerTitle = (worker: Execution) => String(worker.source.backlog.title || worker.identity.task_id?.replace(/[-_]/g, ' ') || 'Unknown worker')
export const shortHome = (home: string) => home.split('/').filter(Boolean).at(-1)?.replace(/-home$/, '').replace(/[-_]/g, ' ') || 'Unknown manager'
export const stale = (observation: { status: string; expiresAt: string | null }, now: number) =>
  !['fresh', 'partial'].includes(observation.status) || !!observation.expiresAt && Date.parse(observation.expiresAt) <= now
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
    ...scene.cards.filter(c => entityTone(scene, 'card', c.id, now, readFailed) === 'gap').map(c => ({ kind: 'card' as const, id: c.id })),
  ]
}
/** Membership comes from each independent source. Relationships only coordinate
 * ordering, never decide whether an entity exists. Repeated memberships refer to
 * one stable identity, with cross-group references explicitly exposed in the UI. */
export function overviewGroups(scene: FloorScene, state: PresentationState, now: number, readFailed = false) {
  const workers = scene.executions.filter(e => e.kind !== 'secondmate' &&
    !['finished', 'absent'].includes(e.liveness) && !managerCollapsed(scene, state, e.home))
  const compareWorkers = (a: Execution, b: Execution) => observedAt(b) - observedAt(a) || tie(a, b)
  const compareCards = (a: SceneCard, b: SceneCard) => priority(a) - priority(b) || cardTitle(a).localeCompare(cardTitle(b)) || tie(a, b)
  const globalWorkers = [...workers].sort(compareWorkers), globalCards = [...scene.cards].sort(compareCards)
  const rankWorker = new Map(globalWorkers.map((e, i) => [e.id, i])), rankCard = new Map(globalCards.map((c, i) => [c.id, i]))
  const relatedRank = (id: string, side: 'worker' | 'card') => Math.min(Infinity, ...scene.claims.filter(c => side === 'worker' ? c.executionId === id : c.cardId === id)
    .map(c => (side === 'worker' ? rankCard.get(c.cardId) : rankWorker.get(c.executionId)) ?? Infinity))
  return scene.arrangements[state.arrangement].map(group => {
    const ws = workers.filter(e => group.executionIds.includes(e.id) && (!state.exceptionsOnly || entityTone(scene, 'execution', e.id, now, readFailed) === 'orphan'))
    const cs = scene.cards.filter(c => group.cardIds.includes(c.id) && (!state.exceptionsOnly || entityTone(scene, 'card', c.id, now, readFailed) === 'gap'))
    ws.sort(state.sort === 'priority' ? (a, b) => (relatedRank(a.id, 'worker') - relatedRank(b.id, 'worker') || compareWorkers(a, b)) : compareWorkers)
    cs.sort(state.sort === 'activity' ? (a, b) => (relatedRank(a.id, 'card') - relatedRank(b.id, 'card') || compareCards(a, b)) : compareCards)
    return { ...group, label: state.arrangement === 'secondMate' ? shortHome(group.label) : group.label, workers: ws, cards: cs }
  }).filter(group => group.workers.length || group.cards.length)
}
