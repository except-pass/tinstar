import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BrowserWidget, EditorWidget, ImageWidget, GroupingDimension, LevelLabel, Run, TreeNode } from '../domain/types'
import { buildWorkspaceView } from '../domain/view-models'
import { useBackendState } from '../hooks/useBackendState'
import { useDimensionMeta } from '../hooks/useDimensionMeta'
import { DEFAULT_LEVELS } from '../domain/dimension-meta'
import { useGlobalHotkeys } from '../hotkeys/useGlobalHotkeys'
import { cycleNext, cyclePrev } from '../hooks/useReadyQueue'
import { CreateEntityDialog, type CreateDialogState } from './CreateEntityDialog'
import { CreateSessionDialog } from './CreateSessionDialog'
import { SettingsDialog } from './SettingsDialog'
import HierarchySidebar from './HierarchySidebar'
import { InfiniteCanvas } from './InfiniteCanvas'
import { SelectionProvider, useSelection } from './SelectionProvider'
import { TaxonomyProvider } from './TaxonomyContext'
import { SkillsProvider } from './SkillsProvider'
import { EntityMenu } from './EntityMenu'
import { EntitySettingsDialog } from './EntitySettingsDialog'
import { HotgroupProvider } from '../hotkeys/HotgroupContext'
import { FocusPathProvider, useFocusPath } from '../hotkeys/FocusPathContext'
import { useContextRouter } from '../hotkeys/contextRouter'
import { triggerWidgetFlourish, registerActionHandler, deregisterActionHandler } from '../hotkeys/actionHandlerRegistry'
import type { FocusNode } from '../hotkeys/FocusPathContext'
import { NoTasksToast } from './NoTasksToast'
import { HotkeyPalette } from './HotkeyPalette'


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

/** Find a node's label by its ID in a tree */
function findNodeLabel(nodes: TreeNode[], targetId: string): string | null {
  for (const node of nodes) {
    if (node.id === targetId) return node.label
    if (node.children.length > 0) {
      const found = findNodeLabel(node.children, targetId)
      if (found) return found
    }
  }
  return null
}

