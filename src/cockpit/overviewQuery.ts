import Fuse from 'fuse.js'
import { askReturnSchema, type AskReturn } from '../shared/ask'

/** A worker the overview can match. `id` is the First Mate task id shown as the name. */
export interface FilterableWorker {
  id: string
  objective: string
}

export interface OverviewLocation {
  page?: 'releases' | 'pulls'
  origin?: AskReturn
  card?: string
  /** First Mate task id, or null when the overview is showing. */
  worker: string | null
  /** Folder name of the worker's First Mate home, or null to take the only worker with that task id. */
  home: string | null
  /** Per-home worker key chosen in the cockpit. Never written to the URL. */
  key: string | null
  /** Legacy overview filter text retained in URLs; the two-column Overview does not apply it. */
  q: string
}

export interface LinkableWorker {
  key: string
  id: string
  /** Absolute First Mate home path. */
  home: string
}

/** The name a link uses for a First Mate home: its last folder name, never the full path. */
export function homeName(home: string): string {
  return home.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || home
}

/**
 * Workers whose name or objective fuzzy-matches `query`, in the original order.
 * An empty query returns the same list so grouping can run on this result unchanged.
 */
export function filterWorkers<T extends FilterableWorker>(workers: T[], query: string): T[] {
  const q = query.trim()
  if (!q) return workers
  const hits = new Set(new Fuse(workers, {
    keys: ['id', 'objective'],
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 1,
  }).search(q).map(hit => hit.item))
  return workers.filter(worker => hits.has(worker))
}

/**
 * The worker a location names: the selected key when there is one, else the task id's first match in the
 * named home, or its only match when no home is named.
 */
export function findLinkedWorker<T extends LinkableWorker>(workers: T[], location: OverviewLocation): T | null {
  if (!location.worker) return null
  if (location.key) return workers.find(worker => worker.key === location.key) ?? null
  const matches = workers.filter(worker => worker.id === location.worker)
  if (location.home === null) return matches.length === 1 ? matches[0]! : null
  return matches.find(worker => homeName(worker.home) === location.home) ?? null
}

/** The location to put in the URL: the home is kept only when its task id is in more than one home. */
export function linkLocation(workers: LinkableWorker[], location: OverviewLocation): OverviewLocation {
  const shared = workers.filter(worker => worker.id === location.worker).length > 1
  return { ...location, home: shared ? location.home : null }
}

export function readOverviewSearch(search: string): OverviewLocation {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  let origin: AskReturn | undefined
  try { const parsed = askReturnSchema.safeParse(JSON.parse(params.get('origin') ?? 'null')); if (parsed.success && parsed.data.section === (params.get('view') ?? 'overview')) origin = parsed.data } catch { /* Ignore an invalid locator; normal section navigation stays available. */ }
  const worker = params.get('worker')
  const home = params.get('home')
  return worker && worker.trim()
    ? { worker, home: home || null, key: null, q: params.get('q') ?? '' }
    : { worker: null, home: null, key: null, q: params.get('q') ?? '', ...(origin ? { origin } : {}), ...(['releases', 'pulls'].includes(params.get('view') ?? '') ? { page: params.get('view') as 'releases' | 'pulls' } : {}), ...(params.get('card')?.match(/^[a-f0-9]{32}$/) ? { card: params.get('card')! } : {}) }
}

/** Merge the overview params into the current query string, preserving anything else. */
export function writeOverviewSearch(currentSearch: string, next: OverviewLocation): string {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch)
  if (next.worker && next.worker.trim()) params.set('worker', next.worker)
  else params.delete('worker')
  if (next.worker && next.home) params.set('home', next.home)
  else params.delete('home')
  if (next.q.trim()) params.set('q', next.q)
  else params.delete('q')
  if (next.page && !next.worker) params.set('view', next.page)
  else params.delete('view')
  if (next.card && !next.page && !next.worker) params.set('card', next.card)
  else params.delete('card')
  if (next.origin && next.origin.section === (next.page ?? 'overview') && !next.worker) params.set('origin', JSON.stringify(next.origin))
  else params.delete('origin')
  const text = params.toString()
  return text ? `?${text}` : ''
}
