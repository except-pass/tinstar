import { describe, expect, it } from 'vitest'
import { emptyPortfolio, seedColumns } from '../../portfolio/model'
import type { Epic, PortfolioDoc } from '../../portfolio/types'
import { RETENTION_MS, activeBoard, epicHiddenFromActiveBoard } from '../retention'

const NOW = Date.parse('2026-09-25T12:00:00.000Z')

function epic(over: Partial<Epic>): Epic {
  return {
    id: 'epic',
    title: 'Epic',
    columnId: 'col-inbox',
    initiativeId: null,
    planSlug: null,
    completedAt: null,
    order: 0,
    revision: '1',
    ...over,
  }
}

describe('epic retention', () => {
  it('hides on completion age and ignores a column named Done', () => {
    const done = epic({ id: 'epic-done', columnId: 'col-done', completedAt: null })
    const fresh = epic({ id: 'epic-fresh', completedAt: new Date(NOW - RETENTION_MS + 1).toISOString() })
    const exact = epic({ id: 'epic-exact', completedAt: new Date(NOW - RETENTION_MS).toISOString() })
    const old = epic({ id: 'epic-old', completedAt: new Date(NOW - RETENTION_MS - 1).toISOString() })

    expect(epicHiddenFromActiveBoard(done, NOW)).toBe(false)
    expect(epicHiddenFromActiveBoard(fresh, NOW)).toBe(false)
    expect(epicHiddenFromActiveBoard(exact, NOW)).toBe(false)
    expect(epicHiddenFromActiveBoard(old, NOW)).toBe(true)

    const doc: PortfolioDoc = {
      ...emptyPortfolio(),
      fixture: true,
      columns: [
        ...seedColumns(),
        { id: 'col-done', name: 'Done', description: 'A label, not a signal', order: 4, revision: '1' },
      ],
      epics: [done, fresh, exact, old],
    }
    const view = activeBoard(doc, NOW)
    expect(view.board.epics.map(item => item.id)).toEqual(['epic-done', 'epic-fresh', 'epic-exact'])
    expect(view.archivedEpicIds).toEqual(['epic-old'])
    expect(view.board.columns.some(column => column.name === 'Done')).toBe(true)
    expect(doc.epics).toHaveLength(4)
  })
})
