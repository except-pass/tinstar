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
/** One stale or partial home must not mark every other home's workers unavailable. */
export const homeAuthoritative = (observation: { status: string; coverage: string; expiresAt: string | null }, now: number, readFailed = false) =>
  !readFailed && observation.status === 'fresh' && observation.coverage === 'complete' && !stale(observation, now)
export type WorkerSourceCoverage = 'available' | 'partial' | 'unavailable'
export function workerSourceCoverage(homes: ReadonlyArray<{ observation: { status: string; coverage: string; expiresAt: string | null } }>, now: number, readFailed = false): WorkerSourceCoverage {
  if (readFailed || !homes.length || homes.every(home => !homeAuthoritative(home.observation, now, readFailed))) return 'unavailable'
  return homes.every(home => homeAuthoritative(home.observation, now)) ? 'available' : 'partial'
}
const openWorkerLabel = new Set(['Unassigned / Unknown', 'Unassigned', 'All work', 'Unknown'])
function homesForLabel(scene: FloorScene, field: 'manager' | 'machine', label: string) {
  if (openWorkerLabel.has(label)) return scene.coverage.homes
  const matched = scene.coverage.homes.filter(home => field === 'machine'
    ? (home.source.machine || 'Unknown') === label
    : managerName(scene, home.source.home) === label)
  return matched.length ? matched : scene.coverage.homes
}
/** Manager and machine groups speak for that home. Every other grouping can hide a worker on any configured home. */
export function relevantWorkerHomes(scene: FloorScene, organizer: { outer?: string; inner?: string } | undefined, group: { outerLabel: string; label: string }) {
  const outer = organizer?.outer, inner = organizer?.inner
  if (outer === 'manager' || outer === 'machine') return homesForLabel(scene, outer, group.outerLabel)
  if (inner === 'manager' || inner === 'machine') return homesForLabel(scene, inner, group.label)
  return scene.coverage.homes
}
export function workerSummary(homes: Parameters<typeof workerSourceCoverage>[0], now: number, readFailed: boolean, count: number, visible = count, compact = false) {
  const coverage = workerSourceCoverage(homes, now, readFailed)
  if (coverage === 'unavailable') return count ? `${count} last known workers` : 'Workers unavailable'
  if (count === 0) return coverage === 'partial' ? 'Unknown workers' : compact ? '0 W' : '0 workers'
  return compact ? `${count} W` : `${count} workers${visible < count ? ` · ${count - visible} hidden` : ''}`
}
export function workerAbsenceLabel(coverage: WorkerSourceCoverage, place: 'column' | 'gutter') {
  if (coverage === 'available') return place === 'column' ? 'No linked worker' : 'no worker'
  if (coverage === 'partial') return place === 'column' ? 'Unknown worker' : 'unknown worker'
  return place === 'column' ? 'Workers unavailable' : 'unknown worker'
}
export function emptyWorkerScopeLabel(coverage: WorkerSourceCoverage) {
  if (coverage === 'unavailable') return 'Workers unavailable'
  if (coverage === 'partial') return 'Unknown workers'
  return 'No current records observed in this scope.'
}
export function workerCoverageNotice(coverage: WorkerSourceCoverage) {
  if (coverage === 'unavailable') return 'Worker sources are unavailable. Last known workers remain visible.'
  if (coverage === 'partial') return 'Partial worker coverage. Known workers remain visible.'
  return null
}
export function unreadableWorkerHomes<T extends { observation: { status: string; coverage: string; expiresAt: string | null } }>(homes: readonly T[], now: number) {
  return homes.filter(home => !homeAuthoritative(home.observation, now))
}
/** A stale feed cannot make a recorded final report into a current worker.
 * This preserves history placement only; it does not certify present liveness. */
export const historyRecord = (worker: Execution) => ['finished', 'absent'].includes(worker.liveness) || worker.source.endpoint.exists === false ||
  /^(?:done|landed)(?=\s|:|$)/i.test(String(worker.source.lastEventText ?? worker.source.last_event.raw ?? '')) ||
  ['done', 'landed'].includes(String(worker.source.last_event.state))
export { executionStatus as workerState } from '../shared/executionLiveness'

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
