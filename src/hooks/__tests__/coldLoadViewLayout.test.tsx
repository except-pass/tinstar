// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWidgetLayouts } from '../useWidgetLayouts'
import { pruneCanvasRuns } from '../../domain/canvasVisibility'
import { registerWidgetComponent } from '../../widgets/widgetComponentRegistry'
import type { TreeNode } from '../../domain/types'

const run = (id: string, view?: string): TreeNode => ({
  id: `run-${id}`, label: id, type: 'run', entityId: id, children: [], runCount: 1, activeCount: 0, view,
})

const disposables: Array<{ dispose(): void }> = []
afterEach(() => { for (const d of disposables.splice(0)) d.dispose() })

/**
 * COLD LOAD ORDER: the SSE snapshot (runs, including an observed first mate worker
 * with view 'firstmate-worker') arrives and lays out BEFORE the bundled plugin has
 * registered its widget. The widget registers only when the plugin boot pipeline
 * finishes (`pluginsBooted`). The card must still end up at its own 1000x560, not the
 * run-workspace default it would get if layout ran while the type was unregistered.
 */
describe('cold-load layout of a plugin-viewed run', () => {
  const runs = [run('a', 'test-cold-view')]

  it('sizes the card by its widget even though the widget registers after the first layout', async () => {
    // t0: snapshot in, plugin NOT booted, widget NOT registered.
    const tree0 = pruneCanvasRuns(runs, { hiddenRunIds: new Set(), pluginsBooted: false })
    const { result, rerender } = renderHook(({ tree }) => useWidgetLayouts(tree), { initialProps: { tree: tree0 } })
    expect(result.current.layouts.has('run-a')).toBe(false)   // held back, not laid out at the wrong size

    // t1: plugin boot pipeline finishes: the widget registers, THEN the shell flips pluginsBooted.
    disposables.push(registerWidgetComponent({
      type: 'test-cold-view', component: (() => null) as never, isContainer: false,
      defaultSize: { width: 1000, height: 560 }, minSize: { width: 520, height: 260 },
    }, 'plugin'))
    const tree1 = pruneCanvasRuns(runs, { hiddenRunIds: new Set(), pluginsBooted: true })
    await act(async () => { rerender({ tree: tree1 }); await Promise.resolve() })

    const l = result.current.layouts.get('run-a')!
    expect([l.width, l.height]).toEqual([1000, 560])
  })

  it('shows the failure this guards against: laying out before the widget registers uses the run-workspace size', () => {
    const naive = renderHook(() => useWidgetLayouts(runs))
    const l = naive.result.current.layouts.get('run-a')!
    expect(l.width).toBeGreaterThan(1000)
  })
})

describe('pruneCanvasRuns', () => {
  it('holds back only plugin-viewed runs until plugins boot, and always drops hidden runs', () => {
    const tree = [run('plain'), run('viewed', 'v'), run('hidden')]
    const ids = (t: TreeNode[]) => t.map(c => c.entityId)
    expect(ids(pruneCanvasRuns(tree, { hiddenRunIds: new Set(['hidden']), pluginsBooted: false }))).toEqual(['plain'])
    expect(ids(pruneCanvasRuns(tree, { hiddenRunIds: new Set(['hidden']), pluginsBooted: true }))).toEqual(['plain', 'viewed'])
    expect(pruneCanvasRuns(tree, { hiddenRunIds: new Set(), pluginsBooted: true })).toBe(tree)
  })
})
