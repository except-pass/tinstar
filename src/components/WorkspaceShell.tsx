import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BrowserWidget, EditorWidget, ImageWidget, PluginWidgetInstance, GroupingDimension, OrganizationalScope, Run, TreeNode } from '../domain/types'
import { findNodeLabel } from '../domain/view-models'
import { buildScopeTree, flattenUnscopedForCanvas, normalizedScope } from '../domain/scopeTree'
import { RunRepository } from '../domain/repositories'
import { useBackendState } from '../hooks/useBackendState'
import { useDimensionMeta } from '../hooks/useDimensionMeta'
import { useGlobalHotkeys } from '../hotkeys/useGlobalHotkeys'
import { cycleNext, cyclePrev, visibleCycleQueue } from '../hooks/useReadyQueue'
import { useHiddenRuns } from '../hooks/useHiddenRuns'
import { isBackgroundHidden, backgroundHiddenRunIds, pruneRunNodes } from '../domain/background-visibility'
import { getPref, setPref, PREFS_STORAGE_KEY } from '../lib/uiPrefs'
import { CreateSessionDialog, type SessionPrefill } from './CreateSessionDialog'
import { SettingsDialog } from './SettingsDialog'
import HierarchySidebar from './HierarchySidebar'
import { InfiniteCanvas } from './InfiniteCanvas'
import { SelectionProvider, useSelection } from './SelectionProvider'
import { TaxonomyProvider } from './TaxonomyContext'
import { ConstellationProvider } from '../hotkeys/ConstellationContext'
import { PinsBridge } from '../core/pluginApi/PinsBridge'
import { FocusPathProvider, useFocusPath } from '../hotkeys/FocusPathContext'
import { useContextRouter } from '../hotkeys/contextRouter'
import { triggerWidgetFlourish } from '../hotkeys/actionHandlerRegistry'
import type { FocusNode } from '../hotkeys/FocusPathContext'
import { DownloadPushToast } from './DownloadPushToast'
import { HotkeyPalette } from './HotkeyPalette'
import { OnboardingCanvas } from './OnboardingCanvas'
import { apiFetch } from '../apiClient'
import { useOnboardingState } from '../hooks/useOnboardingState'
import { PluginFailedBanner } from './PluginFailedBanner'
import { WidgetsPalette } from './WidgetsPalette/WidgetsPalette'
import { PaletteDragGhost } from './WidgetsPalette/PaletteDragGhost'
import { useConfig, useConfigPatch } from '../context/ConfigContext'
import { pluginsReady } from '../widgets'
import { FocusModeToggle } from './FocusModeToggle'
import { focusCycleQueue, isBuiltInRunWorkspace, resolveFocusTarget, runsInFocusSpace } from '../focusMode/focusTarget'
import { parseProjects, sortByOrder, type Project } from '../lib/projects'
import { pushPromptHistory } from '../hooks/usePromptHistory'
import {
  buildOptimisticSessionRun,
  mergeOptimisticSessionRuns,
  reconcileOptimisticSessionFailure,
  type OptimisticSessionIntent,
} from './optimisticSession'
import { hasCanonicalObjective } from '../slate/objective'


/**
 * Rename dispatch behind the sidebar's inline edit.
 *
 * Taxonomy entities PATCH their own endpoint. A run instead PATCHes
 * `/api/runs/:id` with `{ name }` — a display-only field. The run id is never
 * in the body: it is the tmux session, the worktree dir, and the NATS subject
 * token, and renaming it would be a filesystem migration, not a UI edit.
 *
 * Only the run branch paints optimistically. The taxonomy rename is fine to
 * wait on its SSE echo, but a run rename is triggered from the row the user is
 * looking at, and the UI philosophy (CLAUDE.md) is that it lands on Enter, not
 * on the round-trip. Note `applyOptimistic` REPLACES the run in state (see
 * `upsertById` in useServerEvents) — hand it the whole run with the new name
 * merged in, never a `{ id, name }` stub, or every other field is erased until
 * the server echo lands.
 *
 * An empty/whitespace name is a clear: stored as `undefined`, so `name || id`
 * falls the run back to its id everywhere (R12).
 *
 * Exported for tests; the component wraps it in a useCallback.
 */
