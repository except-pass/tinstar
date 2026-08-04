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

// Unregistered widget types fall back to the module's default run size.
const RUN_W = 1560
const RUN_H = 1410
const RUN_GAP = 20 // mirrors the module constant

function disjoint(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.x >= b.x + b.width || b.x >= a.x + a.width
    || a.y >= b.y + b.height || b.y >= a.y + a.height
}

function expectNoOverlaps(layouts: Map<string, WidgetLayout>) {
  const entries = [...layouts.entries()]
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i]!
      const [idB, b] = entries[j]!
      expect(disjoint(a, b), `${idA} overlaps ${idB}`).toBe(true)
    }
  }
}

describe('hydrateLayouts packs new standalone runs instead of drifting right', () => {
  /** Five run-sized cards in a 3-wide grid with a hole at row 2, column 2. */
  const gridWithHole: Record<string, WidgetLayout> = {
    r1: { x: 0, y: 0, width: RUN_W, height: RUN_H },
    r2: { x: RUN_W + RUN_GAP, y: 0, width: RUN_W, height: RUN_H },
    r3: { x: 2 * (RUN_W + RUN_GAP), y: 0, width: RUN_W, height: RUN_H },
    r4: { x: 0, y: RUN_H + RUN_GAP, width: RUN_W, height: RUN_H },
    r5: { x: 2 * (RUN_W + RUN_GAP), y: RUN_H + RUN_GAP, width: RUN_W, height: RUN_H },
  }

  it('reuses the gap a closed session left behind', () => {
    const tree = ['r1', 'r2', 'r3', 'r4', 'r5', 'fresh'].map(id => node(id))
    const out = hydrateLayouts(tree, gridWithHole)
    const fresh = out.get('fresh')!
    expect(fresh.x).toBe(RUN_W + RUN_GAP)
    expect(fresh.y).toBe(RUN_H + RUN_GAP)
    expectNoOverlaps(out)
  })

  it('stays bounded as sessions accumulate one at a time', () => {
    // The regression: each spawn used to land past the right edge of ALL
    // content, so the Nth session sat N widget-widths from the first.
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5']
    let persisted: Record<string, WidgetLayout> = { ...gridWithHole }
    let out = new Map<string, WidgetLayout>()
    for (let i = 0; i < 6; i++) {
      ids.push(`new${i}`)
      out = hydrateLayouts(ids.map(id => node(id)), persisted)
      persisted = Object.fromEntries(out)
    }
    // 11 nodes → a ceil(sqrt(11)) = 4 column grid, so nothing may reach past
    // the 4th column. Old behavior put the last spawn out past x = 14000.
    const rightEdge = Math.max(...[...out.values()].map(l => l.x + l.width))
    expect(rightEdge).toBeLessThanOrEqual(4 * (RUN_W + RUN_GAP))
    expectNoOverlaps(out)
  })

  it('ignores persisted layouts of nodes that have left the tree', () => {
    // A closed session's layout stays in config (a late-arriving widget may
    // still claim it). Treating it as occupied space is what pushed new
    // sessions ever further out with nothing visible to explain the gap.
    const withGhost = { ...gridWithHole, ghost: { x: 100_000, y: 0, width: RUN_W, height: RUN_H } }
    const tree = ['r1', 'r2', 'r3', 'r4', 'r5', 'fresh'].map(id => node(id))
    const fresh = hydrateLayouts(tree, withGhost).get('fresh')!
    expect(fresh).toBeDefined()
    expect(fresh.x).toBe(RUN_W + RUN_GAP)
    expect(fresh.y).toBe(RUN_H + RUN_GAP)
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

  it('drops a new root-level run into the nearest empty space (no overlap)', () => {
    const tree = ['a', 'b', 'c', 'd', 'e', 'fresh'].map(id => node(id))
    const out = hydrateLayouts(tree, persisted)
    const fresh = out.get('fresh')!
    expect(fresh).toBeDefined()
    // The existing widgets are far smaller than a run card, so the first free
    // cell in the top row is just past the rightmost edge (500).
    expect(fresh.x).toBe(500 + RUN_GAP)
    expect(fresh.y).toBe(0)
    // Sanity: it overlaps none of the existing rects.
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(disjoint(fresh, out.get(id)!)).toBe(true)
    }
  })
})
