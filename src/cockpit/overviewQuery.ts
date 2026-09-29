import Fuse from 'fuse.js'

/** A worker the overview can match. `id` is the First Mate task id shown as the name. */
export interface FilterableWorker {
  id: string
  objective: string
}

export interface OverviewLocation {
  /** First Mate task id, or null when the overview is showing. */
  worker: string | null
  /** Overview filter text. Empty means every worker. */
  q: string
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

export function readOverviewSearch(search: string): OverviewLocation {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const worker = params.get('worker')
  return { worker: worker && worker.trim() ? worker : null, q: params.get('q') ?? '' }
}

/** Merge the overview params into the current query string, preserving anything else. */
export function writeOverviewSearch(currentSearch: string, next: OverviewLocation): string {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch)
  if (next.worker && next.worker.trim()) params.set('worker', next.worker)
  else params.delete('worker')
  if (next.q.trim()) params.set('q', next.q)
  else params.delete('q')
  const text = params.toString()
  return text ? `?${text}` : ''
}
