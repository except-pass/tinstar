import { describe, it, expect } from 'vitest'
import { isBackgroundHidden, backgroundHiddenRunIds, pruneRunNodes } from '../background-visibility'
import type { AttentionState, TreeNode } from '../types'

const attn = (level: AttentionState['level'] = 'urgent'): AttentionState => ({
  level,
  reason: 'Waiting on permission',
  setAt: '2026-07-02T00:00:00.000Z',
})

function node(id: string, type: string, children: TreeNode[] = []): TreeNode {
  return { id, label: id, type, entityId: id, children, runCount: 0, activeCount: 0 }
}

describe('isBackgroundHidden', () => {
  it('hides a background run when the toggle is off and no attention is pending', () => {
    expect(isBackgroundHidden({ background: true }, false)).toBe(true)
  })

  it('exempts a background run with pending attention despite the toggle being off (R16)', () => {
    expect(isBackgroundHidden({ background: true, attention: attn() }, false)).toBe(false)
    // Every level breaks through, not just urgent.
    expect(isBackgroundHidden({ background: true, attention: attn('info') }, false)).toBe(false)
  })

  it('reveals a background run when the toggle is on', () => {
    expect(isBackgroundHidden({ background: true }, true)).toBe(false)
  })

  it('never affects non-background runs', () => {
    expect(isBackgroundHidden({ background: false }, false)).toBe(false)
    expect(isBackgroundHidden({ background: false }, true)).toBe(false)
    expect(isBackgroundHidden({ background: false, attention: attn() }, false)).toBe(false)
  })

  // R15/R16 selection-clear seam: WorkspaceShell clears selection when the
  // selected run's predicate result transitions false → true.
  it('flips from exempt to eligible when attention clears on a background run', () => {
    const before = isBackgroundHidden({ background: true, attention: attn() }, false)
    const after = isBackgroundHidden({ background: true, attention: undefined }, false)
    expect(before).toBe(false)
    expect(after).toBe(true)
  })

  it('flips from exempt to eligible when a visible run is demoted to background', () => {
    const before = isBackgroundHidden({ background: false }, false)
    const after = isBackgroundHidden({ background: true }, false)
    expect(before).toBe(false)
    expect(after).toBe(true)
  })
})

describe('backgroundHiddenRunIds', () => {
  it('collects only the prune-eligible run ids', () => {
    const runs = [
      { id: 'r-bg', background: true },
      { id: 'r-bg-attn', background: true, attention: attn() },
      { id: 'r-fg', background: false },
    ]
    expect(backgroundHiddenRunIds(runs, false)).toEqual(new Set(['r-bg']))
  })

  it('is empty when the toggle is on', () => {
    const runs = [{ id: 'r-bg', background: true }, { id: 'r-fg', background: false }]
    expect(backgroundHiddenRunIds(runs, true)).toEqual(new Set())
  })
})

describe('pruneRunNodes', () => {
  const tree: TreeNode[] = [
    node('task-A', 'task', [node('r-bg', 'run'), node('r-fg', 'run')]),
    node('task-B', 'task', [node('r-other', 'run')]),
    node('r-top', 'run'),
  ]

  it('drops pruned run nodes at any depth, keeping containers', () => {
    const pruned = pruneRunNodes(tree, new Set(['r-bg', 'r-top']))
    expect(pruned.map(n => n.id)).toEqual(['task-A', 'task-B'])
    expect(pruned[0]?.children.map(n => n.id)).toEqual(['r-fg'])
    expect(pruned[1]?.children.map(n => n.id)).toEqual(['r-other'])
  })

  it('only prunes run-type nodes, never containers sharing an id', () => {
    const pruned = pruneRunNodes(tree, new Set(['task-A']))
    expect(pruned).toBe(tree) // task-A is not a run node → untouched
  })

  it('preserves identity for untouched subtrees', () => {
    const pruned = pruneRunNodes(tree, new Set(['r-bg']))
    expect(pruned[1]).toBe(tree[1]) // task-B subtree untouched
    expect(pruned[2]).toBe(tree[2])
  })

  it('returns the input identity when nothing matches', () => {
    expect(pruneRunNodes(tree, new Set(['nope']))).toBe(tree)
  })
})
