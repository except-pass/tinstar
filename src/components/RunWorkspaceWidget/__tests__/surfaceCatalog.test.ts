import { describe, it, expect } from 'vitest'
import { SURFACE_CATALOG, fuzzyScore, searchSurfaceCatalog } from '../surfaceCatalog'

describe('surfaceCatalog', () => {
  it('seeds the expected templates, PR review included (U5)', () => {
    const ids = SURFACE_CATALOG.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['pr-review', 'dataflow', 'open-points', 'checklist']))
    const pr = SURFACE_CATALOG.find((t) => t.id === 'pr-review')!
    // The PR-review prompt names the two columns, the blind eval, and the refresh recipe.
    expect(pr.prompt).toMatch(/two-column/i)
    expect(pr.prompt).toMatch(/intent/i)
    expect(pr.prompt).toMatch(/blind/i)
    expect(pr.prompt).toMatch(/refresh` recipe/i)
  })

  describe('fuzzyScore', () => {
    it('scores a substring high with a prefix bonus', () => {
      expect(fuzzyScore('pr', 'PR review')).toBeGreaterThan(fuzzyScore('review', 'PR review'))
      expect(fuzzyScore('pr', 'PR review')).toBeGreaterThanOrEqual(150) // prefix
    })
    it('matches a subsequence at a lower score', () => {
      expect(fuzzyScore('prv', 'PR review')).toBeGreaterThan(0) // p..r..v subsequence
      expect(fuzzyScore('prv', 'PR review')).toBeLessThan(fuzzyScore('pr', 'PR review'))
    })
    it('returns 0 for a non-match and 1 for an empty query', () => {
      expect(fuzzyScore('zzq', 'PR review')).toBe(0)
      expect(fuzzyScore('', 'anything')).toBe(1)
    })
  })

  describe('searchSurfaceCatalog', () => {
    it('empty query returns the whole catalog in order', () => {
      expect(searchSurfaceCatalog('')).toEqual(SURFACE_CATALOG)
      expect(searchSurfaceCatalog('   ')).toEqual(SURFACE_CATALOG)
    })
    it('ranks the intended template first', () => {
      expect(searchSurfaceCatalog('pr')[0]?.id).toBe('pr-review')
      expect(searchSurfaceCatalog('flow')[0]?.id).toBe('dataflow')
      expect(searchSurfaceCatalog('check')[0]?.id).toBe('checklist')
    })
    it('matches on description too, weighted below name', () => {
      // "diagram" appears only in Dataflow's description → it surfaces.
      expect(searchSurfaceCatalog('diagram').map((t) => t.id)).toContain('dataflow')
    })
    it('a non-match returns nothing (freeform still available to the caller)', () => {
      expect(searchSurfaceCatalog('zzqx')).toEqual([])
    })
  })
})