function WorkspaceShellInner() {
  const { runRepo, taxRepo, spaces, activeSpaceId, readyQueue, addOptimistic, editorWidgets, browserWidgets, imageWidgets, connected } = useBackendState()

  const levelMeta = useDimensionMeta()
  const dimensions = useMemo(
    () => levelMeta.map(m => m.internalType),
    [levelMeta],
  )

  // One-time migration: promote tinstar-dimensions localStorage → space.labelConfig
  useEffect(() => {
    if (!activeSpaceId) return
    const activeSpace = spaces.find(s => s.id === activeSpaceId)
    if (!activeSpace || activeSpace.labelConfig) return  // already migrated

    const stored = localStorage.getItem('tinstar-dimensions')
    let count = 3
    try {
      const parsed = JSON.parse(stored ?? '[]') as string[]
      if (parsed.length >= 1 && parsed.length <= 3) count = parsed.length
    } catch { /* ignore */ }

    // Use bottom-N defaults matching the stored count
    const levels: LevelLabel[] = DEFAULT_LEVELS.slice(DEFAULT_LEVELS.length - count)

    fetch(`/api/spaces/${activeSpaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelConfig: { levels } }),
    }).then(r => {
      if (r.ok) localStorage.removeItem('tinstar-dimensions')
      else console.warn('[tinstar] labelConfig migration failed; will retry on next load')
    }).catch(() => {
      console.warn('[tinstar] labelConfig migration failed; will retry on next load')
    })
  }, [activeSpaceId, spaces])

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

  const syntheticEditorNodes: TreeNode[] = useMemo(
    () =>
      editorWidgets.map(w => ({
        id: w.id,
        label: w.filePath.split('/').pop() ?? w.filePath,
        type: 'file-editor',
        entityId: w.id,
        children: [],
        runCount: 0,
        activeCount: 0,
        color: w.color,
      })),
    [editorWidgets],
  )

  const editorWidgetMap = useMemo(() => {
    const map = new Map<string, EditorWidget>()
    for (const w of editorWidgets) map.set(w.id, w)
    return map
  }, [editorWidgets])

  const syntheticBrowserNodes: TreeNode[] = useMemo(
    () =>
      browserWidgets.map(w => ({
        id: w.id,
        label: w.title ?? (() => { try { return w.url ? new URL(w.url.startsWith('http') ? w.url : `http://${w.url}`).host : 'Browser' } catch { return 'Browser' } })(),
        type: 'browser-widget',
        entityId: w.id,
        children: [],
        runCount: 0,
        activeCount: 0,
        color: w.color,
      })),
    [browserWidgets],
  )

  const browserWidgetMap = useMemo(() => {
    const map = new Map<string, BrowserWidget>()
    for (const w of browserWidgets) map.set(w.id, w)
    return map
  }, [browserWidgets])

  const syntheticImageNodes: TreeNode[] = useMemo(
    () =>
      imageWidgets.map(w => ({
        id: w.id,
        label: w.filePath.split('/').pop() ?? w.filePath,
        type: 'image-viewer' as const,
        entityId: w.id,
        children: [],
        runCount: 0,
        activeCount: 0,
      })),
    [imageWidgets],
  )

  const imageWidgetMap = useMemo(() => {
    const map = new Map<string, ImageWidget>()
    for (const w of imageWidgets) map.set(w.id, w)
    return map
  }, [imageWidgets])

  const canvasTree = useMemo(() => {
    const allSynthetic = [...syntheticEditorNodes, ...syntheticBrowserNodes, ...syntheticImageNodes]
    if (allSynthetic.length === 0) return sidebarTree

    // Map taskNodeId → synthetic nodes to nest inside it
    const byTaskNode = new Map<string, TreeNode[]>()
    const orphans: TreeNode[] = []

    for (const node of syntheticEditorNodes) {
      const widget = editorWidgets.find(w => w.id === node.entityId)
      const run = widget ? [...runMap.values()].find(r => r.sessionId === widget.sessionId) : undefined
      const taskNodeId = run?.taskId ? `task-${run.taskId}` : null
      if (taskNodeId) {
        const list = byTaskNode.get(taskNodeId) ?? []
        list.push(node)
        byTaskNode.set(taskNodeId, list)
      } else {
        orphans.push(node)
      }
    }

    for (const node of syntheticBrowserNodes) {
      const widget = browserWidgets.find(w => w.id === node.entityId)
      const run = widget ? [...runMap.values()].find(r => r.sessionId === widget.sessionId) : undefined
      const taskNodeId = run?.taskId ? `task-${run.taskId}` : null
      if (taskNodeId) {
        const list = byTaskNode.get(taskNodeId) ?? []
        list.push(node)
        byTaskNode.set(taskNodeId, list)
      } else {
        orphans.push(node)
      }
    }

    for (const node of syntheticImageNodes) {
      const widget = imageWidgets.find(w => w.id === node.entityId)
      const run = widget ? [...runMap.values()].find(r => r.sessionId === widget.sessionId) : undefined
      const taskNodeId = run?.taskId ? `task-${run.taskId}` : null
      if (taskNodeId) {
        const existing = byTaskNode.get(taskNodeId) ?? []
        byTaskNode.set(taskNodeId, [...existing, node])
      } else {
        orphans.push(node)
      }
    }

    if (byTaskNode.size === 0) return [...sidebarTree, ...orphans]

    function inject(nodes: TreeNode[]): TreeNode[] {
      return nodes.map(node => {
        const toInject = byTaskNode.get(node.id)
        const injectedChildren = inject(node.children)
        if (!toInject) return injectedChildren === node.children ? node : { ...node, children: injectedChildren }
        return { ...node, children: [...injectedChildren, ...toInject] }
      })
    }

    return [...inject(sidebarTree), ...orphans]
  }, [sidebarTree, syntheticEditorNodes, syntheticBrowserNodes, syntheticImageNodes, editorWidgets, browserWidgets, imageWidgets, runMap])

  const allNodeIds = useMemo(() => {
    const ids: string[] = Array.from(runMap.keys()).map(id => `run-${id}`)
    for (const w of editorWidgets) ids.push(w.id)
    for (const w of browserWidgets) ids.push(w.id)
    for (const w of imageWidgets) ids.push(w.id)
    return ids
  }, [runMap, editorWidgets, browserWidgets, imageWidgets])

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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const { select, toggleSelect, expandAll, selectedCount: _selectedCount, state: selectionState } = useSelection()
  const arrangeGridRef = useRef<(() => void) | null>(null)
  const arrangeResetRef = useRef<(() => void) | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  // Feature-flagged: commit activity buttons disabled for now
  // const [commitViewMode, setCommitViewMode] = useState<'task' | 'unassigned' | 'standup' | null>(null)
  // const [selectedTaskTag, setSelectedTaskTag] = useState('')
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

  // Deep link: apply ?space= param once spaces are known, then keep URL in sync
  const deepLinkApplied = useRef(false)
  useEffect(() => {
    if (spaces.length === 0) return
    if (!deepLinkApplied.current) {
      deepLinkApplied.current = true
      const urlSpaceId = new URLSearchParams(location.search).get('space')
      if (urlSpaceId && spaces.some(s => s.id === urlSpaceId) && urlSpaceId !== activeSpaceId) {
        fetch(`/api/spaces/${urlSpaceId}/activate`, { method: 'POST' })
        return // URL already has the right space param
      }
    }
    // Keep URL in sync with active space
    if (activeSpaceId) {
      const url = new URL(location.href)
      if (url.searchParams.get('space') !== activeSpaceId) {
        url.searchParams.set('space', activeSpaceId)
        window.history.replaceState(null, '', url)
      }
    }
  }, [activeSpaceId, spaces.length])

  // Space actions
  const handleActivateSpace = useCallback(async (id: string) => {
    await fetch(`/api/spaces/${id}/activate`, { method: 'POST' })
    const url = new URL(location.href)
    url.searchParams.set('space', id)
    window.location.href = url.toString()
  }, [])

  const handleCreateSpace = useCallback(async (name: string) => {
    const res = await fetch('/api/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) return
    const space = await res.json() as { id: string }
    await fetch(`/api/spaces/${space.id}/activate`, { method: 'POST' })
    const url = new URL(location.href)
    url.searchParams.set('space', space.id)
    window.location.href = url.toString()
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
    if (type === 'file-editor') {
      fetch(`/api/editor-widgets/${entityId}`, { method: 'DELETE' })
      return
    }
    if (type === 'browser-widget') {
      fetch(`/api/browser-widgets/${entityId}`, { method: 'DELETE' })
      return
    }
    if (type === 'image-viewer') {
      fetch(`/api/image-widgets/${entityId}`, { method: 'DELETE' })
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
    const typeIdx = dimensions.indexOf(type as 'task' | 'epic' | 'initiative')
    const parentType = typeIdx > 0 ? (dimensions[typeIdx - 1] ?? null) : null
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
        const resolved = data.data.resolved
        setSessionPrefill({
          ...resolved,
          worktreeMode: resolved.worktree,
          runColor: resolved.defaultRunColor,
          ...entityLinks,
        })
      } else {
        setSessionPrefill(entityLinks)
      }
    } catch { /* ignore */ }
    setShowSessionDialog(true)
  }, [entityMenu])

  const handleMenuRename = useCallback(() => {
    if (entityMenu) {
      const nodeId = `${entityMenu.entityType}-${entityMenu.entityId}`
      select(nodeId, entityMenu.entityType)
      setRenamingNodeId(nodeId)
    }
  }, [entityMenu, select])

  // Global hotkeys: session cycling
  const allRuns = useMemo(() => Array.from(runMap.values()), [runMap])
  // Keep raw run ID for session cycling in global hotkeys
  const selectedRunId = useMemo(() => {
    if (selectionState.selectedType !== 'run') return null
    const firstNodeId = [...selectionState.selectedIds][0] ?? null
    if (!firstNodeId) return null
    return firstNodeId.startsWith('run-') ? firstNodeId.slice(4) : firstNodeId
  }, [selectionState.selectedIds, selectionState.selectedType])

  // Derive focus node for any selected entity (run, task, epic, initiative)
  const selectedFocusNode = useMemo<FocusNode | null>(() => {
    const { selectedType, selectedIds } = selectionState
    if (!selectedType || selectedIds.size === 0) return null
    const firstNodeId = [...selectedIds][0]
    if (!firstNodeId) return null

    if (selectedType === 'run') {
      const rawId = firstNodeId.startsWith('run-') ? firstNodeId.slice(4) : firstNodeId
      return { id: rawId, type: 'run-workspace', label: rawId }
    }

    if (selectedType === 'task' || selectedType === 'epic' || selectedType === 'initiative') {
      const label = findNodeLabel(canvasTree, firstNodeId) ?? selectedType
      return { id: firstNodeId, type: selectedType, label }
    }

    if (selectedType === 'file-editor') {
      const label = findNodeLabel(canvasTree, firstNodeId) ?? 'File'
      return { id: firstNodeId, type: 'file-editor', label }
    }

    return null
  }, [selectionState.selectedIds, selectionState.selectedType, canvasTree])

  const { path, chordState, pushFocus, clearFocus, setChord, clearChord } = useFocusPath()

  // Sync selected entity → FocusPathContext
  // useLayoutEffect ensures path is updated synchronously before next user input
  useLayoutEffect(() => {
    clearFocus()
    if (selectedFocusNode) {
      pushFocus(selectedFocusNode)
    }
  }, [selectedFocusNode, pushFocus, clearFocus])

  // Register action handler for selected task/epic/initiative
  useEffect(() => {
    if (!selectedFocusNode || selectedFocusNode.type === 'run-workspace' || selectedFocusNode.type === 'file-editor') return
    const { id, type, label } = selectedFocusNode
    const dash = id.indexOf('-')
    if (dash === -1) return
    const entityId = id.slice(dash + 1)
    const entityType = type as GroupingDimension
    registerActionHandler(id, (action) => {
      if (action === 'settings') {
        setEntitySettingsDialog({ entityId, entityType, entityName: label })
      }
    })
    return () => { deregisterActionHandler(id) }
  }, [selectedFocusNode])

  useContextRouter({
    path,
    chordState,
    pushFocus,
    clearFocus,
    setChord,
    clearChord,
    onNavigate: (id) => triggerWidgetFlourish(id),
  })

  useGlobalHotkeys({
    onCycleReadyNext: () => {
      const run = cycleNext(allRuns, readyQueue, selectedRunId)
      if (run) { handleSelectRun(run.id); setFocusRunId(`run-${run.id}`) }
    },
    onCycleReadyPrev: () => {
      const run = cyclePrev(allRuns, readyQueue, selectedRunId)
      if (run) { handleSelectRun(run.id); setFocusRunId(`run-${run.id}`) }
    },
    onCycleAllNext: () => {
      const allNames = allRuns.map(r => r.sessionId).filter(Boolean) as string[]
      const run = cycleNext(allRuns, allNames, selectedRunId)
      if (run) { handleSelectRun(run.id); setFocusRunId(`run-${run.id}`) }
    },
    onCycleAllPrev: () => {
      const allNames = allRuns.map(r => r.sessionId).filter(Boolean) as string[]
      const run = cyclePrev(allRuns, allNames, selectedRunId)
      if (run) { handleSelectRun(run.id); setFocusRunId(`run-${run.id}`) }
    },
    onSessionQuick: useCallback(async () => {
      // S opens session dialog — if a task is selected, pre-fill with task settings
      const { selectedType, selectedIds } = selectionState
      const firstNodeId = [...selectedIds][0] ?? null
      if (!firstNodeId || selectedType !== 'task') {
        setSessionPrefill(null)
        setShowSessionDialog(true)
        return
      }
      const rawId = firstNodeId.startsWith('task-') ? firstNodeId.slice(5) : firstNodeId
      try {
        const res = await fetch(`/api/tasks/${rawId}/settings`)
        const data = await res.json()
        if (data.ok) {
          const resolved = data.data.resolved
          setSessionPrefill({
            ...resolved,
            worktreeMode: resolved.worktree,
            runColor: resolved.defaultRunColor,
            taskId: rawId,
            sources: data.data.sources,
          })
        } else {
          setSessionPrefill({ taskId: rawId })
        }
      } catch {
        setSessionPrefill({ taskId: rawId })
      }
      setShowSessionDialog(true)
    }, [selectionState]),
    onPaletteOpen: () => setPaletteOpen(true),
  })

  // Sidebar double-click passes node.id directly (e.g. "run-vpp", "initiative-abc")
  const handleFocusNode = useCallback((nodeId: string) => {
    setFocusRunId(nodeId)
  }, [])

  const handleFocusHandled = useCallback(() => {
    setFocusRunId(null)
  }, [])

  const handleTaskUpdate = useCallback((taskId: string, patch: { externalUrl?: string | null }) => {
    void fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
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
    <>
      {activeSpaceId ? (
        <HotgroupProvider spaceId={activeSpaceId} nodeIds={allNodeIds}>
          <TaxonomyProvider taxRepo={taxRepo}>
          <SkillsProvider>
            <div className="flex h-screen w-screen bg-surface-base text-slate-200 font-mono">
              {/* Left column: top bar + sidebar stacked — canvas gets full height */}
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
                  {/* Top bar — lives only above the sidebar.
                      flex-row-reverse + overflow-hidden: items are anchored right-to-left,
                      so as the sidebar narrows the logo (DOM-last) clips off the left first. */}
                  <div
                    className="flex flex-row-reverse items-center gap-2 px-2 py-1.5 border-b border-white/10 overflow-hidden flex-shrink-0"
                    data-testid="controls-bar"
                  >
                    {/* online dot — most important, never clips (DOM first = rightmost) */}
                    <span data-testid="status-area" className="flex items-center flex-shrink-0">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? 'bg-green-500 shadow-[0_0_4px_#22c55e]' : 'bg-red-500 shadow-[0_0_4px_#ef4444]'}`}
                        title={connected ? 'Connected' : 'Disconnected'}
                      />
                    </span>
                    <button
                      className="px-2 py-0.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded-full hover:bg-primary/30 flex-shrink-0 whitespace-nowrap"
                      onClick={() => setShowSessionDialog(true)}
                      data-testid="new-session-btn"
                    >
                      + Session
                    </button>
                    <span className="text-2xs font-mono text-slate-500 flex-shrink-0 whitespace-nowrap">{runSummaries.size} runs</span>
                    <button
                      className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-primary rounded hover:bg-white/5 transition-colors flex-shrink-0"
                      onClick={() => setShowSettings(true)}
                      data-testid="settings-btn"
                      aria-label="Settings"
                    >
                      <span className="material-symbols-outlined text-sm">settings</span>
                    </button>
                    {/* logo — last in DOM = leftmost visually = clips first when narrow */}
                    <img src="/logo.png" alt="Tinstar" className="h-5 pointer-events-none select-none opacity-80 flex-shrink-0" />
                  </div>

                  <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
                    <HierarchySidebar
                        tree={canvasTree}
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
                        renamingNodeId={renamingNodeId}
                        onRenameComplete={() => setRenamingNodeId(null)}
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
                    tree={canvasTree}
                    editorWidgetMap={editorWidgetMap}
                    browserWidgetMap={browserWidgetMap}
                    runMap={runMap}
                    focusRunId={focusRunId}
                    activeSpaceId={activeSpaceId}
                    onFocusHandled={handleFocusHandled}
                    onSelectRun={handleSelectRun}
                    onFocusRun={handleCanvasFocusRun}
                    onDeleteEntity={handleDelete}
                    onMenuOpen={handleMenuOpen}
                    onTaskUpdate={handleTaskUpdate}
                    imageWidgetMap={imageWidgetMap}
                    onImageWidgetCreated={(widget) => addOptimistic('imageWidget', widget)}
                    onEditorWidgetCreated={(widget) => addOptimistic('editorWidget', widget)}
                    onBrowserWidgetCreated={(widget) => addOptimistic('browserWidget', widget)}
                    arrangeGridRef={arrangeGridRef}
                    arrangeResetRef={arrangeResetRef}
                  />
                </div>

              {/* Feature-flagged: commit activity panel disabled for now
              {commitViewMode && (
                <CommitActivityPanel
                  mode={commitViewMode}
                  selectedTaskTag={selectedTaskTag}
                  onTaskTagChange={setSelectedTaskTag}
                />
              )}
              */}

              {createDialog && (
                <CreateEntityDialog
                  dialog={createDialog}
                  onClose={() => setCreateDialog(null)}
                  onOptimisticCreate={addOptimistic}
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
                    const idx = dimensions.indexOf(entityMenu.entityType as 'task' | 'epic' | 'initiative')
                    const childType = idx >= 0 && idx < dimensions.length - 1 ? (dimensions[idx + 1] ?? 'run') : 'run'
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
          </SkillsProvider>
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
      <NoTasksToast
        taskCount={taxRepo.getTasks().length}
        runCount={runRepo.getAll().length}
      />
      <HotkeyPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  )
}

export default function WorkspaceShell() {
  return (
    <FocusPathProvider>
      <SelectionProvider>
        <WorkspaceShellInner />
      </SelectionProvider>
    </FocusPathProvider>
  )
}
