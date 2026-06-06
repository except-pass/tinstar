import { describe, it, expect } from 'vitest'
import { buildMoveTargets } from '../moveTargets'
import type { TreeNode } from '../types'

const node = (id: string, type: string, children: TreeNode[] = []): TreeNode =>
  ({ id, label: id, type, entityId: id, children } as TreeNode)

// tree: container 'task-1' wraps run 'run-A'; plus leaf 'browser-1' at top level
const tree: TreeNode[] = [
  node('task-1', 'task', [node('run-A', 'run')]),
  node('browser-1', 'browser-widget'),
]
const layouts = new Map<string, { x: number; y: number; width: number; height: number }>([
  ['run-A', { x: 0, y: 0, width: 100, height: 100 }],
  ['browser-1', { x: 10, y: 10, width: 100, height: 100 }],
  // task-1 has a layout but is a container → excluded
  ['task-1', { x: 0, y: 0, width: 400, height: 400 }],
])
const isContainer = (id: string) => id === 'task-1'
const labelOf = (id: string) => (id === 'run-A' ? 'Run A' : id === 'browser-1' ? 'Browser' : id)
const slotsOf = (id: string) => (id === 'run-A' ? [3] : [])

describe('buildMoveTargets', () => {
  it('lists non-container leaves that have a layout, with label + slots', () => {
    const out = buildMoveTargets(tree, layouts, { isContainer, labelOf, slotsOf })
    expect(out).toEqual([
      { id: 'run-A', label: 'Run A', slots: [3] },
      { id: 'browser-1', label: 'Browser', slots: [] },
    ])
  })
  it('excludes containers even if they have a layout', () => {
    const out = buildMoveTargets(tree, layouts, { isContainer, labelOf, slotsOf })
    expect(out.find((t) => t.id === 'task-1')).toBeUndefined()
  })
  it('excludes leaves without a layout', () => {
    const noLayout = new Map(layouts); noLayout.delete('browser-1')
    const out = buildMoveTargets(tree, noLayout, { isContainer, labelOf, slotsOf })
    expect(out.map((t) => t.id)).toEqual(['run-A'])
  })
})
