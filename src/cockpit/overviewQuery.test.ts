import { describe, expect, it } from 'vitest'
import { filterWorkers, readOverviewSearch, writeOverviewSearch, type FilterableWorker } from './overviewQuery'

const workers: FilterableWorker[] = [
  { id: 'alpha', objective: 'Chart the harbor lights' },
  { id: 'bravo', objective: 'Mend the north window' },
  { id: 'tinstar-filter-link', objective: 'Add a filter bar for name or objective' },
]

describe('filterWorkers', () => {
  it('returns every worker, in order, when the query is blank', () => {
    expect(filterWorkers(workers, '   ')).toEqual(workers)
  })

  it('matches a name or an objective and keeps fleet order', () => {
    expect(filterWorkers(workers, 'harbor').map(worker => worker.id)).toEqual(['alpha'])
    expect(filterWorkers(workers, 'window').map(worker => worker.id)).toEqual(['bravo'])
    expect(filterWorkers(workers, 'filter').map(worker => worker.id)).toEqual(['tinstar-filter-link'])
    expect(filterWorkers(workers, 'a').map(worker => worker.id)).toEqual(['alpha', 'bravo', 'tinstar-filter-link'])
  })

  it('accepts a fuzzy misspelling and rejects an unrelated query', () => {
    expect(filterWorkers(workers, 'alpa').map(worker => worker.id)).toEqual(['alpha'])
    expect(filterWorkers(workers, 'windw').map(worker => worker.id)).toEqual(['bravo'])
    expect(filterWorkers(workers, 'zzzz')).toEqual([])
  })
})

describe('overview search params', () => {
  it('reads a worker task id and a filter', () => {
    expect(readOverviewSearch('?worker=alpha&q=harbor')).toEqual({ worker: 'alpha', q: 'harbor' })
    expect(readOverviewSearch('')).toEqual({ worker: null, q: '' })
    expect(readOverviewSearch('?worker=')).toEqual({ worker: null, q: '' })
  })

  it('writes the worker and filter without dropping other params', () => {
    expect(writeOverviewSearch('?v6=1', { worker: 'alpha', q: 'harbor' })).toBe('?v6=1&worker=alpha&q=harbor')
    expect(writeOverviewSearch('?worker=alpha&q=harbor&v6=1', { worker: null, q: '' })).toBe('?v6=1')
  })

  it('round-trips a task id that needs encoding', () => {
    const search = writeOverviewSearch('', { worker: 'a/b c', q: 'north window' })
    expect(readOverviewSearch(search)).toEqual({ worker: 'a/b c', q: 'north window' })
  })
})
