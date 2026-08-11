import { describe, expect, it } from 'vitest'
import { buildScopeTree, flattenUnscopedForCanvas } from '../scopeTree'
import type { TreeNode, Worktree } from '../types'

function leaf(id: string, project?: string, worktree?: string): TreeNode {
  return {
    id,
    entityId: id,
    label: id,
    type: id.startsWith('run-') ? 'run' : 'plugin-widget',
    children: [],
    runCount: id.startsWith('run-') ? 1 : 0,
    activeCount: 0,
    scope: { project, worktree },
  }
}

const worktrees: Worktree[] = [
  { id: 'tinstar/taskReorg', name: 'taskReorg', branch: 'taskReorg', repo: 'Tinstar', worktreePath: '/tmp/taskReorg' },
]

describe('buildScopeTree', () => {
  it('groups every widget by project then worktree', () => {
    const tree = buildScopeTree(
      [leaf('run-one', 'Tinstar', 'taskReorg'), leaf('pw-graveyard', 'Tinstar', 'taskReorg')],
      ['Tinstar'],
      worktrees,
    )

    expect(tree).toHaveLength(1)
    expect(tree[0]?.type).toBe('project')
    expect(tree[0]?.children[0]?.type).toBe('worktree')
    expect(tree[0]?.children[0]?.children.map(node => node.id)).toEqual(['run-one', 'pw-graveyard'])
  })

  it('keeps project-only and unscoped widgets distinct', () => {
    const tree = buildScopeTree(
      [leaf('run-project', 'Tinstar'), leaf('pw-loose')],
      ['Tinstar'],
      worktrees,
    )

    expect(tree.find(node => node.type === 'project')?.children.map(node => node.id)).toContain('run-project')
    expect(tree.find(node => node.type === 'unscoped')?.children.map(node => node.id)).toEqual(['pw-loose'])
  })

  it('retains empty registered projects and worktrees as drop targets', () => {
    const tree = buildScopeTree([], ['Tinstar'], worktrees)
    expect(tree[0]?.id).toBe('project-Tinstar')
    expect(tree[0]?.children[0]?.id).toBe('worktree-Tinstar--taskReorg')
  })

  it('uses the git branch as the organizational worktree name', () => {
    const tree = buildScopeTree(
      [leaf('run-one', 'Tinstar', 'feature/scope')],
      ['Tinstar'],
      [{ ...worktrees[0]!, name: 'Friendly session', branch: 'feature/scope' }],
    )

    const worktreeNodes = tree[0]?.children.filter(node => node.type === 'worktree') ?? []
    expect(worktreeNodes).toHaveLength(1)
    expect(worktreeNodes[0]?.label).toBe('feature/scope')
    expect(worktreeNodes[0]?.children.map(node => node.id)).toEqual(['run-one'])
  })
})

describe('flattenUnscopedForCanvas', () => {
  it('arranges unscoped widgets as standalone roots', () => {
    const tree = buildScopeTree([leaf('pw-loose')], [], [])
    expect(flattenUnscopedForCanvas(tree).map(node => node.id)).toEqual(['pw-loose'])
  })
})
