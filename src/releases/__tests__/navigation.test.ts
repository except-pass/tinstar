import { describe, expect, it } from 'vitest'
import { readOverviewSearch, writeOverviewSearch } from '../../cockpit/overviewQuery'

describe('Releases and linked-card URL navigation', () => {
  it('round trips Releases and preserves unrelated URL parameters', () => {
    const location = readOverviewSearch('?view=releases&other=retained')
    expect(location.page).toBe('releases')
    expect(writeOverviewSearch('?other=retained', location)).toBe('?other=retained&view=releases')
  })
  it('leaves Releases when opening a worker or card and does not leak the old card destination', () => {
    const card = 'a'.repeat(32)
    expect(readOverviewSearch(`?card=${card}`).card).toBe(card)
    const worker = readOverviewSearch('?worker=task&view=releases')
    expect(worker.page).toBeUndefined()
    expect(writeOverviewSearch(`?view=releases&card=${card}`, worker)).toBe('?worker=task')
    expect(writeOverviewSearch(`?view=releases&card=${card}`, { worker: null, home: null, key: null, q: '' })).toBe('')
    expect(readOverviewSearch('?card=not-authorized-format').card).toBeUndefined()
  })
})
