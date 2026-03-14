import { useCallback, useMemo, useRef, useState } from 'react'
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
import { TaxonomyProvider } from './TaxonomyContext'
import { EntityMenu } from './EntityMenu'
import { EntitySettingsDialog } from './EntitySettingsDialog'
import { ActiveScopeProvider } from '../hotkeys/ActiveScopeContext'
import { HotgroupProvider } from '../hotkeys/HotgroupContext'

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

  const { runRepo, taxRepo, spaces, activeSpaceId } = useBackendState()

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

  const runIds = useMemo(() => Array.from(runMap.keys()), [runMap])

  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null)
  const [showSessionDialog, setShowSessionDialog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [entityMenu, setEntityMenu] = useState<{
    entityId: string; entityType: GroupingDimension; entityName: string; anchorRect: DOMRect
  } | null>(null)
  const [entitySettingsDialog, setEntitySettingsDialog] = useState<{
    entityId: string; entityType: GroupingDimension; entityName: string
  } | null>(null)
  const [sessionPrefill, setSessionPrefill] = useState<{ taskId?: string } | null>(null)
  const { select, toggleSelect, expandAll, selectedCount } = useSelection()
  const arrangeGridRef = useRef<(() => void) | null>(null)
  const arrangeResetRef = useRef<(() => void) | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const sidebarResizeDragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onSidebarResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    sidebarResizeDragRef.current = { startX: e.clientX, startW: sidebarWidth }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [sidebarWidth])

  const onSidebarResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!sidebarResizeDragRef.current) return
    setSidebarWidth(Math.max(160, Math.min(400, sidebarResizeDragRef.current.startW + (e.clientX - sidebarResizeDragRef.current.startX))))
  }, [])

  const onSidebarResizePointerUp = useCallback(() => {
    sidebarResizeDragRef.current = null
  }, [])

  // Space actions
  const handleActivateSpace = useCallback((id: string) => {
    fetch(`/api/spaces/${id}/activate`, { method: 'POST' })
  }, [])

  const handleCreateSpace = useCallback((name: string) => {
    fetch('/api/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  }, [])

  const handleRenameSpace = useCallback((id: string, name: string) => {
    fetch(`/api/spaces/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  }, [])

  const handleDeleteSpace = useCallback((id: string) => {
    fetch(`/api/spaces/${id}`, { method: 'DELETE' })
  }, [])

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

  const handleDelete = useCallback((entityId: string, type: GroupingDimension | string) => {
    if (type === 'run') {
      fetch(`/api/sessions/${entityId}`, { method: 'DELETE' })
      return
    }
    const endpointMap: Record<string, string> = {
      initiative: '/api/initiatives',
      epic: '/api/epics',
      task: '/api/tasks',
      worktree: '/api/worktrees',
    }
    const endpoint = endpointMap[type]
    if (!endpoint) return
    fetch(`${endpoint}/${entityId}`, { method: 'DELETE' })
  }, [])

  const handleAdd = useCallback((parentId: string | null, type: GroupingDimension | 'run') => {
    if (type === 'run') return
    // Determine the parent's type from the dimensions hierarchy
    const typeIdx = dimensions.indexOf(type)
    const parentType = typeIdx > 0 ? dimensions[typeIdx - 1] : null
    setCreateDialog({ parentId, parentType, childType: type })
  }, [dimensions])

  const handleReparent = useCallback((entityId: string, entityType: string, newParentId: string | null, newParentType: string | null) => {
    const endpointMap: Record<string, string> = {
      initiative: '/api/initiatives',
      epic: '/api/epics',
      task: '/api/tasks',
      run: '/api/runs',
    }
    const endpoint = endpointMap[entityType]
    if (!endpoint) return

    // Build patch based on entity type and target parent
    const patch: Record<string, string | null> = {}
    if (entityType === 'epic') {
      // Epics can be reparented to an initiative
      patch.initiativeId = newParentType === 'initiative' ? newParentId : null
    } else if (entityType === 'task') {
      // Tasks can be reparented to an epic or initiative
      if (newParentType === 'epic') {
        patch.epicId = newParentId
      } else if (newParentType === 'initiative') {
        patch.epicId = null
        patch.initiativeId = newParentId
      } else {
        patch.epicId = null
        patch.initiativeId = null
      }
    } else if (entityType === 'run') {
      // Runs can be reparented to a task
      patch.taskId = newParentType === 'task' ? newParentId : null
    }

    fetch(`${endpoint}/${entityId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }, [])

  const handleMenuOpen = useCallback((entityId: string, entityType: GroupingDimension, entityName: string, anchorRect: DOMRect) => {
    setEntityMenu({ entityId, entityType, entityName, anchorRect })
  }, [])

  const handleMenuStartSession = useCallback(async () => {
    if (!entityMenu) return
    // Resolve settings for the entity and pre-fill the session dialog
    const typeMap: Record<string, string> = { initiative: 'initiatives', epic: 'epics', task: 'tasks' }
    const endpoint = typeMap[entityMenu.entityType]
    if (!endpoint) {
      setShowSessionDialog(true)
      return
    }
    try {
      const res = await fetch(`/api/${endpoint}/${entityMenu.entityId}/settings`)
      const data = await res.json()
      const entityLinks: Record<string, string | undefined> = {}
      if (entityMenu.entityType === 'task') entityLinks.taskId = entityMenu.entityId
      else if (entityMenu.entityType === 'epic') entityLinks.epicId = entityMenu.entityId
      else if (entityMenu.entityType === 'initiative') entityLinks.initiativeId = entityMenu.entityId
      if (data.ok) {
        setSessionPrefill({
          ...data.data.resolved,
          ...entityLinks,
        })
      } else {
        setSessionPrefill(entityLinks)
      }
    } catch { /* ignore */ }
    setShowSessionDialog(true)
  }, [entityMenu])

  const handleMenuRename = useCallback(() => {
    // Trigger inline rename in sidebar — just select the node first
    if (entityMenu) {
      const nodeId = `${entityMenu.entityType}-${entityMenu.entityId}`
      select(nodeId, entityMenu.entityType)
    }
  }, [entityMenu, select])

  // Sidebar double-click passes node.id directly (e.g. "run-vpp", "initiative-abc")
  const handleFocusNode = useCallback((nodeId: string) => {
    setFocusRunId(nodeId)
  }, [])

  const handleFocusHandled = useCallback(() => {
    setFocusRunId(null)
  }, [])

  // Click on canvas widget → select in hierarchy + expand ancestors
  const handleSelectRun = useCallback((runId: string, additive = false) => {
    const nodeId = `run-${runId}`
    const ancestors = findAncestorIds(sidebarTree, nodeId)
    if (ancestors.length > 0) expandAll(ancestors)
    if (additive) {
      toggleSelect(nodeId, 'run')
    } else {
      select(nodeId, 'run')
    }
  }, [sidebarTree, select, toggleSelect, expandAll])

  // Double-click on canvas widget → zoom to fit (receives run.id, needs prefixing)
  const handleCanvasFocusRun = useCallback((runId: string) => {
    setFocusRunId(`run-${runId}`)
    handleSelectRun(runId)
  }, [handleSelectRun])

  return (
    <ActiveScopeProvider>
      {activeSpaceId ? (
        <HotgroupProvider spaceId={activeSpaceId} runIds={runIds}>
          <TaxonomyProvider taxRepo={taxRepo}>
            <div className="flex flex-col h-screen w-screen bg-surface-base text-slate-200 font-mono">
              {/* Top bar: GroupingControls + logo + status */}
              <div
                className="flex items-center justify-between px-4 py-2 bg-surface-panel border-b border-white/10 relative"
                data-testid="controls-bar"
              >
                <GroupingControls
                  activeDimensions={dimensions}
                  onDimensionsChange={handleDimensionsChange}
                />
                <img src="/logo.png" alt="Tinstar" className="h-6 absolute left-1/2 -translate-x-1/2 pointer-events-none select-none opacity-80" />
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
                {sidebarCollapsed ? (
                  <div
                    className="w-6 flex-shrink-0 flex flex-col items-center justify-center bg-surface-panel border-r border-white/10 cursor-pointer hover:bg-surface-hover"
                    onClick={() => setSidebarCollapsed(false)}
                    data-testid="collapsed-sidebar"
                  >
                    <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr] rotate-180">Hierarchy</span>
                  </div>
                ) : (
                  <div
                    className="flex-shrink-0 bg-surface-panel border-r border-white/10 relative flex flex-col"
                    style={{ width: sidebarWidth }}
                    data-testid="sidebar-slot"
                  >
                    <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
                      <HierarchySidebar
                        tree={sidebarTree}
                        dimensions={dimensions}
                        spaces={spaces}
                        activeSpaceId={activeSpaceId}
                        onActivateSpace={handleActivateSpace}
                        onCreateSpace={handleCreateSpace}
                        onRenameSpace={handleRenameSpace}
                        onDeleteSpace={handleDeleteSpace}
                        onAdd={handleAdd}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        onFocusRun={handleFocusNode}
                        onMenuOpen={handleMenuOpen}
                        onReparent={handleReparent}
                        onArrangeGrid={() => arrangeGridRef.current?.()}
                        onArrangeReset={() => arrangeResetRef.current?.()}
                        onCollapse={() => setSidebarCollapsed(true)}
                      />
                    </div>
                    <div
                      className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-10"
                      onPointerDown={onSidebarResizePointerDown}
                      onPointerMove={onSidebarResizePointerMove}
                      onPointerUp={onSidebarResizePointerUp}
                      data-testid="sidebar-resize-handle"
                    />
                  </div>
                )}

                {/* Canvas */}
                <div className="flex-1 relative overflow-hidden" data-testid="canvas-slot">
                  <InfiniteCanvas
                    tree={sidebarTree}
                    runMap={runMap}
                    focusRunId={focusRunId}
                    activeSpaceId={activeSpaceId}
                    onFocusHandled={handleFocusHandled}
                    onSelectRun={handleSelectRun}
                    onFocusRun={handleCanvasFocusRun}
                    onDeleteEntity={handleDelete}
                    onMenuOpen={handleMenuOpen}
                    arrangeGridRef={arrangeGridRef}
                    arrangeResetRef={arrangeResetRef}
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
                <CreateSessionDialog
                  onClose={() => { setShowSessionDialog(false); setSessionPrefill(null) }}
                  prefill={sessionPrefill ?? undefined}
                />
              )}

              {showSettings && (
                <SettingsDialog onClose={() => setShowSettings(false)} />
              )}

              {entityMenu && (
                <EntityMenu
                  entityId={entityMenu.entityId}
                  entityType={entityMenu.entityType}
                  entityName={entityMenu.entityName}
                  anchorRect={entityMenu.anchorRect}
                  onStartSession={handleMenuStartSession}
                  onSettings={() => {
                    setEntitySettingsDialog({
                      entityId: entityMenu.entityId,
                      entityType: entityMenu.entityType,
                      entityName: entityMenu.entityName,
                    })
                    setEntityMenu(null)
                  }}
                  onRename={() => {
                    handleMenuRename()
                    setEntityMenu(null)
                  }}
                  onAddChild={() => {
                    // Add a child of the next dimension level below this entity
                    const idx = dimensions.indexOf(entityMenu.entityType)
                    const childType = idx >= 0 && idx < dimensions.length - 1 ? dimensions[idx + 1] : 'run'
                    handleAdd(entityMenu.entityId, childType)
                    setEntityMenu(null)
                  }}
                  onDelete={() => {
                    handleDelete(entityMenu.entityId, entityMenu.entityType)
                    setEntityMenu(null)
                  }}
                  onClose={() => setEntityMenu(null)}
                />
              )}

              {entitySettingsDialog && (
                <EntitySettingsDialog
                  entityId={entitySettingsDialog.entityId}
                  entityType={entitySettingsDialog.entityType}
                  entityName={entitySettingsDialog.entityName}
                  onClose={() => setEntitySettingsDialog(null)}
                />
              )}
            </div>
          </TaxonomyProvider>
        </HotgroupProvider>
      ) : (
        <TaxonomyProvider taxRepo={taxRepo}>
          <div className="flex flex-col h-screen w-screen bg-surface-base text-slate-200 font-mono">
            {/* Placeholder when no active space */}
            <div className="flex items-center justify-center h-screen text-slate-500">
              <span>No space selected</span>
            </div>
          </div>
        </TaxonomyProvider>
      )}
    </ActiveScopeProvider>
  )
}

export default function WorkspaceShell() {
  return (
    <SelectionProvider>
      <WorkspaceShellInner />
    </SelectionProvider>
  )
}
