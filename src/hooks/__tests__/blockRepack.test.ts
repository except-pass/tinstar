// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  arrangeLayouts,
  blockRepack,
  generateDefaultLayouts,
  type TreeMaps,
  type WidgetLayout,
} from '../useWidgetLayouts'
import type { TreeNode } from '../../domain/types'

const L = (x: number, y: number, width: number, height: number): WidgetLayout => ({ x, y, width, height })

function node(id: string, type = 'browser-widget'): TreeNode {
  return { id, label: id, type, entityId: id, children: [], runCount: 0, activeCount: 0 }
}

/** Build TreeMaps for a flat list of top-level leaf nodes (no nesting). */
function flatTreeMaps(ids: string[]): TreeMaps {
  return {
    parentMap: new Map(),
    childrenMap: new Map(ids.map(id => [id, [] as string[]])),
    descendantsMap: new Map(ids.map(id => [id, new Set<string>()])),
    depthMap: new Map(ids.map(id => [id, 0])),
  }
}

function intersects(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

describe('blockRepack / arrangeLayouts — reset reserves constellation footprints', () => {
  // Scenario: run1 with a browser snapped below it (one cohesion group), plus a
  // second independent run. The default grid gives the browser its own cell and
  // drops run2 into the cell the browser collapses into, so the snapped browser
  // lands on top of run2 — the reported bug.
  const tree = [node('run1'), node('browser'), node('run2')]
  const treeMaps = flatTreeMaps(['run1', 'browser', 'run2'])
  const prev = new Map<string, WidgetLayout>([
    ['run1', L(0, 0, 800, 600)],
    ['browser', L(0, 600, 800, 400)], // snapped flush below run1
    ['run2', L(0, 5000, 800, 600)],
  ])

  it('REGRESSION: snapped browser does not overlap the neighbouring run after arrange', () => {
    const out = arrangeLayouts(tree, prev, treeMaps, [['run1', 'browser']])
    expect(intersects(out.get('browser')!, out.get('run2')!)).toBe(false)
    // And the browser keeps its pre-arrange relative offset to its run.
    const run1 = out.get('run1')!
    const browser = out.get('browser')!
    expect(browser.x - run1.x).toBe(0)
    expect(browser.y - run1.y).toBe(600)
  })

  it('keeps every group member at its pre-arrange relative offset to the anchor', () => {
    // Three-member constellation: run1 anchor, browser below, editor to the right.
    const t = [node('run1'), node('browser'), node('editor'), node('run2')]
    const tm = flatTreeMaps(['run1', 'browser', 'editor', 'run2'])
    const p = new Map<string, WidgetLayout>([
      ['run1', L(0, 0, 800, 600)],
      ['browser', L(0, 600, 800, 400)],   // +0, +600
      ['editor', L(800, 0, 500, 600)],    // +800, +0
      ['run2', L(0, 9000, 800, 600)],
    ])
    const out = arrangeLayouts(t, p, tm, [['run1', 'browser', 'editor']])
    const a = out.get('run1')!, b = out.get('browser')!, e = out.get('editor')!
    expect(b.x - a.x).toBe(0)
    expect(b.y - a.y).toBe(600)
    expect(e.x - a.x).toBe(800)
    expect(e.y - a.y).toBe(0)
    // No block overlaps the singleton run2.
    for (const id of ['run1', 'browser', 'editor']) {
      expect(intersects(out.get(id)!, out.get('run2')!)).toBe(false)
    }
  })

  it('no-constellation case is identical to generateDefaultLayouts', () => {
    // blockRepack with empty groups is a no-op…
    const fresh = generateDefaultLayouts(tree, prev)
    const repacked = blockRepack(new Map(fresh), treeMaps, [])
    expect([...repacked]).toEqual([...fresh])
    // …and the whole pipeline returns the default grid unchanged.
    const arranged = arrangeLayouts(tree, prev, treeMaps, [])
    expect([...arranged]).toEqual([...fresh])
  })

  it('a constellation contained within a single root is left to the default grid', () => {
    // run1 and browser both map to the same root → no cross-root merge, no repack.
    const out = blockRepack(new Map(generateDefaultLayouts(tree, prev)), treeMaps, [['run1', 'run1']])
    const fresh = generateDefaultLayouts(tree, prev)
    expect([...out]).toEqual([...fresh])
  })
})
