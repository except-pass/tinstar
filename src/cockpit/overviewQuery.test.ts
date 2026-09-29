import { describe, expect, it } from 'vitest'
import { filterWorkers, findLinkedWorker, homeName, linkLocation, readOverviewSearch, writeOverviewSearch, type FilterableWorker } from './overviewQuery'

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
  it('reads a worker task id, home name and filter', () => {
    expect(readOverviewSearch('?worker=alpha&q=harbor')).toEqual({ worker: 'alpha', home: null, key: null, q: 'harbor' })
    expect(readOverviewSearch('?worker=alpha&home=b')).toEqual({ worker: 'alpha', home: 'b', key: null, q: '' })
    expect(readOverviewSearch('')).toEqual({ worker: null, home: null, key: null, q: '' })
    expect(readOverviewSearch('?worker=&home=b')).toEqual({ worker: null, home: null, key: null, q: '' })
  })

  it('writes the worker and filter without dropping other params', () => {
    expect(writeOverviewSearch('?v6=1', { worker: 'alpha', home: null, key: 'cockpit-0-alpha', q: 'harbor' })).toBe('?v6=1&worker=alpha&q=harbor')
    expect(writeOverviewSearch('?worker=alpha&home=b&q=harbor&v6=1', { worker: null, home: null, key: null, q: '' })).toBe('?v6=1')
  })

  it('round-trips a task id and home that need encoding', () => {
    const search = writeOverviewSearch('', { worker: 'a/b c', home: 'home b', key: null, q: 'north window' })
    expect(readOverviewSearch(search)).toEqual({ worker: 'a/b c', home: 'home b', key: null, q: 'north window' })
  })
})

describe('worker links across First Mate homes', () => {
  const fleet = [
    { key: 'cockpit-0-shared', id: 'shared', home: '/Users/me/homes/a' },
    { key: 'cockpit-1-shared', id: 'shared', home: '/Users/me/homes/b/' },
    { key: 'cockpit-1-solo', id: 'solo', home: '/Users/me/homes/b/' },
    { key: 'cockpit-2-shared', id: 'shared', home: '/Users/other/homes/a' },
  ]
  const select = (worker: typeof fleet[number], q = '') => ({ worker: worker.id, home: homeName(worker.home), key: worker.key, q })

  it('names a home by its folder name', () => {
    expect(homeName('/Users/me/homes/a')).toBe('a')
    expect(homeName('/Users/me/homes/b/')).toBe('b')
  })

  it('puts the home folder name in the URL only when the task id is in more than one home', () => {
    const shared = writeOverviewSearch('', linkLocation(fleet, select(fleet[1]!)))
    expect(shared).toBe('?worker=shared&home=b')
    expect(shared).not.toContain('Users')
    expect(writeOverviewSearch('', linkLocation(fleet, select(fleet[2]!, 'x')))).toBe('?worker=solo&q=x')
    expect(writeOverviewSearch('', linkLocation(fleet, { worker: null, home: 'b', key: null, q: '' }))).toBe('')
  })

  it('keeps the selected worker by key in memory', () => {
    for (const worker of fleet) expect(findLinkedWorker(fleet, select(worker))?.key).toBe(worker.key)
  })

  it('opens a link in the named home, the first home with that name, or the only match when no home is named', () => {
    expect(findLinkedWorker(fleet, readOverviewSearch('?worker=shared&home=b'))?.key).toBe('cockpit-1-shared')
    expect(findLinkedWorker(fleet, readOverviewSearch('?worker=shared&home=a'))?.key).toBe('cockpit-0-shared')
    expect(findLinkedWorker(fleet, readOverviewSearch('?worker=solo'))?.key).toBe('cockpit-1-solo')
    expect(findLinkedWorker(fleet, readOverviewSearch('?worker=solo&home=a'))).toBeNull()
    expect(findLinkedWorker(fleet, readOverviewSearch('?worker=shared'))).toBeNull()
    expect(findLinkedWorker(fleet, readOverviewSearch('?worker=shared&home=%2FUsers%2Fme%2Fhomes%2Fb'))).toBeNull()
  })
})
