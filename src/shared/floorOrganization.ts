import type { Execution, SceneCard } from '../server/reconciliation/scene'
import type { FloorScene, PresentationState } from './reconciliationPresentation'
import { homeLabel } from './reconciliationLabels'

export const floorFields = [
  { id: 'manager', label: 'Manager', source: 'worker', kind: 'category' },
  { id: 'machine', label: 'Machine', source: 'worker', kind: 'category' },
  { id: 'workerStatus', label: 'Worker status', source: 'worker', kind: 'category' },
  { id: 'activity', label: 'Last activity', source: 'worker', kind: 'date' },
  { id: 'initiative', label: 'Initiative', source: 'task', kind: 'category' },
  { id: 'epic', label: 'Epic', source: 'task', kind: 'category' },
  { id: 'status', label: 'Task Status', source: 'task', kind: 'category' },
  { id: 'owner', label: 'Task Owner', source: 'task', kind: 'category' },
  { id: 'priority', label: 'Priority', source: 'task', kind: 'priority' },
  { id: 'checkIn', label: 'Next check-in', source: 'task', kind: 'date' },
  { id: 'due', label: 'Due Date', source: 'task', kind: 'date' },
  { id: 'edited', label: 'Last edited', source: 'task', kind: 'date' },
  { id: 'area', label: 'Area', source: 'task', kind: 'category' },
  { id: 'subArea', label: 'Sub-area', source: 'task', kind: 'category' },
] as const
export type FloorField = typeof floorFields[number]['id']
export interface Organizer { outer: FloorField | 'none'; inner: FloorField | 'none'; order: FloorField; direction: 'asc' | 'desc' }
export interface StatusFilter { preset: 'operational' | 'all' | 'custom'; statuses: string[] }
export const defaultOrganizer = (): Organizer => ({ outer: 'status', inner: 'none', order: 'checkIn', direction: 'asc' })
export const defaultStatusFilter = (): StatusFilter => ({ preset: 'operational', statuses: [] })
export const operationalStatuses = ['In Progress', 'Queued', 'Waiting', 'Waiting For', 'Waiting for Prod Release', 'Ready for Review', 'In review', 'Delegated to person']
export const statusName = (card: SceneCard) => String(card.source.properties.Status?.value ?? '').trim()
export const matchesStatus = (card: SceneCard, filter: StatusFilter) => filter.preset === 'all' || (filter.preset === 'operational' ? operationalStatuses : filter.statuses).includes(statusName(card))
export const currentStatusOptions = (scene: FloorScene) => [...new Set([...(scene.statusOptions ?? []), ...scene.cards.map(statusName)].filter(Boolean))].sort((a, b) => a.localeCompare(b))
export const activeWorker = (worker: Execution) => worker.kind !== 'secondmate' && !['finished', 'absent'].includes(worker.liveness) && worker.source.endpoint.exists !== false &&
  !/^(?:done|landed)(?=\s|:|$)/i.test(String(worker.source.lastEventText ?? worker.source.last_event.raw ?? '')) && !['done', 'landed'].includes(String(worker.source.last_event.state))
