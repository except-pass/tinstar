import { describe, expect, it } from 'vitest'
import { filterWorkers, findLinkedWorker, linkLocation, readOverviewSearch, writeOverviewSearch, type FilterableWorker } from './overviewQuery'

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
    expect(readOverviewSearch('?worker=alpha&q=harbor')).toEqual({ worker: 'alpha', home: null, q: 'harbor' })
    expect(readOverviewSearch('?worker=alpha&home=%2Fhomes%2Fb')).toEqual({ worker: 'alpha', home: '/homes/b', q: '' })
    expect(readOverviewSearch('')).toEqual({ worker: null, home: null, q: '' })
    expect(readOverviewSearch('?worker=&home=%2Fhomes%2Fb')).toEqual({ worker: null, home: null, q: '' })
  })

  it('writes the worker and filter without dropping other params', () => {
    expect(writeOverviewSearch('?v6=1', { worker: 'alpha', home: null, q: 'harbor' })).toBe('?v6=1&worker=alpha&q=harbor')
    expect(writeOverviewSearch('?worker=alpha&home=%2Fhomes%2Fb&q=harbor&v6=1', { worker: null, home: null, q: '' })).toBe('?v6=1')
  })

  it('round-trips a task id and home that need encoding', () => {
    const search = writeOverviewSearch('', { worker: 'a/b c', home: '/homes/b', q: 'north window' })
    expect(readOverviewSearch(search)).toEqual({ worker: 'a/b c', home: '/homes/b', q: 'north window' })
  })
})

describe('worker links across First Mate homes', () => {
  const fleet = [
    { key: 'cockpit-0-shared', id: 'shared', home: '/homes/a' },
    { key: 'cockpit-1-shared', id: 'shared', home: '/homes/b' },
    { key: 'cockpit-1-solo', id: 'solo', home: '/homes/b' },
  ]

  it('names the home in the URL only when the task id is in more than one home', () => {
    expect(linkLocation(fleet, { worker: 'shared', home: '/homes/b', q: '' })).toEqual({ worker: 'shared', home: '/homes/b', q: '' })
    expect(linkLocation(fleet, { worker: 'solo', home: '/homes/b', q: 'x' })).toEqual({ worker: 'solo', home: null, q: 'x' })
    expect(linkLocation(fleet, { worker: null, home: '/homes/b', q: '' })).toEqual({ worker: null, home: null, q: '' })
  })

  it('opens the worker in the named home, or the only match when no home is named', () => {
    expect(findLinkedWorker(fleet, { worker: 'shared', home: '/homes/b', q: '' })?.key).toBe('cockpit-1-shared')
    expect(findLinkedWorker(fleet, { worker: 'shared', home: '/homes/a', q: '' })?.key).toBe('cockpit-0-shared')
    expect(findLinkedWorker(fleet, { worker: 'solo', home: null, q: '' })?.key).toBe('cockpit-1-solo')
    expect(findLinkedWorker(fleet, { worker: 'solo', home: '/homes/a', q: '' })).toBeNull()
    expect(findLinkedWorker(fleet, { worker: 'shared', home: null, q: '' })).toBeNull()
  })

  it('keeps each home reachable when a selection round-trips through its URL', () => {
    for (const worker of fleet) {
      const search = writeOverviewSearch('', linkLocation(fleet, { worker: worker.id, home: worker.home, q: '' }))
      expect(findLinkedWorker(fleet, readOverviewSearch(search))?.key).toBe(worker.key)
    }
  })
})