export function dispatchRename(
  entityId: string,
  type: GroupingDimension | 'run',
  newName: string,
  runCtx?: { run?: Run; addOptimistic: (entity: string, data: unknown) => void },
): void {
  if (type === 'run') {
    const trimmed = newName.trim()
    // Only paint optimistically when the run still exists. If it was deleted
    // while its rename input was open, addOptimistic (an upsert) would otherwise
    // resurrect the dead run as a ghost that no server echo ever clears.
    const prior = runCtx?.run
    if (prior) {
      runCtx!.addOptimistic('run', { ...prior, name: trimmed || undefined })
    }
    void apiFetch(`/api/runs/${entityId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).then(res => {
      // Roll the optimistic paint back to the pre-edit run on failure, so a
      // rejected rename (400/404/500) doesn't linger as a false success.
      if (!res.ok && prior) runCtx!.addOptimistic('run', prior)
    }).catch(() => {
      if (prior) runCtx!.addOptimistic('run', prior)
    })
    return
  }
  // Project and Worktree registry names are identity, not inline labels.
}

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

const FOCUS_STATE_MESSAGES = {
  resolving: 'Resolving Run Workspaces…',
  empty: 'No sessions yet.',
  'no-live': 'No live built-in Run Workspaces.',
} as const


function WorkspaceShellInner() {
  const { runRepo: serverRunRepo, taxRepo, spaces, activeSpaceId, readyQueue, addOptimistic, editorWidgets, browserWidgets, imageWidgets, pluginWidgets, connected, loading } = useBackendState()
  const [optimisticSessionRuns, setOptimisticSessionRuns] = useState<Run[]>([])
  const runRepo = useMemo(
    () => new RunRepository(mergeOptimisticSessionRuns(serverRunRepo.getAll(), optimisticSessionRuns)),
    [serverRunRepo, optimisticSessionRuns],
  )

  // The server emits a backend-backed run before the create response returns.
  // Retire only projections that have reached that authoritative state; failed
  // launches stay visible and inspectable instead of disappearing on snapshot.
  useEffect(() => {
    const optimisticById = new Map(optimisticSessionRuns.map(run => [run.id, run]))
    const liveIds = new Set(serverRunRepo.getAll().filter(run => {
      if (!run.backend) return false
      const optimistic = optimisticById.get(run.id)
      const waitsForObjective = optimistic?.slate?.some(surface => surface.kind === 'objective') ?? false
      return !waitsForObjective || hasCanonicalObjective(run)
    }).map(run => run.id))
    if (liveIds.size === 0) return
    setOptimisticSessionRuns(current => {
      const next = current.filter(run => !liveIds.has(run.id))
      return next.length === current.length ? current : next
    })
  }, [serverRunRepo, optimisticSessionRuns])

  // Force a re-render once the plugin boot pipeline completes so that any
  // plugin widgets already in the SSE snapshot (e.g. on page reload) switch
  // from their PluginWidgetDisabledPlaceholder to the real component.
  const [, setPluginsBooted] = useState(false)
  useEffect(() => {
    let cancelled = false
    pluginsReady.then(() => { if (!cancelled) setPluginsBooted(true) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const onboarding = useOnboardingState()
  const forceMarshalOpen = onboarding.active !== null && onboarding.active !== 'connect'

  const levelMeta = useDimensionMeta()
  const dimensions = useMemo(
    () => levelMeta.map(m => m.internalType),
    [levelMeta],
  )
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () => apiFetch('/api/projects')
      .then(response => response.json())
      .then(payload => {
        if (!cancelled) setProjects(sortByOrder(parseProjects(payload.data ?? payload)))
      })
      .catch(() => {})
    void load()
    window.addEventListener('tinstar:projects_changed', load)
    return () => {
      cancelled = true
      window.removeEventListener('tinstar:projects_changed', load)
    }
  }, [])

  const activeRunCount = useMemo(
    () => runRepo.getAll().filter(run => !run.spaceId || run.spaceId === activeSpaceId).length,
    [runRepo, activeSpaceId],
  )

  // Filter out empty entity containers when showEmptyEntities is false
  const filterEmptyNodes = useCallback((nodes: TreeNode[]): TreeNode[] => {
    return nodes.reduce<TreeNode[]>((acc, node) => {
      const isScopeContainer = node.type === 'project' || node.type === 'worktree' || node.type === 'unscoped'
      if (!isScopeContainer) {
        acc.push(node)
        return acc
      }
      const filteredChildren = filterEmptyNodes(node.children)
      if (node.runCount > 0 || filteredChildren.length > 0) {
        acc.push({ ...node, children: filteredChildren })
      }
      return acc
    }, [])
  }, [])

  const config = useConfig()
  const patchConfig = useConfigPatch()
  const [showEmptyEntities, setShowEmptyEntities] = useState(() => config?.ui.showEmptyEntities ?? true)

  useEffect(() => {
    if (config) setShowEmptyEntities(config.ui.showEmptyEntities)
  }, [config?.ui.showEmptyEntities])

  // Figma-style per-run visibility — hidden runs stay in the sidebar (dimmed) but
  // are pruned from the canvas and skipped by Ctrl+[ / Ctrl+] cycling.
  const { hiddenIds: hiddenRunIds, isHidden: isRunHidden, toggleHidden: toggleRunHidden, removeHidden: removeRunHidden } = useHiddenRuns()

  // Background-session reveal toggle (R8–R10). U5 wires the pref + state; U6
  // builds the sidebar button that flips it. Same uiPrefs-backed state pattern
  // as minimapVisible/hudVisible (CanvasMinimap/CanvasHud).
  const [showBackgroundSessions, setShowBackgroundSessions] = useState(() => getPref('showBackgroundSessions') ?? false)
  useEffect(() => {
    setPref('showBackgroundSessions', showBackgroundSessions)
  }, [showBackgroundSessions])
  // Cross-tab sync (mirrors useHiddenRuns): another tab's toggle fires a
  // storage event; same-tab writes don't, so this cannot loop.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== PREFS_STORAGE_KEY) return
      setShowBackgroundSessions(getPref('showBackgroundSessions') ?? false)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Background pruning (R4–R5): drop background-hidden runs from the tree
  // BEFORE it forks to the sidebar and canvas — both surfaces lose the run.
  // This is a separate mechanism from the hidden-runs eyeball below, which
  // dims runs in the sidebar and prunes them only from the canvas; the two
  // coexist and must not be merged. Attention exempts a run from this prune
  // (breakthrough, R16) so its inbox row always targets a real card.
  const backgroundHiddenIds = useMemo(
    () => backgroundHiddenRunIds(runRepo.getAll(), showBackgroundSessions),
    [runRepo, showBackgroundSessions],
  )
  // U6 (R8/R9): background marking + count for the sidebar header toggle.
  // backgroundRunIds marks every background run — only rows that survive the
  // prune (toggle-revealed or attention breakthrough) actually render, and
  // those get the dim + badge treatment. backgroundCount is scoped to the
  // active space and feeds the toggle's "(N)" even while the toggle is off.
  const backgroundRunIds = useMemo(() => {
    const out = new Set<string>()
    for (const run of runRepo.getAll()) if (run.background) out.add(run.id)
    return out
  }, [runRepo])
  const backgroundCount = useMemo(() => {
    let n = 0
    for (const run of runRepo.getAll()) if (run.background && run.spaceId === activeSpaceId) n++
    return n
  }, [runRepo, activeSpaceId])

  // Build runs map for InfiniteCanvas
  const runMap = useMemo(() => {
    const map = new Map<string, Run>()
    for (const run of runRepo.getAll()) {
      map.set(run.id, run)
    }
    return map
  }, [runRepo])
  // Async session-create callbacks outlive the dialog render that launched
  // them. Read the latest run here so a lost HTTP response cannot overwrite a
  // real server run that already arrived over SSE.
  const runMapRef = useRef(runMap)
  runMapRef.current = runMap

  const runBySessionId = useMemo(() => {
    const map = new Map<string, Run>()
    for (const run of runRepo.getAll()) map.set(run.sessionId, run)
    return map
  }, [runRepo])

  const runScope = useCallback((run: Run): OrganizationalScope => normalizedScope(
    run.scope ?? { project: run.repo || undefined, worktree: run.worktree || undefined },
  ), [])
  const scopeForSession = useCallback((sessionId: string | undefined): OrganizationalScope => {
    if (!sessionId) return {}
    const run = runBySessionId.get(sessionId)
    return run ? runScope(run) : {}
  }, [runBySessionId, runScope])

  const syntheticRunNodes: TreeNode[] = useMemo(() => runRepo.getAll()
    .filter(run => !run.spaceId || run.spaceId === activeSpaceId)
    .map(run => ({
    id: `run-${run.id}`,
    label: run.name || run.id,
    type: 'run',
    entityId: run.id,
    children: [],
    runCount: 1,
    activeCount: run.status === 'running' ? 1 : 0,
    color: run.color,
    status: run.status,
    backend: run.backend,
    agentIcon: run.agentIcon,
    scope: runScope(run),
  })), [runRepo, runScope, activeSpaceId])

  const syntheticEditorNodes: TreeNode[] = useMemo(
    () =>
      editorWidgets.filter(w => !w.spaceId || w.spaceId === activeSpaceId).map(w => ({
        id: w.id,
        label: w.filePath.split('/').pop() ?? w.filePath,
        type: 'file-editor',
        entityId: w.id,
        children: [],
        runCount: 0,
        activeCount: 0,
        color: w.color,
        scope: normalizedScope(w.scope ?? { project: w.repo || undefined, worktree: w.worktree || undefined }),
      })),
    [editorWidgets, activeSpaceId],
  )

  const editorWidgetMap = useMemo(() => {
    const map = new Map<string, EditorWidget>()
    for (const w of editorWidgets) map.set(w.id, w)
    return map
  }, [editorWidgets])

  const syntheticBrowserNodes: TreeNode[] = useMemo(
    () =>
      browserWidgets.filter(w => !w.spaceId || w.spaceId === activeSpaceId).map(w => ({
        id: w.id,
        label: w.title ?? (() => { try { return w.url ? new URL(w.url.startsWith('http') ? w.url : `http://${w.url}`).host : 'Browser' } catch { return 'Browser' } })(),
        type: 'browser-widget',
        entityId: w.id,
        children: [],
        runCount: 0,
        activeCount: 0,
        color: w.color,
        scope: normalizedScope(w.scope ?? scopeForSession(w.sessionId)),
      })),
    [browserWidgets, scopeForSession, activeSpaceId],
  )

  const browserWidgetMap = useMemo(() => {
    const map = new Map<string, BrowserWidget>()
    for (const w of browserWidgets) map.set(w.id, w)
    return map
  }, [browserWidgets])

  const syntheticImageNodes: TreeNode[] = useMemo(
    () =>
      imageWidgets.filter(w => !w.spaceId || w.spaceId === activeSpaceId).map(w => ({
        id: w.id,
        label: w.filePath.split('/').pop() ?? w.filePath,
        type: 'image-viewer' as const,
        entityId: w.id,
        children: [],
        runCount: 0,
        activeCount: 0,
        scope: normalizedScope(w.scope ?? { project: w.repo || undefined, worktree: w.worktree || undefined }),
      })),
    [imageWidgets, activeSpaceId],
  )

  const imageWidgetMap = useMemo(() => {
    const map = new Map<string, ImageWidget>()
    for (const w of imageWidgets) map.set(w.id, w)
    return map
  }, [imageWidgets])

  const syntheticPluginWidgetNodes: TreeNode[] = useMemo(
    () =>
      pluginWidgets.filter(w => w.spaceId === activeSpaceId).map(w => ({
        id: w.id,
        label: w.widgetType,   // palette has the proper label; using type is fine for V5.1
        type: w.widgetType,    // matches what the plugin registered via api.widgets.register({ type })
        entityId: w.id,
        children: [],
        runCount: 0,
        activeCount: 0,
        scope: normalizedScope(w.scope),
      })),
    [pluginWidgets, activeSpaceId],
  )

  const pluginWidgetMap = useMemo(() => {
    const map = new Map<string, PluginWidgetInstance>()
    for (const w of pluginWidgets) map.set(w.id, w)
    return map
  }, [pluginWidgets])

  // Set of plugin widget entityIds — passed to HierarchySidebar so it can
  // render them as work widgets (closeable ×, no entity-style kebab menu).
  const pluginWidgetIdSet = useMemo(() => new Set(pluginWidgets.map(w => w.id)), [pluginWidgets])

  const rawSidebarTree = useMemo(() => buildScopeTree(
    [...syntheticRunNodes, ...syntheticEditorNodes, ...syntheticBrowserNodes, ...syntheticImageNodes, ...syntheticPluginWidgetNodes],
    projects.filter(project => !project.hidden).map(project => project.name),
    taxRepo.getWorktrees().filter(worktree => !worktree.spaceId || worktree.spaceId === activeSpaceId),
  ), [syntheticRunNodes, syntheticEditorNodes, syntheticBrowserNodes, syntheticImageNodes, syntheticPluginWidgetNodes, projects, taxRepo, activeSpaceId])

  const sidebarTree = useMemo(
    () => showEmptyEntities ? rawSidebarTree : filterEmptyNodes(rawSidebarTree),
    [rawSidebarTree, showEmptyEntities, filterEmptyNodes],
  )

  const canvasTree = useMemo(
    () => backgroundHiddenIds.size === 0 ? sidebarTree : pruneRunNodes(sidebarTree, backgroundHiddenIds),
    [sidebarTree, backgroundHiddenIds],
  )

  // Canvas view: drop run nodes the user has hidden via the eyeball. The sidebar
  // still shows them (dimmed) so the user can re-show them.
  const visibleCanvasTree = useMemo(() => {
    const canvasRoots = flattenUnscopedForCanvas(canvasTree)
    if (hiddenRunIds.size === 0) return canvasRoots
    const prune = (nodes: TreeNode[]): TreeNode[] => {
      const out: TreeNode[] = []
      for (const node of nodes) {
        if (node.type === 'run' && hiddenRunIds.has(node.entityId)) continue
        if (node.children.length === 0) {
          out.push(node)
          continue
        }
        const children = prune(node.children)
        if (children === node.children) out.push(node)
        else out.push({ ...node, children })
      }
      return out
    }
    return prune(canvasRoots)
  }, [canvasTree, hiddenRunIds])

  const allNodeIds = useMemo(() => {
    const ids: string[] = Array.from(runMap.keys()).map(id => `run-${id}`)
    for (const w of editorWidgets) ids.push(w.id)
    for (const w of browserWidgets) ids.push(w.id)
    for (const w of imageWidgets) ids.push(w.id)
    // Plugin widgets must be included too: useConstellations prunes any slot
    // member missing from this list (and persists the prune). Omitting them
    // evicted plugin widgets (e.g. stretchplan) from their constellation slot
    // on every fresh load, silently breaking their peer/capability link until
    // the user manually re-snapped the widget.
    for (const w of pluginWidgets) ids.push(w.id)
    return ids
  }, [runMap, editorWidgets, browserWidgets, imageWidgets, pluginWidgets])

  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(() => getPref('focusMode') ?? false)
  const focusModeRef = useRef(focusMode)
  focusModeRef.current = focusMode
  const [focusedRunBySpace, setFocusedRunBySpace] = useState<Record<string, string>>({})
  const [widgetsPaletteExpanded, setWidgetsPaletteExpanded] = useState(true)
  const [showSessionDialog, setShowSessionDialog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sessionPrefill, setSessionPrefill] = useState<SessionPrefill | null>(null)
  // When an add-widget flow opens the session dialog, this holds the callback to
  // run with the created sessionId so the canvas can place the resulting run.
  const [pendingSessionOnCreated, setPendingSessionOnCreated] = useState<((sessionId: string) => void) | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const { select, toggleSelect, deselect, expandAll, selectedCount: _selectedCount, state: selectionState } = useSelection()
  const arrangeResetRef = useRef<(() => void) | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  // Feature-flagged: commit activity buttons disabled for now
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
        apiFetch(`/api/spaces/${urlSpaceId}/activate`, { method: 'POST' })
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
    await apiFetch(`/api/spaces/${id}/activate`, { method: 'POST' })
    const url = new URL(location.href)
    url.searchParams.set('space', id)
    window.location.href = url.toString()
  }, [])

  const handleCreateSpace = useCallback(async (name: string) => {
    const res = await apiFetch('/api/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) return
    const space = await res.json() as { id: string }
    await apiFetch(`/api/spaces/${space.id}/activate`, { method: 'POST' })
    const url = new URL(location.href)
    url.searchParams.set('space', space.id)
    window.location.href = url.toString()
  }, [])

  const handleRenameSpace = useCallback((id: string, name: string) => {
    apiFetch(`/api/spaces/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  }, [])

  const handleDeleteSpace = useCallback((id: string) => {
    apiFetch(`/api/spaces/${id}`, { method: 'DELETE' })
  }, [])

  const handleRename = useCallback((entityId: string, type: GroupingDimension | 'run', newName: string) => {
    dispatchRename(entityId, type, newName, { run: runRepo.getById(entityId), addOptimistic })
  }, [runRepo, addOptimistic])

  const handleDelete = useCallback((entityId: string, type: GroupingDimension | string) => {
    if (pluginWidgetMap.has(entityId)) {
      apiFetch(`/api/plugin-widgets/${entityId}`, { method: 'DELETE' }).catch(err => {
        console.error('[plugin-widget] delete failed:', err)
      })
      return
    }
    if (type === 'run') {
      // Optimistically drop any hidden-runs entry for the acting browser, so a
      // reused name can't be born hidden without waiting for the SSE round-trip.
      // The run-removed delta prunes it universally too (idempotent no-op here).
      removeRunHidden(entityId)
      apiFetch(`/api/sessions/${entityId}`, { method: 'DELETE' })
      return
    }
    if (type === 'file-editor') {
      apiFetch(`/api/editor-widgets/${entityId}`, { method: 'DELETE' })
      return
    }
    if (type === 'browser-widget') {
      apiFetch(`/api/browser-widgets/${entityId}`, { method: 'DELETE' })
      return
    }
    if (type === 'image-viewer') {
      apiFetch(`/api/image-widgets/${entityId}`, { method: 'DELETE' })
      return
    }
    // Project and Worktree rows are organizational targets, not deletable
    // canvas widgets. Their lifecycle is owned by Project settings and git.
  }, [pluginWidgetMap, removeRunHidden])

  const handleReparent = useCallback((entityId: string, _entityType: string, newParentId: string | null, newParentType: string | null) => {
    const findTarget = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const node of nodes) {
        if (node.type === newParentType && node.entityId === (newParentId ?? '')) return node
        const nested = findTarget(node.children)
        if (nested) return nested
      }
      return undefined
    }
    const scope = newParentType === 'unscoped' || !newParentType
      ? {}
      : normalizedScope(findTarget(canvasTree)?.scope)
    void apiFetch(`/api/widgets/${encodeURIComponent(entityId)}/scope`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope),
    })
  }, [canvasTree])

  // Open the session create dialog on behalf of the add-widget flow, capturing a
  // callback to fire only after the session has been provisioned successfully.
  const handleRequestCreateSession = useCallback((prefill: SessionPrefill, onCreated: (sessionId: string) => void) => {
    setSessionPrefill(prefill)
    setPendingSessionOnCreated(() => onCreated)
    setShowSessionDialog(true)
  }, [])

  const existingSessionIds = useMemo(
    () => new Set(
      serverRunRepo.getAll()
        // A rejected client-only launch stays on the canvas for prompt/error
        // recovery, but it does not own a server name and may be retried.
        .filter(run => run.backend || run.status !== 'needs_attention')
        .map(run => run.id),
    ),
    [serverRunRepo],
  )

  const handleOptimisticSessionStart = useCallback((intent: OptimisticSessionIntent) => {
    const optimisticRun = buildOptimisticSessionRun(intent, activeSpaceId || undefined)
    setOptimisticSessionRuns(current => [
      ...current.filter(run => run.id !== optimisticRun.id),
      optimisticRun,
    ])
    addOptimistic('run', optimisticRun)
    if (intent.prompt) pushPromptHistory(intent.id, intent.prompt)
  }, [activeSpaceId, addOptimistic])

  const handleOptimisticSessionFailure = useCallback((intent: OptimisticSessionIntent, message: string) => {
    const current = runMapRef.current.get(intent.id)
    const failed = reconcileOptimisticSessionFailure(current, intent, message, activeSpaceId || undefined)
    if (failed) {
      setOptimisticSessionRuns(runs => [
        ...runs.filter(run => run.id !== failed.id),
        failed,
      ])
      addOptimistic('run', failed)
    }
  }, [activeSpaceId, addOptimistic])

  // Global hotkeys: session cycling
  const allRuns = useMemo(() => Array.from(runMap.values()), [runMap])
  // Keep raw run ID for session cycling in global hotkeys
  const selectedRunId = useMemo(() => {
    if (selectionState.selectedType !== 'run') return null
    const firstNodeId = [...selectionState.selectedIds][0] ?? null
    if (!firstNodeId) return null
    return firstNodeId.startsWith('run-') ? firstNodeId.slice(4) : firstNodeId
  }, [selectionState.selectedIds, selectionState.selectedType])

  // R15/R16: when the currently selected run transitions from prune-exempt to
  // prune-eligible — demoted to background via a delta, or attention clearing
  // on an already-background run whose breakthrough card was selected — clear
  // selection and any pending camera focus so no UI state dangles on the
  // unmounted card. The focus path clears via the selectedFocusNode sync
  // effect below once selection empties.
  const selectedRunPruneEligible = useMemo(() => {
    if (!selectedRunId) return false
    const run = runMap.get(selectedRunId)
    return run ? isBackgroundHidden(run, showBackgroundSessions) : false
  }, [selectedRunId, runMap, showBackgroundSessions])
  useEffect(() => {
    if (!selectedRunPruneEligible) return
    deselect()
    setFocusRunId(null)
  }, [selectedRunPruneEligible, deselect])

  // Derive focus for selectable work widgets. Scope rows only organize.
  const selectedFocusNode = useMemo<FocusNode | null>(() => {
    const { selectedType, selectedIds } = selectionState
    if (!selectedType || selectedIds.size === 0) return null
    const firstNodeId = [...selectedIds][0]
    if (!firstNodeId) return null

    if (selectedType === 'run') {
      const rawId = firstNodeId.startsWith('run-') ? firstNodeId.slice(4) : firstNodeId
      return { id: rawId, type: 'run-workspace', label: rawId }
    }

    if (selectedType === 'file-editor') {
      const label = findNodeLabel(canvasTree, firstNodeId) ?? 'File'
      return { id: firstNodeId, type: 'file-editor', label }
    }

    if (selectedType === 'browser-widget') {
      const label = findNodeLabel(canvasTree, firstNodeId) ?? 'Browser'
      return { id: firstNodeId, type: 'browser-widget', label }
    }

    if (selectedType === 'image-viewer') {
      const label = findNodeLabel(canvasTree, firstNodeId) ?? 'Image'
      return { id: firstNodeId, type: 'image-viewer', label }
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

  // Open settings dialog when the WidgetsPalette "Open Settings → Plugins" link fires
  useEffect(() => {
    function onOpenSettings() {
      setShowSettings(true)
    }
    window.addEventListener('tinstar:open-settings', onOpenSettings)
    return () => window.removeEventListener('tinstar:open-settings', onOpenSettings)
  }, [])

  useContextRouter({
    path,
    chordState,
    pushFocus,
    clearFocus,
    setChord,
    clearChord,
    onNavigate: (id) => triggerWidgetFlourish(id),
  })

  // sessionIds of runs hidden via the eyeball — used to skip them while cycling.
  const hiddenSessionIds = useMemo(() => {
    const out = new Set<string>()
    for (const run of allRuns) {
      if (isRunHidden(run.id) && run.sessionId) out.add(run.sessionId)
    }
    return out
  }, [allRuns, isRunHidden])

  // sessionIds of background runs currently pruned (toggle off, no attention) —
  // cycling must never land on an invisible card (R7). Filtering candidates
  // here also covers visibleCycleQueue's pre-report fallback, which bypasses
  // the sidebar's visible order. Revealed background runs (toggle on) and
  // breakthrough runs (attention pending) stay cyclable.
  const backgroundHiddenSessionIds = useMemo(() => {
    const out = new Set<string>()
    for (const run of allRuns) {
      if (isBackgroundHidden(run, showBackgroundSessions) && run.sessionId) out.add(run.sessionId)
    }
    return out
  }, [allRuns, showBackgroundSessions])

  // The sidebar reports the run ids it's currently showing, top-to-bottom, in
  // the exact order it renders them — after collapse, search pruning, and inbox
  // filters. Cycling reads this so `[` / `]` walk exactly what the operator
  // sees rather than the order sessions happened to become ready.
  const visibleRunOrderRef = useRef<string[]>([])
  const visibleRunOrderReportedRef = useRef(false)
  const [visibleRunOrder, setVisibleRunOrder] = useState<string[]>([])
  const handleVisibleRunOrder = useCallback((runIds: string[]) => {
    visibleRunOrderRef.current = runIds
    visibleRunOrderReportedRef.current = true
    setVisibleRunOrder(current => (
      current.length === runIds.length && current.every((id, index) => id === runIds[index])
        ? current
        : runIds
    ))
  }, [])

  const spaceRuns = useMemo(
    () => runsInFocusSpace(allRuns, activeSpaceId),
    [allRuns, activeSpaceId],
  )
  const excludedFocusRunIds = useMemo(() => new Set(spaceRuns
    .filter(run => isRunHidden(run.id) || isBackgroundHidden(run, showBackgroundSessions))
    .map(run => run.id)), [spaceRuns, isRunHidden, showBackgroundSessions])
  const focusEligibleSessionIds = useMemo(() => new Set(spaceRuns
    .filter(run => isBuiltInRunWorkspace(run) && run.status !== 'stopped' && !excludedFocusRunIds.has(run.id))
    .map(run => run.sessionId)
    .filter(Boolean)), [spaceRuns, excludedFocusRunIds])
  const focusResolution = useMemo(() => resolveFocusTarget({
    hydrated: !loading,
    runs: spaceRuns,
    selectedRunId,
    currentRunId: activeSpaceId ? focusedRunBySpace[activeSpaceId] : null,
    orderedCandidateIds: visibleRunOrder,
    excludedRunIds: excludedFocusRunIds,
  }), [loading, spaceRuns, selectedRunId, activeSpaceId, focusedRunBySpace, visibleRunOrder, excludedFocusRunIds])
  const focusedRunId = focusResolution.kind === 'focused' ? focusResolution.runId : null
  const focusedRunIdRef = useRef(focusedRunId)
  focusedRunIdRef.current = focusedRunId

  useEffect(() => {
    if (!focusMode || !activeSpaceId || !focusedRunId || focusedRunBySpace[activeSpaceId] === focusedRunId) return
    setFocusedRunBySpace(current => ({ ...current, [activeSpaceId]: focusedRunId }))
  }, [focusMode, activeSpaceId, focusedRunId, focusedRunBySpace])

  const handleFocusModeChange = useCallback((next: boolean) => {
    // Hotkeys can fire before React commits the state update. Keep their
    // event-time authority aligned with this tab's controlled mode.
    focusModeRef.current = next
    setFocusMode(next)
    setPref('focusMode', next)
  }, [])
  const cycleOrder = () =>
    visibleRunOrderRef.current
      .map(id => runMap.get(id)?.sessionId)
      .filter(Boolean) as string[]

  // Restrict cycling to sessions actually visible in the sidebar, preserving its
  // order. Collapsed, search-pruned, or inbox-filtered sessions are dropped from
  // the queue entirely — not just reordered — so `[` / `]` can't reach them. Fall
  // back to the candidates only before the sidebar has reported any order yet; once
  // it has, an empty visible view means an empty cycle queue.
  const visibleQueue = (candidates: string[], inFocus: boolean) =>
    inFocus
      ? focusCycleQueue(candidates, cycleOrder())
      : visibleCycleQueue(candidates, cycleOrder(), visibleRunOrderReportedRef.current)
  const isFocusModeActive = () => focusModeRef.current

  const cycleReadyNext = () => {
    const inFocus = isFocusModeActive()
    const queue = visibleQueue(readyQueue.filter(name => !hiddenSessionIds.has(name) && !backgroundHiddenSessionIds.has(name) && (!inFocus || focusEligibleSessionIds.has(name))), inFocus)
    const run = cycleNext(allRuns, queue, inFocus ? focusedRunIdRef.current : selectedRunId)
    if (run) { handleSelectRun(run.id); setFocusRunId(inFocus ? null : `run-${run.id}`) }
  }
  const cycleReadyPrev = () => {
    const inFocus = isFocusModeActive()
    const queue = visibleQueue(readyQueue.filter(name => !hiddenSessionIds.has(name) && !backgroundHiddenSessionIds.has(name) && (!inFocus || focusEligibleSessionIds.has(name))), inFocus)
    const run = cyclePrev(allRuns, queue, inFocus ? focusedRunIdRef.current : selectedRunId)
    if (run) { handleSelectRun(run.id); setFocusRunId(inFocus ? null : `run-${run.id}`) }
  }
  const cycleAllNext = () => {
    const inFocus = isFocusModeActive()
    const cycleRuns = inFocus ? spaceRuns : allRuns
    const active = cycleRuns.filter(r => r.status !== 'stopped' && !isRunHidden(r.id) && !isBackgroundHidden(r, showBackgroundSessions) && (!inFocus || isBuiltInRunWorkspace(r))).map(r => r.sessionId).filter(Boolean) as string[]
    const run = cycleNext(allRuns, visibleQueue(active, inFocus), inFocus ? focusedRunIdRef.current : selectedRunId)
    if (run) { handleSelectRun(run.id); setFocusRunId(inFocus ? null : `run-${run.id}`) }
  }
  const cycleAllPrev = () => {
    const inFocus = isFocusModeActive()
    const cycleRuns = inFocus ? spaceRuns : allRuns
    const active = cycleRuns.filter(r => r.status !== 'stopped' && !isRunHidden(r.id) && !isBackgroundHidden(r, showBackgroundSessions) && (!inFocus || isBuiltInRunWorkspace(r))).map(r => r.sessionId).filter(Boolean) as string[]
    const run = cyclePrev(allRuns, visibleQueue(active, inFocus), inFocus ? focusedRunIdRef.current : selectedRunId)
    if (run) { handleSelectRun(run.id); setFocusRunId(inFocus ? null : `run-${run.id}`) }
  }

  const terminalCycleHandlersRef = useRef({
    'ready-next': cycleReadyNext,
    'ready-prev': cycleReadyPrev,
    'all-next': cycleAllNext,
    'all-prev': cycleAllPrev,
  })
  terminalCycleHandlersRef.current = {
    'ready-next': cycleReadyNext,
    'ready-prev': cycleReadyPrev,
    'all-next': cycleAllNext,
    'all-prev': cycleAllPrev,
  }

  useEffect(() => {
    const onTerminalCycle = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action
      if (
        action === 'ready-next'
        || action === 'ready-prev'
        || action === 'all-next'
        || action === 'all-prev'
      ) {
        terminalCycleHandlersRef.current[action]()
      }
    }
    window.addEventListener('tinstar:terminal-session-cycle', onTerminalCycle)
    return () => window.removeEventListener('tinstar:terminal-session-cycle', onTerminalCycle)
  }, [])

  useGlobalHotkeys({
    onCycleReadyNext: cycleReadyNext,
    onCycleReadyPrev: cycleReadyPrev,
    onCycleAllNext: cycleAllNext,
    onCycleAllPrev: cycleAllPrev,
    onSessionQuick: useCallback(async () => {
      setSessionPrefill(null)
      setShowSessionDialog(true)
    }, []),
    onCreateChild: useCallback(() => {}, []),
    onToggleEmptyEntities: useCallback(() => {
      const next = !showEmptyEntities
      setShowEmptyEntities(next)
      patchConfig({ ui: { showEmptyEntities: next } as never }).catch(err => {
        console.warn('[workspace] showEmptyEntities patch failed:', err)
      })
    }, [showEmptyEntities]),
    onEntitySettings: useCallback(() => {}, []),
    onPaletteOpen: () => setPaletteOpen(true),
  })

  // Sidebar double-click passes node.id directly (for example "run-vpp").
  const handleFocusNode = useCallback((nodeId: string) => {
    if (focusMode && nodeId.startsWith('run-')) {
      const runId = nodeId.slice(4)
      const run = runMap.get(runId)
      if (activeSpaceId && isBuiltInRunWorkspace(run)) {
        setFocusedRunBySpace(current => ({ ...current, [activeSpaceId]: runId }))
        select(nodeId, 'run')
      }
      return
    }
    setFocusRunId(nodeId)
  }, [focusMode, runMap, activeSpaceId, select])

  const handleFocusHandled = useCallback(() => {
    setFocusRunId(null)
  }, [])

  // Click on canvas widget → select in hierarchy + expand ancestors in Canvas.
  const handleSelectRun = useCallback((runId: string, additive = false) => {
    const nodeId = `run-${runId}`
    // Focus navigation leaves the hierarchy's collapse state alone. This also
    // keeps its session order stable across consecutive next/previous chords.
    if (!focusMode) {
      const ancestors = findAncestorIds(sidebarTree, nodeId)
      if (ancestors.length > 0) expandAll(ancestors)
    }
    if (additive) {
      toggleSelect(nodeId, 'run')
    } else {
      select(nodeId, 'run')
    }
    if (focusMode && activeSpaceId && isBuiltInRunWorkspace(runMap.get(runId))) {
      setFocusedRunBySpace(current => ({ ...current, [activeSpaceId]: runId }))
    }
  }, [sidebarTree, select, toggleSelect, expandAll, focusMode, activeSpaceId, runMap])

  // Double-click on canvas widget → zoom to fit (receives run.id, needs prefixing)
  const handleCanvasFocusRun = useCallback((runId: string) => {
    if (!focusMode) setFocusRunId(`run-${runId}`)
    handleSelectRun(runId)
  }, [focusMode, handleSelectRun])

  // Auto-focus a freshly created run when it first appears, panning the canvas
  // to it — UNLESS it was spawned passively (focusOnCreate === false), the
  // opt-out wired through POST /api/sessions `focus:false`. Guarded like the pin
  // auto-open: runs present on mount are seeded as "seen" so a reload/space-switch
  // doesn't fling the camera, each run is focused at most once, and a recency
  // check rejects runs that arrive via late hydration/SSE with an old createdAt.
  const autoFocusSeen = useRef<Set<string>>(new Set())
  const autoFocusSeeded = useRef(false)
  useEffect(() => {
    const now = Date.now()
    if (!autoFocusSeeded.current) {
      autoFocusSeeded.current = true
      for (const run of runMap.values()) autoFocusSeen.current.add(run.id)
      return
    }
    for (const run of runMap.values()) {
      if (autoFocusSeen.current.has(run.id)) continue
      autoFocusSeen.current.add(run.id)
      if (run.focusOnCreate === false) continue // passive spawn — leave the viewport put
      const createdMs = run.createdAt ? Date.parse(run.createdAt) : NaN
      if (Number.isFinite(createdMs) && now - createdMs < 30_000) {
        if (focusMode && activeSpaceId && isBuiltInRunWorkspace(run)) {
          setFocusedRunBySpace(current => ({ ...current, [activeSpaceId]: run.id }))
        } else {
          setFocusRunId(`run-${run.id}`)
        }
      }
    }
  }, [runMap, focusMode, activeSpaceId])

  return (
    <>
      <PluginFailedBanner />
      {activeSpaceId ? (
        <ConstellationProvider spaceId={activeSpaceId} nodeIds={allNodeIds}>
          <PinsBridge spaceId={activeSpaceId} />
          <TaxonomyProvider taxRepo={taxRepo}>
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
                    <span className="text-2xs font-mono text-slate-500 flex-shrink-0 whitespace-nowrap">{activeRunCount} runs</span>
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

                  {/* Sidebar body: hierarchy scrolls within its own region; the widgets palette
                      stays pinned + visible below it (previously both shared one scroll container,
                      so the palette was pushed off the bottom). */}
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="flex-1 min-h-0 overflow-hidden">
                    <HierarchySidebar
                        tree={canvasTree}
                        unfilteredTree={rawSidebarTree}
                        dimensions={dimensions}
                        spaces={spaces}
                        activeSpaceId={activeSpaceId}
                        showEmptyEntities={showEmptyEntities}
                        showBackgroundSessions={showBackgroundSessions}
                        onToggleShowBackground={() => setShowBackgroundSessions(v => !v)}
                        backgroundCount={backgroundCount}
                        backgroundRunIds={backgroundRunIds}
                        onToggleShowEmpty={() => {
                          const next = !showEmptyEntities
                          setShowEmptyEntities(next)
                          patchConfig({ ui: { showEmptyEntities: next } as never }).catch(err => {
                            console.warn('[workspace] showEmptyEntities patch failed:', err)
                          })
                        }}
                        onActivateSpace={handleActivateSpace}
                        onCreateSpace={handleCreateSpace}
                        onRenameSpace={handleRenameSpace}
                        onDeleteSpace={handleDeleteSpace}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        onFocusRun={handleFocusNode}
                        onReparent={handleReparent}
                        onOrganize={() => arrangeResetRef.current?.()}
                        onCollapse={() => setSidebarCollapsed(true)}
                        renamingNodeId={renamingNodeId}
                        onRenameComplete={() => setRenamingNodeId(null)}
                        hiddenRunIds={hiddenRunIds}
                        onToggleRunHidden={toggleRunHidden}
                        pluginWidgetIds={pluginWidgetIdSet}
                        onVisibleRunOrder={handleVisibleRunOrder}
                      />
                    </div>
                    <WidgetsPalette
                      expanded={widgetsPaletteExpanded}
                      onExpandedChange={setWidgetsPaletteExpanded}
                      forceCollapsed={focusMode}
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
                  <div className="absolute left-3 top-3 z-[60]">
                    <FocusModeToggle focusMode={focusMode} onChange={handleFocusModeChange} />
                  </div>
                  <InfiniteCanvas
                    tree={visibleCanvasTree}
                    editorWidgetMap={editorWidgetMap}
                    browserWidgetMap={browserWidgetMap}
                    imageWidgetMap={imageWidgetMap}
                    pluginWidgetMap={pluginWidgetMap}
                    runMap={runMap}
                    focusRunId={focusRunId}
                    focusMode={focusMode}
                    focusedRunId={focusedRunId}
                    activeSpaceId={activeSpaceId}
                    onFocusHandled={handleFocusHandled}
                    onSelectRun={handleSelectRun}
                    onFocusRun={handleCanvasFocusRun}
                    onDeleteEntity={handleDelete}
                    onRequestCreateSession={handleRequestCreateSession}
                    onImageWidgetCreated={(widget) => addOptimistic('imageWidget', widget)}
                    onEditorWidgetCreated={(widget) => addOptimistic('editorWidget', widget)}
                    onBrowserWidgetCreated={(widget) => addOptimistic('browserWidget', widget)}
                    onPluginWidgetCreated={(instance) => addOptimistic('pluginWidget', instance)}
                    arrangeResetRef={arrangeResetRef}
                    forceMarshalOpen={forceMarshalOpen}
                  />
                  {!focusMode && <PaletteDragGhost />}
                  {focusMode && focusResolution.kind !== 'focused' && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-base/95" data-testid={`focus-${focusResolution.kind}-state`}>
                      <div className="max-w-sm text-center text-sm text-slate-400">
                        {FOCUS_STATE_MESSAGES[focusResolution.kind]}
                        {focusResolution.kind !== 'resolving' && (
                          <button className="mt-4 block w-full text-primary underline" onClick={() => handleFocusModeChange(false)}>
                            Return to Canvas
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

              {showSessionDialog && (
                <CreateSessionDialog
                  onClose={() => { setShowSessionDialog(false); setSessionPrefill(null); setPendingSessionOnCreated(null) }}
                  prefill={sessionPrefill ?? undefined}
                  existingSessionIds={existingSessionIds}
                  onCreateStarted={handleOptimisticSessionStart}
                  onCreateFailed={handleOptimisticSessionFailure}
                  onCreated={(sessionId) => pendingSessionOnCreated?.(sessionId)}
                />
              )}

              {showSettings && (
                <SettingsDialog
                  onClose={() => setShowSettings(false)}
                  focusMode={focusMode}
                  onFocusModeChange={handleFocusModeChange}
                />
              )}

            </div>
          </TaxonomyProvider>
        </ConstellationProvider>
      ) : (
        <TaxonomyProvider taxRepo={taxRepo}>
          <div className="flex flex-col h-screen w-screen bg-surface-base text-slate-200 font-mono">
            <OnboardingCanvas />
          </div>
        </TaxonomyProvider>
      )}
      <DownloadPushToast />
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
