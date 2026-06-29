// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { hydrateLayouts, type WidgetLayout } from '../useWidgetLayouts'
import type { TreeNode } from '../../domain/types'

function node(id: string, type = 'browser-widget'): TreeNode {
  return {
    id, label: id, type, entityId: id, children: [],
    runCount: 0, activeCount: 0,
  }
}

const SEEDED: WidgetLayout = { x: 1234, y: 5678, width: 640, height: 480 }

describe('hydrateLayouts seed threading', () => {
  it('applies the seed in a fresh space with no persisted layouts', () => {
    const tree = [node('browser-1')]
    const seed = new Map([['browser-1', SEEDED]])
    // !persisted path previously fell straight to generateDefaultLayouts and
    // dropped the seed.
    const out = hydrateLayouts(tree, null, seed)
    expect(out.get('browser-1')).toEqual(SEEDED)
  })

  it('applies the seed on the >20%-missing regeneration path', () => {
    // Two nodes; persisted only covers an unrelated, no-longer-present id, so
    // <80% of the tree is covered → regeneration path.
    const tree = [node('browser-1'), node('browser-2')]
    const persisted = { 'stale-x': { x: 0, y: 0, width: 10, height: 10 } }
    const seed = new Map([['browser-1', SEEDED]])
    const out = hydrateLayouts(tree, persisted, seed)
    expect(out.get('browser-1')).toEqual(SEEDED)
    // The unseeded node still gets some default layout (not dropped).
    expect(out.get('browser-2')).toBeDefined()
  })

  it('only seeds ids that exist in the current tree', () => {
    const tree = [node('browser-1')]
    const seed = new Map([['browser-1', SEEDED], ['ghost', SEEDED]])
    const out = hydrateLayouts(tree, null, seed)
    expect(out.has('ghost')).toBe(false)
  })
})

describe('hydrateLayouts empty-space placement for a new standalone run', () => {
  // Five positioned root-level nodes + one new one → 1/6 ≈ 17% missing, under
  // the 20% threshold, so the fill path (smart placement) runs instead of a
  // from-scratch regeneration.
  const persisted: Record<string, WidgetLayout> = {
    a: { x: 0, y: 0, width: 100, height: 100 },
    b: { x: 200, y: 0, width: 100, height: 100 },
    c: { x: 0, y: 200, width: 100, height: 100 },
    d: { x: 200, y: 200, width: 100, height: 100 },
    e: { x: 400, y: 50, width: 100, height: 100 }, // rightmost edge = 500
  }
  const RUN_GAP = 20 // mirrors the module constant

  it('drops a new root-level run to the right of all existing content (no overlap)', () => {
    const tree = ['a', 'b', 'c', 'd', 'e', 'fresh'].map(id => node(id))
    const out = hydrateLayouts(tree, persisted)
    const fresh = out.get('fresh')!
    expect(fresh).toBeDefined()
    // Lands just past the rightmost existing edge (500), top-aligned to the
    // highest existing node (y=0) — guaranteed-empty space.
    expect(fresh.x).toBe(500 + RUN_GAP)
    expect(fresh.y).toBe(0)
    // Sanity: it overlaps none of the existing rects.
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const o = out.get(id)!
      const disjoint =
        fresh.x >= o.x + o.width || o.x >= fresh.x + fresh.width ||
        fresh.y >= o.y + o.height || o.y >= fresh.y + fresh.height
      expect(disjoint).toBe(true)
    }
  })
})
