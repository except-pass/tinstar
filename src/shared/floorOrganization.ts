import { codexTurn } from './codexActivity'
import { compareStatus, floorWorkerStatus, hasDonutFilter, statusRank, unknownStatus } from './floorStatus'
import type { Execution, SceneCard } from '../server/reconciliation/scene'
import type { FloorScene, PresentationState } from './reconciliationPresentation'
import { homeLabel } from './reconciliationLabels'
import { directNeighbors, hasSearch, searchSeeds } from './smartSearch'

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
export interface Organizer { outer: FloorField | 'none'; inner: FloorField | 'none'; order: FloorField | 'operational'; direction: 'asc' | 'desc' }
export interface StatusFilter { preset: 'operational' | 'all' | 'custom'; statuses: string[] }
export const organizerPresets = {
  initiative: { outer: 'initiative', inner: 'manager', order: 'operational', direction: 'asc' },
  machine: { outer: 'machine', inner: 'initiative', order: 'operational', direction: 'asc' },
  manager: { outer: 'manager', inner: 'initiative', order: 'operational', direction: 'asc' },
} as const satisfies Record<string, Organizer>
export const defaultOrganizer = (): Organizer => ({ ...organizerPresets.initiative })
export const organizerPreset = (organizer: Organizer) => (Object.keys(organizerPresets) as Array<keyof typeof organizerPresets>).find(key => {
  const preset = organizerPresets[key]
  return (Object.keys(preset) as Array<keyof Organizer>).every(slot => organizer[slot] === preset[slot])
})
export const defaultStatusFilter = (): StatusFilter => ({ preset: 'operational', statuses: [] })
export const operationalStatuses = ['In Progress', 'Queued', 'Waiting', 'Waiting For', 'Waiting for Prod Release', 'Ready for Review', 'In review', 'Delegated to person']
export const statusName = (card: SceneCard) => String(card.source.properties.Status?.value ?? '').trim()
export const cardStatusName = (card: SceneCard) => statusName(card) || unknownStatus
export const matchesStatus = (card: SceneCard, filter: StatusFilter) => filter.preset === 'all' || (filter.preset === 'operational' ? operationalStatuses : filter.statuses).includes(statusName(card))
export const currentStatusOptions = (scene: FloorScene) => [...new Set([...(scene.statusOptions ?? []), ...scene.cards.map(statusName)].filter(Boolean))].sort((a, b) => a.localeCompare(b))
export const historyRecord = (worker: Execution) => codexTurn(worker.source, Date.now()) === null && (['finished', 'absent'].includes(worker.liveness) || worker.source.endpoint.exists === false ||
  /^(?:done|landed)(?=\s|:|$)/i.test(String(worker.source.lastEventText ?? worker.source.last_event.raw ?? '')) ||
  ['done', 'landed'].includes(String(worker.source.last_event.state)))
