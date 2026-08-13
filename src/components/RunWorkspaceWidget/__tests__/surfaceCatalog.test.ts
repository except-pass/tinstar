import { describe, it, expect } from 'vitest'
import { SURFACE_CATALOG, fuzzyScore, searchSurfaceCatalog } from '../../../slate/surfaceCatalog'
import {
  SEVERITY_SCALE, LIKELIHOOD_SCALE, DISCOVERABILITY_SCALE,
  REVERSAL_ACTION_SCALE, REVERSAL_DAMAGE_SCALE, HORIZON_SCALE,
} from '../../../a2ui/controls'

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
    expect(SURFACE_CATALOG.every(template => !template.prompt.includes('.tinstar/slate/'))).toBe(true)
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

describe('decision template', () => {
  it('is in the catalog', () => {
    expect(SURFACE_CATALOG.some(t => t.id === 'decision')).toBe(true)
  })

  it('is findable by fuzzy search', () => {
    expect(searchSurfaceCatalog('decision')[0]?.id).toBe('decision')
    expect(searchSurfaceCatalog('dec').map(t => t.id)).toContain('decision')
  })

  it('names every scale value in its prompt so the agent cannot invent one', () => {
    const { prompt } = SURFACE_CATALOG.find(t => t.id === 'decision')!
    // Derived from the exported scale constants, not a hand-copied word list —
    // a scale renamed in controls.ts (e.g. severe → critical) fails HERE instead
    // of leaving the prompt silently teaching a word the parser no longer accepts.
    const allValues: readonly string[] = [
      ...SEVERITY_SCALE, ...LIKELIHOOD_SCALE, ...DISCOVERABILITY_SCALE,
      ...REVERSAL_ACTION_SCALE, ...REVERSAL_DAMAGE_SCALE, ...HORIZON_SCALE,
    ]
    for (const v of allValues) {
      expect(prompt).toContain(v)
    }
  })

  it('keeps the question stable and distinguishes evidence from hypotheses', () => {
    const decision = SURFACE_CATALOG.find(t => t.id === 'decision')!
    expect(decision.allowsRefresh).toBe(false)
    expect(decision.prompt).toMatch(/verified facts.*source|source or observation time/i)
    expect(decision.prompt).toMatch(/hypotheses/i)
    expect(decision.prompt).toMatch(/unverified alert.*leading choice/i)
    expect(decision.prompt).toMatch(/another valid outcome/i)
    expect(decision.prompt).toMatch(/Do not set a `refresh` recipe/i)
  })

  it('keeps decisions out of the grouped open-points template', () => {
    const { description, prompt } = SURFACE_CATALOG.find(t => t.id === 'open-points')!
    expect(description).toMatch(/non-decision questions/i)
    expect(prompt).toMatch(/unrelated questions in separate Surfaces/i)
    expect(prompt).toMatch(/dedicated Decision Surface for each human choice/i)
  })
})
