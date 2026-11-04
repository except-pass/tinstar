import { homeLabel } from '../shared/reconciliationLabels'
import type { Execution, SceneCard } from '../server/reconciliation/scene'
import { organizedGroups, type FloorGroup } from '../shared/floorOrganization'
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
/** Execution status and observation freshness are independent signals. */
export const workerState = (worker: Execution, now = Date.now(), readFailed = false) => {
  // Retained source state describes the last observation, not present liveness.
  // Freshness is labelled separately on the card and in the Inspector.
  if (worker.liveness === 'liveness-not-observed' && (readFailed || stale(worker.observation, now)) && worker.identity.task_id && worker.identity.spawn_gen) {
    const reported = String(worker.source.current_state.state)
    if (reported === 'blocked') return 'Blocked'
    if (['working', 'running', 'executing'].includes(reported)) return 'Running'
    if (['waiting', 'paused', 'parked', 'needs-decision', 'held'].includes(reported)) return 'Waiting'
    if (['done', 'landed'].includes(reported)) return 'Finished'
  }
  return worker.liveness === 'waiting' && worker.source.current_state.state === 'blocked' ? 'Blocked' :
    ({ running: 'Running', waiting: 'Waiting', finished: 'Finished', absent: 'Finished', 'liveness-not-observed': 'Unknown' })[worker.liveness]
}

export const observedAt = (worker: Execution) => {
  const time = Date.parse(worker.observation.observedAt ?? '')
  const age = worker.source.last_event.age_seconds
  return typeof age === 'number' && Number.isFinite(time) ? time - age * 1000 : 0
}
export const workerActivity = (worker: Execution) => {
  const note = String(worker.source.last_event.note ?? '').replace(/^[a-z-]+\s+(?:\[[^\]]+\]\s*)+:?\s*/i, '').trim()
  return !note || /ask-user\s+findings=|(?:^|\s)\/(?:home|tmp|srv)\/|\b[a-f0-9]{32}\b/.test(note) ? '' : note
}
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
/** Visibility never rewrites source links or absence findings. */
export function overviewGroups(scene: FloorScene, state: PresentationState, now: number, readFailed = false): FloorGroup[] {
  return organizedGroups(scene, state, now).map(group => {
    const workers = group.workers.filter(e => !managerCollapsed(scene, state, e.home) && (!state.exceptionsOnly || entityTone(scene, 'execution', e.id, now, readFailed) === 'orphan'))
    const cards = group.cards.filter(c => !state.exceptionsOnly || entityTone(scene, 'card', c.id, now, readFailed) === 'gap')
    return { ...group, workers, cards, cardIds: cards.map(c => c.id) }
  }).filter(g => g.workers.length || g.cards.length)
}