export const activeWorker = (worker: Execution) => worker.kind !== 'secondmate' && !historyRecord(worker)

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
export function floorFieldValues(scene: FloorScene, pair: Pair, id: FloorField): string[] {
  const { worker: w, card: c } = pair
  let raw: unknown
  switch (id) {
    case 'manager': raw = w ? homeLabel(scene.coverage.homes.find(h => h.source.home === w.home)?.source ?? { home: w.home }) : null; break
    case 'machine': raw = w?.placement.machine; break
    case 'workerStatus': raw = w ? floorWorkerStatus(w) : null; break
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
/** The same canonical graph supplies the floor and both candidate histograms.
 * A donut ignores its own selections; only the opposite donut narrows it.
 * Base scope is applied first. With both selections, only valid linked pairs
 * survive. No source record or claim is rewritten by this projection. */
export function statusProjection(scene: FloorScene, state: PresentationState, now: number) {
  const selection = state.donutFilter ?? { cards: [], workers: [] }
  const searching = hasSearch(state.search)
  const matched = searching ? directNeighbors(scene, searchSeeds(scene, state.search!, now)) : null
  const focused = state.searchFocus?.length ? directNeighbors(scene, state.searchFocus) : null
  const seeds = focused ? state.search?.patterns.length && matched ? new Set([...focused].filter(key => matched.has(key))) : focused : matched
  const reveal = state.search?.patterns.length ? new Set<string>() : state.searchReveal?.kind === 'card' && state.searchReveal.id === state.navigation?.cardId
    ? new Set([`card:${state.searchReveal.id}`])
    : directNeighbors(scene, state.searchFocus ?? (state.searchReveal ? [state.searchReveal] : []))
  const explicit = hasDonutFilter(selection) || searching || reveal.size > 0
  const workers = [...new Map(scene.executions.filter(w => (activeWorker(w) || !!state.search?.patterns.length && seeds?.has(`execution:${w.id}`) || reveal.has(`execution:${w.id}`)) && (!seeds || seeds.has(`execution:${w.id}`) || reveal.has(`execution:${w.id}`))).map(w => [w.id, w])).values()]
  const cards = [...new Map(scene.cards.filter(c => !c.source.in_trash && (!c.source.archived || reveal.has(`card:${c.id}`)) && (!seeds || seeds.has(`card:${c.id}`) || reveal.has(`card:${c.id}`)) && (
    reveal.has(`card:${c.id}`) ||
    matchesStatus(c, state.statusFilter ?? defaultStatusFilter()) || !explicit && (
      state.navigation?.cardId === c.id || state.selection?.kind === 'card' && state.selection.id === c.id ||
      state.flash && state.flash.until > now && state.flash.ids.includes(`card:${c.id}`)
    )
  )).map(c => [c.id, c])).values()]
  const workerIds = new Set(workers.map(w => w.id)), cardIds = new Set(cards.map(c => c.id))
  const links = scene.claims.filter(c => c.basis === 'explicit' && c.verification === 'confirmed' && c.state === 'current' && workerIds.has(c.executionId) && cardIds.has(c.cardId))
  const selectedWorkers = new Set(workers.filter(w => !selection.workers.length || selection.workers.includes(floorWorkerStatus(w))).map(w => w.id))
  const selectedCards = new Set(cards.filter(c => !selection.cards.length || selection.cards.includes(statusName(c) || unknownStatus)).map(c => c.id))
  const linkedWorkers = new Set(links.filter(c => selectedCards.has(c.cardId)).map(c => c.executionId))
  const linkedCards = new Set(links.filter(c => selectedWorkers.has(c.executionId)).map(c => c.cardId))
  const workerCandidates = workers.filter(w => !selection.cards.length || linkedWorkers.has(w.id))
  const cardCandidates = cards.filter(c => !selection.workers.length || linkedCards.has(c.id))
  return {
    explicit, workerCandidates, cardCandidates,
    workers: workers.filter(w => reveal.has(`execution:${w.id}`) || workerCandidates.includes(w) && selectedWorkers.has(w.id)),
    cards: cards.filter(c => reveal.has(`card:${c.id}`) || cardCandidates.includes(c) && selectedCards.has(c.id)),
  }
}

/** Explicit link pairs preserve correlation across mixed-domain nested fields.
 * Endpoints are unioned independently; reference instances keep canonical IDs. */
export function organizedGroups(scene: FloorScene, state: PresentationState, now: number): FloorGroup[] {
  const organizer = state.organizer ?? defaultOrganizer()
  const { workers, cards, explicit } = statusProjection(scene, state, now)
  const workerMap = new Map(workers.map(w => [w.id, w])), cardMap = new Map((explicit ? cards : scene.cards).map(c => [c.id, c]))
  const pairs: Pair[] = [], linkedWorkers = new Set<string>(), linkedCards = new Set<string>()
  for (const claim of scene.claims) {
    if (claim.basis !== 'explicit' || claim.verification !== 'confirmed' || claim.state !== 'current') continue
    const worker = workerMap.get(claim.executionId), card = cardMap.get(claim.cardId)
    if (worker && card) { pairs.push({ worker, card }); linkedWorkers.add(worker.id); linkedCards.add(card.id) }
  }
  for (const worker of workers) if (!linkedWorkers.has(worker.id)) pairs.push({ worker })
  for (const card of cards) if (!linkedCards.has(card.id)) pairs.push({ card })
  const visibleCards = new Set(cards.map(c => c.id)), groups = new Map<string, FloorGroup>(), memberships = new Map<string, Pair[]>()
  const buckets = (pair: Pair, id: FloorField | 'none') => id === 'none' ? ['All work'] : field(id).kind === 'date'
    ? [...new Set((floorFieldValues(scene, pair, id).length ? floorFieldValues(scene, pair, id) : [null]).map(v => dateBucket(v, now, id === 'checkIn')))]
    : floorFieldValues(scene, pair, id).length ? [...new Set(floorFieldValues(scene, pair, id))] : ['Unassigned / Unknown']
  for (const pair of pairs) for (const outerLabel of buckets(pair, organizer.outer)) for (const innerLabel of buckets(pair, organizer.inner)) {
    if (!pair.worker && (!pair.card || !visibleCards.has(pair.card.id))) continue
    const outerId = JSON.stringify(['floor', organizer.outer, outerLabel]), id = JSON.stringify([outerId, organizer.inner, innerLabel])
    let group = groups.get(id)
    if (!group) { group = { id, outerId, outerLabel, innerLabel, label: organizer.inner === 'none' ? outerLabel : innerLabel, executionIds: [], cardIds: [], homeIds: [], claimIds: [], workers: [], cards: [] }; groups.set(id, group); memberships.set(id, []) }
    memberships.get(id)!.push(pair)
    if (pair.worker && !group.executionIds.includes(pair.worker.id)) { group.executionIds.push(pair.worker.id); group.workers.push(pair.worker); group.homeIds.push(pair.worker.home) }
    if (pair.card && visibleCards.has(pair.card.id) && !group.cardIds.includes(pair.card.id)) { group.cardIds.push(pair.card.id); group.cards.push(pair.card) }
  }
  // Configured parent-home paths establish hierarchy; labels alone never do.
  const managerPath = (label: string) => {
    const home = scene.coverage.homes.find(h => homeLabel(h.source) === label)
    if (!home) return [label]
    const path: string[] = [], seen = new Set<string>()
    let current: typeof home | undefined = home
    while (current && !seen.has(current.source.home)) {
      seen.add(current.source.home); path.unshift(homeLabel(current.source))
      const parent: string | undefined = current.source.parentHome
      current = scene.coverage.homes.find(h => h.source.home === parent)
    }
    return path
  }
  const compareManager = (a: string, b: string) => {
    const ap = managerPath(a), bp = managerPath(b)
    for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
      const compared = ap[i]!.localeCompare(bp[i]!)
      if (compared) return compared
    }
    return ap.length - bp.length || a.localeCompare(b)
  }
  const compareGroup = (a: string, b: string, id: FloorField | 'none') => Number(blank(a)) - Number(blank(b)) || (id === 'none' ? 0 : field(id).kind === 'date' ? dateBuckets.indexOf(a) - dateBuckets.indexOf(b) : id === 'manager' && organizer.outer === 'manager' ? compareManager(a, b) : compareValue(a, b, id)) || a.localeCompare(b)
  const direction = organizer.direction === 'asc' ? 1 : -1
  for (const group of groups.values()) {
    // Sorting counterparts uses only links that occur in this exact subdivision.
    const localPairs = memberships.get(group.id)!
    const workerOrder = new Map<string, string | number>(), cardOrder = new Map<string, string | number>()
    const compareScalar = (a: string | number, b: string | number) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    if (organizer.order !== 'operational') for (const pair of localPairs) for (const value of floorFieldValues(scene, pair, organizer.order)) {
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
    const checkIns = new Map<string, number>()
    for (const pair of localPairs) {
      const dates = floorFieldValues(scene, pair, 'checkIn').map(dateTimestamp).filter(Number.isFinite)
      if (!dates.length) continue
      const earliest = Math.min(...dates)
      for (const id of [pair.worker?.id, pair.card?.id]) if (id) checkIns.set(id, Math.min(checkIns.get(id) ?? Infinity, earliest))
    }
    const operational = (a: Execution | SceneCard, b: Execution | SceneCard, domain: 'cards' | 'workers') => {
      const status = (entity: Execution | SceneCard) => domain === 'workers' ? floorWorkerStatus(entity as Execution) : statusName(entity as SceneCard)
      const title = (entity: Execution | SceneCard) => domain === 'workers' ? String((entity as Execution).source.backlog.title || (entity as Execution).identity.task_id || '') : String((entity as SceneCard).source.properties.Name?.value || '')
      const at = checkIns.get(a.id) ?? Infinity, bt = checkIns.get(b.id) ?? Infinity
      return Number(statusRank(status(a), domain) === 10000) - Number(statusRank(status(b), domain) === 10000) || direction * compareStatus(status(a), status(b), domain) || (at === bt ? 0 : at < bt ? -1 : 1) || title(a).localeCompare(title(b)) || a.id.localeCompare(b.id)
    }
    group.workers.sort((a, b) => organizer.order === 'operational' ? operational(a, b, 'workers') : compare(a, b, workerOrder))
    group.cards.sort((a, b) => organizer.order === 'operational' ? operational(a, b, 'cards') : compare(a, b, cardOrder))
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
