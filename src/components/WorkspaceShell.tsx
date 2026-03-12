import { useCallback, useMemo, useState } from 'react'
import type { GroupingDimension, Run, TreeNode } from '../domain/types'
import { buildWorkspaceView } from '../domain/view-models'
import { useBackendState } from '../hooks/useBackendState'
import { CreateEntityDialog, type CreateDialogState } from './CreateEntityDialog'
import { CreateSessionDialog } from './CreateSessionDialog'
import { SettingsDialog } from './SettingsDialog'
import { GroupingControls } from './GroupingControls'
import HierarchySidebar from './HierarchySidebar'
import { InfiniteCanvas } from './InfiniteCanvas'
import { SelectionProvider, useSelection } from './SelectionProvider'

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
  const [dimensions, setDimensions] = useState<GroupingDimension[]>(() => {
    try {
      const stored = localStorage.getItem('tinstar-dimensions')
      if (stored) return JSON.parse(stored) as GroupingDimension[]
    } catch { /* ignore */ }
    return ['initiative', 'epic', 'task']
  })

  const { runRepo, taxRepo } = useBackendState()

  const { sidebarTree, runSummaries } = useMemo(
    () => buildWorkspaceView(dimensions, runRepo, taxRepo),
    [dimensions, runRepo, taxRepo],
  )

  // Build runs map for InfiniteCanvas
  const runMap = useMemo(() => {
    const map = new Map<string, Run>()
    for (const run of runRepo.getAll()) {
      map.set(run.id, run)
    }
    return map
  }, [runRepo])

  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null)
  const [showSessionDialog, setShowSessionDialog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const { select, expandAll } = useSelection()

  const handleDimensionsChange = useCallback((dims: GroupingDimension[]) => {
    setDimensions(dims)
    localStorage.setItem('tinstar-dimensions', JSON.stringify(dims))
  }, [])

  const handleRename = useCallback((entityId: string, type: GroupingDimension, newName: string) => {
    const endpointMap: Record<string, string> = {
      initiative: '/api/initiatives',
      epic: '/api/epics',
      task: '/api/tasks',
      worktree: '/api/worktrees',
    }
    const endpoint = endpointMap[type]
    if (!endpoint) return
    fetch(`${endpoint}/${entityId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    })
  }, [])

  const handleAdd = useCallback((parentId: string | null, type: GroupingDimension | 'run') => {
    if (type === 'run') return
    // Determine the parent's type from the dimensions hierarchy
    const typeIdx = dimensions.indexOf(type)
    const parentType = typeIdx > 0 ? dimensions[typeIdx - 1] : null
    setCreateDialog({ parentId, parentType, childType: type })
  }, [dimensions])

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
        <div className="flex items-center gap-3 ml-4 flex-shrink-0">
          <button
            className="px-3 py-1 text-xs bg-primary/20 text-primary border border-primary/40 rounded-full hover:bg-primary/30"
            onClick={() => setShowSessionDialog(true)}
            data-testid="new-session-btn"
          >
            + Session
          </button>
          <button
            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-primary rounded hover:bg-white/5 transition-colors"
            onClick={() => setShowSettings(true)}
            data-testid="settings-btn"
            aria-label="Settings"
          >
            <span className="material-symbols-outlined text-base">settings</span>
          </button>
          <span data-testid="status-area" className="text-xs text-slate-500">
            {runSummaries.size} runs
          </span>
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
            onRename={handleRename}
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

      {createDialog && (
        <CreateEntityDialog
          dialog={createDialog}
          onClose={() => setCreateDialog(null)}
        />
      )}

      {showSessionDialog && (
        <CreateSessionDialog onClose={() => setShowSessionDialog(false)} />
      )}

      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} />
      )}
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
