import { useState, useCallback, useMemo } from 'react'
import type { GroupingDimension, TreeNode } from '../domain/types'
import { SelectionProvider, useSelection } from './SelectionProvider'
import { useWorkspaceView } from '../domain/view-models'
import { runRepository } from '../domain/repositories'
import HierarchySidebar from './HierarchySidebar'
import { GroupingControls } from './GroupingControls'
import { InfiniteCanvas } from './InfiniteCanvas'
import type { Run } from '../domain/types'

/** Walk the tree to find the path of ancestor node IDs for a given node ID */
function findAncestorIds(tree: TreeNode[], targetId: string): string[] {
  function walk(nodes: TreeNode[], path: string[]): string[] | null {
    for (const node of nodes) {
      if (node.id === targetId) return path
      if (node.children.length > 0) {
        const result = walk(node.children, [...path, node.id])
        if (result) return result
      }
    }
    return null
  }
  return walk(tree, []) ?? []
}

function WorkspaceShellInner() {
  const [dimensions, setDimensions] = useState<GroupingDimension[]>([
    'initiative',
    'epic',
    'task',
  ])

  const { sidebarTree, runSummaries } = useWorkspaceView(dimensions)

  // Build runs map for InfiniteCanvas
  const runMap = useMemo(() => {
    const map = new Map<string, Run>()
    for (const run of runRepository.getAll()) {
      map.set(run.id, run)
    }
    return map
  }, [])

  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  const { select, expandAll } = useSelection()

  const handleDimensionsChange = useCallback((dims: GroupingDimension[]) => {
    setDimensions(dims)
  }, [])

  const handleAdd = useCallback((_parentId: string | null, type: GroupingDimension | 'run') => {
    console.log(`Add ${type} — not wired yet`)
  }, [])

  const handleFocusRun = useCallback((runId: string) => {
    setFocusRunId(runId)
  }, [])

  const handleFocusHandled = useCallback(() => {
    setFocusRunId(null)
  }, [])

  // Click on canvas widget → select in hierarchy + expand ancestors
  const handleSelectRun = useCallback((runId: string) => {
    const nodeId = `run-${runId}`
    const ancestors = findAncestorIds(sidebarTree, nodeId)
    if (ancestors.length > 0) expandAll(ancestors)
    select(nodeId, 'run')
  }, [sidebarTree, select, expandAll])

  // Double-click on canvas widget → zoom to fit
  const handleCanvasFocusRun = useCallback((runId: string) => {
    setFocusRunId(runId)
    handleSelectRun(runId)
  }, [handleSelectRun])

  return (
    <div className="flex flex-col h-screen w-screen bg-surface-base text-slate-200 font-mono">
      {/* Top bar: GroupingControls + status */}
      <div
        className="flex items-center justify-between px-4 py-2 bg-surface-panel border-b border-white/10"
        data-testid="controls-bar"
      >
        <GroupingControls
          activeDimensions={dimensions}
          onDimensionsChange={handleDimensionsChange}
        />
        <div data-testid="status-area" className="text-xs text-slate-500 ml-4 flex-shrink-0">
          {runSummaries.size} runs
        </div>
      </div>

      {/* Main area: sidebar + canvas */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div
          className="w-60 flex-shrink-0 bg-surface-panel border-r border-white/10 overflow-y-auto scrollbar-thin"
          data-testid="sidebar-slot"
        >
          <HierarchySidebar
            tree={sidebarTree}
            dimensions={dimensions}
            onAdd={handleAdd}
            onFocusRun={handleFocusRun}
          />
        </div>

        {/* Canvas */}
        <div className="flex-1 relative overflow-hidden" data-testid="canvas-slot">
          <InfiniteCanvas
            tree={sidebarTree}
            runMap={runMap}
            focusRunId={focusRunId}
            onFocusHandled={handleFocusHandled}
            onSelectRun={handleSelectRun}
            onFocusRun={handleCanvasFocusRun}
          />
        </div>
      </div>
    </div>
  )
}

export default function WorkspaceShell() {
  return (
    <SelectionProvider>
      <WorkspaceShellInner />
    </SelectionProvider>
  )
}
