// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { generateDefaultLayouts, type WidgetLayout } from '../useWidgetLayouts'
import type { TreeNode } from '../../domain/types'

function node(id: string, type = 'browser-widget'): TreeNode {
  return {
    id, label: id, type, entityId: id, children: [],
    runCount: 0, activeCount: 0,
  }
}

// The widget registry is not populated in this unit env, so leaves resolve to
// the module's fallbacks: default 1560×1410, global minimum 300×150. The
// size-preservation logic under test is registry-independent.
const FALLBACK = { width: 1560, height: 1410 }
const MIN = { width: 300, height: 150 }

describe('generateDefaultLayouts size preservation', () => {
  it('uses the default size when there is no prior layout', () => {
    const out = generateDefaultLayouts([node('browser-1')])
    const l = out.get('browser-1')!
    expect(l.width).toBe(FALLBACK.width)
    expect(l.height).toBe(FALLBACK.height)
  })

  it('keeps a hand-sized leaf at its current size through a re-layout', () => {
    const tree = [node('browser-1')]
    const prev = new Map<string, WidgetLayout>([
      ['browser-1', { x: 10, y: 10, width: 640, height: 480 }],
    ])
    const out = generateDefaultLayouts(tree, prev)
    const l = out.get('browser-1')!
    // Size is preserved; only position is recomputed.
    expect(l.width).toBe(640)
    expect(l.height).toBe(480)
  })

  it('floors a stale sub-minimum prior size at the minimum', () => {
    const tree = [node('browser-1')]
    const prev = new Map<string, WidgetLayout>([
      ['browser-1', { x: 0, y: 0, width: 50, height: 50 }],
    ])
    const out = generateDefaultLayouts(tree, prev)
    const l = out.get('browser-1')!
    expect(l.width).toBe(MIN.width)
    expect(l.height).toBe(MIN.height)
  })

  it('falls back to the default for a leaf absent from prior layouts', () => {
    const tree = [node('browser-1'), node('browser-2')]
    const prev = new Map<string, WidgetLayout>([
      ['browser-1', { x: 0, y: 0, width: 700, height: 500 }],
    ])
    const out = generateDefaultLayouts(tree, prev)
    expect(out.get('browser-1')!.width).toBe(700)
    // browser-2 had no prior layout → default, not preserved.
    expect(out.get('browser-2')!.width).toBe(FALLBACK.width)
    expect(out.get('browser-2')!.height).toBe(FALLBACK.height)
  })
})
