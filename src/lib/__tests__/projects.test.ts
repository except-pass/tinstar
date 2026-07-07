import { describe, it, expect } from 'vitest'
import { parseProjects, sortByOrder, groupForPicker, reorderByDrop, type Project } from '../projects'

function proj(over: Partial<Project> & { name: string }): Project {
  return { path: `/p/${over.name}`, starred: false, hidden: false, order: 0, ...over }
}

describe('parseProjects', () => {
  it('parses the new object-valued map', () => {
    const out = parseProjects({
      alpha: { path: '/a', starred: true, hidden: false, order: 2 },
      beta: { path: '/b', starred: false, hidden: true, order: 0 },
    })
    expect(out).toContainEqual({ name: 'alpha', path: '/a', starred: true, hidden: false, order: 2 })
    expect(out).toContainEqual({ name: 'beta', path: '/b', starred: false, hidden: true, order: 0 })
  })

  it('tolerates the legacy string-valued form, defaulting flags and order to position', () => {
    const out = parseProjects({ alpha: '/a', beta: '/b' } as never)
    expect(out[0]).toEqual({ name: 'alpha', path: '/a', starred: false, hidden: false, order: 0 })
    expect(out[1]).toEqual({ name: 'beta', path: '/b', starred: false, hidden: false, order: 1 })
  })

  it('defaults missing object fields', () => {
    const out = parseProjects({ alpha: { path: '/a' } } as never)
    expect(out[0]).toEqual({ name: 'alpha', path: '/a', starred: false, hidden: false, order: 0 })
  })

  it('returns [] for null/undefined/non-object', () => {
    expect(parseProjects(null)).toEqual([])
    expect(parseProjects(undefined)).toEqual([])
  })
})

describe('sortByOrder', () => {
  it('sorts ascending by order without mutating the input', () => {
    const input = [proj({ name: 'c', order: 2 }), proj({ name: 'a', order: 0 }), proj({ name: 'b', order: 1 })]
    const sorted = sortByOrder(input)
    expect(sorted.map(p => p.name)).toEqual(['a', 'b', 'c'])
    expect(input.map(p => p.name)).toEqual(['c', 'a', 'b']) // original untouched
  })
})

describe('groupForPicker', () => {
  it('drops hidden projects and sorts each group by order', () => {
    const { favorites, others } = groupForPicker([
      proj({ name: 'star2', starred: true, order: 3 }),
      proj({ name: 'plain1', order: 1 }),
      proj({ name: 'gone', hidden: true, order: 0 }),
      proj({ name: 'star1', starred: true, order: 2 }),
    ])
    expect(favorites.map(p => p.name)).toEqual(['star1', 'star2'])
    expect(others.map(p => p.name)).toEqual(['plain1'])
  })

  it('does not leak a hidden+starred project into favorites', () => {
    const { favorites, others } = groupForPicker([
      proj({ name: 'secret', starred: true, hidden: true, order: 0 }),
      proj({ name: 'visible', order: 1 }),
    ])
    expect(favorites).toEqual([])
    expect(others.map(p => p.name)).toEqual(['visible'])
  })
})

describe('reorderByDrop', () => {
  const names = ['a', 'b', 'c', 'd']

  it('dragging down onto a lower item inserts AFTER it', () => {
    expect(reorderByDrop(names, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
  })

  it('can move an item to the last slot (regression: was unreachable)', () => {
    expect(reorderByDrop(names, 'a', 'd')).toEqual(['b', 'c', 'd', 'a'])
  })

  it('dragging an item down onto its immediate successor is not a no-op', () => {
    expect(reorderByDrop(names, 'a', 'b')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('dragging up inserts BEFORE the target', () => {
    expect(reorderByDrop(names, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('returns input unchanged for self-drop or unknown names', () => {
    expect(reorderByDrop(names, 'a', 'a')).toEqual(names)
    expect(reorderByDrop(names, 'z', 'b')).toEqual(names)
    expect(reorderByDrop(names, 'a', 'z')).toEqual(names)
  })
})
