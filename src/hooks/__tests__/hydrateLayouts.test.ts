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