const field = (id: FloorField) => floorFields.find(f => f.id === id)!
const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' })
function calendarDay(time: number) {
  const parts = ny.formatToParts(time), part = (type: string) => Number(parts.find(p => p.type === type)!.value)
  return Date.UTC(part('year'), part('month') - 1, part('day')) / 86400000
}
/** Date-only Notion values mean a New York calendar date, not UTC midnight. */
export function dateTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(value)
  const midnight = Date.parse(`${value}T04:00:00Z`)
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(midnight).find(p => p.type === 'timeZoneName')?.value.match(/GMT([+-]\d+)/)?.[1]
  return Date.parse(`${value}T00:00:00Z`) - Number(offset ?? -5) * 3600000
}
export const dateBuckets = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'Not scheduled', 'Unknown']
export function dateBucket(value: string | null, now: number, checkIn = false) {
  if (!value) return 'Not scheduled'
  const time = dateTimestamp(value)
  if (!Number.isFinite(time)) return 'Unknown'
  const today = calendarDay(now), day = calendarDay(time), diff = day - today
  if (diff < 0 || checkIn && value.length > 10 && time < now) return 'Overdue'
  if (!diff) return 'Today'
  if (diff === 1) return 'Tomorrow'
  const weekday = new Date(today * 86400000).getUTCDay()
  return diff <= 7 - (weekday || 7) ? 'This week' : 'Later'
}
type Pair = { worker?: Execution; card?: SceneCard }
function values(scene: FloorScene, pair: Pair, id: FloorField): string[] {
  const { worker: w, card: c } = pair
  let raw: unknown
  switch (id) {
    case 'manager': raw = w ? homeLabel(scene.coverage.homes.find(h => h.source.home === w.home)?.source ?? { home: w.home }) : null; break
    case 'machine': raw = w?.placement.machine; break
    case 'workerStatus': raw = w ? w.liveness === 'liveness-not-observed' ? 'Unknown' : w.liveness === 'waiting' && w.source.current_state.state === 'blocked' ? 'Blocked' : w.liveness === 'running' ? 'Running' : 'Waiting' : null; break
    case 'activity': {
      const observed = Date.parse(w?.observation.observedAt ?? ''), age = w?.source.last_event.age_seconds
      raw = w && Number.isFinite(observed) && typeof age === 'number' && Number.isFinite(age) ? new Date(observed - age * 1000).toISOString() : null; break
    }
    case 'initiative': case 'epic': {
      const property = c?.source.properties[id === 'initiative' ? 'Initiative' : 'Epic']
      raw = property && ['relation', 'select', 'rich_text'].includes(property.type ?? '') ? property.value : null; break
    }
    case 'edited': raw = c?.source.last_edited_time; break
    default: raw = c?.source.properties[({ status: 'Status', owner: 'Owner', priority: 'Priority', checkIn: 'Next check-in', due: 'Due Date', area: 'Area', subArea: 'Sub-area' } as const)[id]]?.value
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = (raw as { start?: unknown }).start
  return (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim())
}
const blank = (value: string) => ['Unassigned / Unknown', 'Not scheduled', 'Unknown'].includes(value)
const priorityRank = (value: string) => Number(value.match(/^p?(\d+)$/i)?.[1] ?? ({ urgent: 0, critical: 0, high: 1, medium: 2, normal: 2, low: 3 }[value.toLowerCase()] ?? 100))
const compareValue = (a: string, b: string, id: FloorField) => field(id).kind === 'date' ? dateTimestamp(a) - dateTimestamp(b) : field(id).kind === 'priority' ? priorityRank(a) - priorityRank(b) || a.localeCompare(b) : a.localeCompare(b)
export interface FloorGroup {
  id: string; label: string; outerId: string; outerLabel: string; innerLabel: string
  executionIds: string[]; cardIds: string[]; homeIds: string[]; claimIds: string[]
  workers: Execution[]; cards: SceneCard[]
}
/** Explicit link pairs preserve correlation across mixed-domain nested fields.
 * Endpoints are unioned independently; reference instances keep canonical IDs. */
export function organizedGroups(scene: FloorScene, state: PresentationState, now: number): FloorGroup[] {
  const organizer = state.organizer ?? defaultOrganizer(), filter = state.statusFilter ?? defaultStatusFilter()
  const workers = scene.executions.filter(activeWorker)
  const cards = scene.cards.filter(c => !c.source.archived && !c.source.in_trash && (matchesStatus(c, filter) || state.navigation?.cardId === c.id || state.selection?.kind === 'card' && state.selection.id === c.id || state.flash?.ids.includes(`card:${c.id}`)))
  const workerMap = new Map(workers.map(w => [w.id, w])), cardMap = new Map(scene.cards.map(c => [c.id, c]))
  const pairs: Pair[] = [], linkedWorkers = new Set<string>(), linkedCards = new Set<string>()
  for (const claim of scene.claims) {
    if (claim.basis !== 'explicit' || claim.verification === 'conflicting' || claim.state === 'historical') continue
    const worker = workerMap.get(claim.executionId), card = cardMap.get(claim.cardId)
    if (worker && card) { pairs.push({ worker, card }); linkedWorkers.add(worker.id); linkedCards.add(card.id) }
  }
  for (const worker of workers) if (!linkedWorkers.has(worker.id)) pairs.push({ worker })
  for (const card of cards) if (!linkedCards.has(card.id)) pairs.push({ card })
  const visibleCards = new Set(cards.map(c => c.id)), groups = new Map<string, FloorGroup>(), memberships = new Map<string, Pair[]>()
  const buckets = (pair: Pair, id: FloorField | 'none') => id === 'none' ? ['All work'] : field(id).kind === 'date'
    ? [...new Set((values(scene, pair, id).length ? values(scene, pair, id) : [null]).map(v => dateBucket(v, now, id === 'checkIn')))]
    : values(scene, pair, id).length ? [...new Set(values(scene, pair, id))] : ['Unassigned / Unknown']
  for (const pair of pairs) for (const outerLabel of buckets(pair, organizer.outer)) for (const innerLabel of buckets(pair, organizer.inner)) {
    if (!pair.worker && (!pair.card || !visibleCards.has(pair.card.id))) continue
    const outerId = JSON.stringify(['floor', organizer.outer, outerLabel]), id = JSON.stringify([outerId, organizer.inner, innerLabel])
    let group = groups.get(id)
    if (!group) { group = { id, outerId, outerLabel, innerLabel, label: organizer.inner === 'none' ? outerLabel : innerLabel, executionIds: [], cardIds: [], homeIds: [], claimIds: [], workers: [], cards: [] }; groups.set(id, group); memberships.set(id, []) }
    memberships.get(id)!.push(pair)
    if (pair.worker && !group.executionIds.includes(pair.worker.id)) { group.executionIds.push(pair.worker.id); group.workers.push(pair.worker); group.homeIds.push(pair.worker.home) }
    if (pair.card && visibleCards.has(pair.card.id) && !group.cardIds.includes(pair.card.id)) { group.cardIds.push(pair.card.id); group.cards.push(pair.card) }
  }
  const compareGroup = (a: string, b: string, id: FloorField | 'none') => Number(blank(a)) - Number(blank(b)) || (id === 'none' ? 0 : field(id).kind === 'date' ? dateBuckets.indexOf(a) - dateBuckets.indexOf(b) : compareValue(a, b, id)) || a.localeCompare(b)
  const direction = organizer.direction === 'asc' ? 1 : -1
  for (const group of groups.values()) {
    // Sorting counterparts uses only links that occur in this exact subdivision.
    const localPairs = memberships.get(group.id)!
    const workerOrder = new Map<string, string | number>(), cardOrder = new Map<string, string | number>()
    const compareScalar = (a: string | number, b: string | number) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    for (const pair of localPairs) for (const value of values(scene, pair, organizer.order)) {
      const kind = field(organizer.order).kind
      const scalar = kind === 'date' ? dateTimestamp(value) : kind === 'priority' ? priorityRank(value) : value
      if (typeof scalar === 'number' && !Number.isFinite(scalar)) continue
      for (const [id, map] of [[pair.worker?.id, workerOrder], [pair.card?.id, cardOrder]] as const) {
        if (!id) continue
        const previous = map.get(id)
        if (previous === undefined || direction * compareScalar(scalar, previous) < 0) map.set(id, scalar)
      }
    }
    const compare = (a: Execution | SceneCard, b: Execution | SceneCard, order: Map<string, string | number>) => {
      const av = order.get(a.id), bv = order.get(b.id)
      return Number(av === undefined) - Number(bv === undefined) || (av !== undefined && bv !== undefined ? direction * compareScalar(av, bv) : 0) || a.id.localeCompare(b.id)
    }
    group.workers.sort((a, b) => compare(a, b, workerOrder)); group.cards.sort((a, b) => compare(a, b, cardOrder))
    group.claimIds = scene.claims.filter(c => group.executionIds.includes(c.executionId) && group.cardIds.includes(c.cardId)).map(c => c.id)
    group.homeIds = [...new Set(group.homeIds)]
  }
  return [...groups.values()].sort((a, b) => compareGroup(a.outerLabel, b.outerLabel, organizer.outer) || compareGroup(a.innerLabel, b.innerLabel, organizer.inner))
}

export function resolveFloorGroup(scene: FloorScene, state: PresentationState, id: string, now: number) {
  const groups = organizedGroups(scene, state, now)
  const inner = groups.find(g => g.id === id)
  if (inner) return inner
  const children = groups.filter(g => g.outerId === id)
  if (children.length) return {
    id, label: children[0]!.outerLabel,
    cardIds: [...new Set(children.flatMap(g => g.cardIds))],
    executionIds: [...new Set(children.flatMap(g => g.executionIds))],
  }
  return Object.values(scene.arrangements).flat().find(g => g.id === id)
}
