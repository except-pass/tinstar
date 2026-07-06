import { describe, it, expect } from 'vitest'
import { orderByHierarchy, orderedVisibleRunIds, visibleCycleQueue, cycleNext, cyclePrev } from './useReadyQueue'
import { isBackgroundHidden } from '../domain/background-visibility'
import type { Run, TreeNode } from '../domain/types'

function node(id: string, type: string, children: TreeNode[] = []): TreeNode {
  return { id, label: id, type, entityId: id, children, runCount: 0, activeCount: 0 }
}

describe('orderByHierarchy', () => {
  it('reorders names to match hierarchy (top-to-bottom) order', () => {
    const hierarchy = ['alpha', 'bravo', 'charlie', 'delta']
    const ready = ['delta', 'alpha', 'charlie']
    expect(orderByHierarchy(ready, hierarchy)).toEqual(['alpha', 'charlie', 'delta'])
  })

  it('keeps names not in the hierarchy at the end, in original order', () => {
    const hierarchy = ['alpha', 'bravo']
    const ready = ['ghost2', 'bravo', 'ghost1', 'alpha']
    expect(orderByHierarchy(ready, hierarchy)).toEqual(['alpha', 'bravo', 'ghost2', 'ghost1'])
  })

  it('returns a new array and does not mutate the input', () => {
    const ready = ['b', 'a']
    const result = orderByHierarchy(ready, ['a', 'b'])
    expect(ready).toEqual(['b', 'a'])
    expect(result).not.toBe(ready)
  })

  it('handles an empty hierarchy by preserving input order', () => {
    expect(orderByHierarchy(['c', 'a', 'b'], [])).toEqual(['c', 'a', 'b'])
  })

  it('handles an empty name list', () => {
    expect(orderByHierarchy([], ['a', 'b'])).toEqual([])
  })

  it('uses the first occurrence rank when hierarchy has duplicates', () => {
    const hierarchy = ['a', 'b', 'a']
    expect(orderByHierarchy(['b', 'a'], hierarchy)).toEqual(['a', 'b'])
  })
})

describe('orderedVisibleRunIds', () => {
  // task-A [expanded] → run-1, run-2 ; task-B [collapsed] → run-3
  const tree: TreeNode[] = [
    node('task-A', 'task', [node('run-1', 'run'), node('run-2', 'run')]),
    node('task-B', 'task', [node('run-3', 'run')]),
  ]

  it('walks runs top-to-bottom under expanded branches', () => {
    const expanded = new Set(['task-A', 'task-B'])
    expect(orderedVisibleRunIds(tree, id => expanded.has(id))).toEqual(['run-1', 'run-2', 'run-3'])
  })

  it('omits runs inside collapsed branches, matching what is rendered', () => {
    const expanded = new Set(['task-A']) // task-B collapsed → run-3 hidden
    expect(orderedVisibleRunIds(tree, id => expanded.has(id))).toEqual(['run-1', 'run-2'])
  })

  it('emits no runs when every branch is collapsed', () => {
    expect(orderedVisibleRunIds(tree, () => false)).toEqual([])
  })

  it('includes top-level run nodes regardless of expand state', () => {
    const flat: TreeNode[] = [node('run-x', 'run'), node('run-y', 'run')]
    expect(orderedVisibleRunIds(flat, () => false)).toEqual(['run-x', 'run-y'])
  })
})

describe('visibleCycleQueue', () => {
  it('drops candidates that are not in the visible order (membership, not just order)', () => {
    // 'hidden' is ready but not visible in the sidebar → must be excluded.
    expect(visibleCycleQueue(['alpha', 'bravo', 'hidden'], ['bravo', 'alpha'], true)).toEqual(['bravo', 'alpha'])
  })

  it('falls back to candidates only when no visible order has been reported', () => {
    expect(visibleCycleQueue(['alpha', 'bravo'], [], false)).toEqual(['alpha', 'bravo'])
  })

  it('yields an empty queue when the sidebar has reported an empty visible view', () => {
    // The active view filtered everything out and actively reported []. The
    // candidates must NOT be resurrected, or `[` / `]` could reach hidden runs.
    expect(visibleCycleQueue(['alpha', 'bravo'], [], true)).toEqual([])
  })

  it('cannot cycle to a filtered-out session', () => {
    const run = (id: string): Run => ({ id, sessionId: id } as Run)
    const runs = [run('alpha'), run('bravo'), run('hidden')]
    // 'hidden' is a ready session that the sidebar has filtered out.
    const queue = visibleCycleQueue(['alpha', 'bravo', 'hidden'], ['alpha', 'bravo'], true)
    // Cycling forward from the last visible session wraps back to the first
    // visible one, never landing on 'hidden'.
    expect(cycleNext(runs, queue, 'bravo')?.id).toBe('alpha')
    expect(cyclePrev(runs, queue, 'alpha')?.id).toBe('bravo')
    expect(queue).not.toContain('hidden')
  })
})

// Background sessions (R7): WorkspaceShell filters cycle candidates through
// `isBackgroundHidden` BEFORE they reach visibleCycleQueue, so background-
// hidden runs can't leak even on the pre-report fallback path (which returns
// candidates as-is). These tests pin that composition.
describe('cycle queue × background sessions', () => {
  const run = (id: string, background: boolean, attention?: Run['attention']): Run =>
    ({ id, sessionId: id, background, attention } as Run)

  const filterCandidates = (runs: Run[], showBackground: boolean): string[] =>
    runs.filter(r => !isBackgroundHidden(r, showBackground)).map(r => r.sessionId)

  const runs = [run('alpha', false), run('machinery', true), run('bravo', false)]

  it('excludes background-hidden runs from cycle candidates while hidden', () => {
    const candidates = filterCandidates(runs, false)
    const queue = visibleCycleQueue(candidates, ['alpha', 'bravo'], true)
    expect(queue).toEqual(['alpha', 'bravo'])
    // Cycling wraps across the visible runs, never landing on machinery.
    expect(cycleNext(runs, queue, 'bravo')?.id).toBe('alpha')
    expect(cyclePrev(runs, queue, 'alpha')?.id).toBe('bravo')
  })

  it('cannot leak background-hidden runs through the no-sidebar-report fallback', () => {
    const candidates = filterCandidates(runs, false)
    // hasReported=false → visibleCycleQueue returns the candidates untouched,
    // so the background run must already be gone from them.
    const queue = visibleCycleQueue(candidates, [], false)
    expect(queue).toEqual(['alpha', 'bravo'])
    expect(queue).not.toContain('machinery')
  })

  it('includes revealed background runs when the toggle is on', () => {
    const candidates = filterCandidates(runs, true)
    const queue = visibleCycleQueue(candidates, ['alpha', 'machinery', 'bravo'], true)
    expect(queue).toEqual(['alpha', 'machinery', 'bravo'])
    expect(cycleNext(runs, queue, 'alpha')?.id).toBe('machinery')
  })

  it('keeps a breakthrough background run cyclable while attention is pending (R16)', () => {
    const withAttention = [
      run('alpha', false),
      run('machinery', true, { level: 'urgent', reason: 'Waiting on permission', setAt: '2026-07-02T00:00:00.000Z' }),
    ]
    const candidates = filterCandidates(withAttention, false)
    expect(candidates).toContain('machinery')
    const queue = visibleCycleQueue(candidates, ['alpha', 'machinery'], true)
    expect(cycleNext(withAttention, queue, 'alpha')?.id).toBe('machinery')
  })
})
