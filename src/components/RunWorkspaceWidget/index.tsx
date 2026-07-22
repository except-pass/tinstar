import { useState, useRef, useCallback, useReducer, useEffect, type PointerEvent as ReactPointerEvent } from 'react'
import type { RunData } from '../../types'
import { RunWorkspaceHeader } from './RunWorkspaceHeader'
import { TouchedFilesPanel } from './TouchedFilesPanel'
import { FileTreePanel } from './FileTreePanel'
import { RunSessionPanel } from './RunSessionPanel'
import { TelemetryPanel } from './TelemetryPanel'
import { SlatePanel } from './SlatePanel'
import { HandsPanel } from './HandsPanel'
import { registerActionHandler, deregisterActionHandler, registerFlourishHandler, registerScanHandler, deregisterFlourishHandler } from '../../hotkeys/actionHandlerRegistry'
import { fitWidgetToViewport } from '../../hotkeys/canvasActionsRegistry'
import { useFlourish } from '../../hotkeys/useFlourish'
import { useWidgetFocus, useFocusPath } from '../../hotkeys/FocusPathContext'
import type { FocusZone } from '../../hotkeys/widgetTypes'
import '../../hotkeys/widgets/runWorkspaceWidget'  // side-effect: registers WidgetDefinition
import { hexToRgba, resolveRunAccent } from '../runAccent'
import { apiFetch } from '../../apiClient'
import { useConfig } from '../../context/ConfigContext'
import { getPref, setPref } from '../../lib/uiPrefs'

// The Slate column's drag-resize bounds (Slate v2 U1/R1). Two-column reflow
// kicks in above SLATE_TWO_COL_MIN (see SlatePanel); the max keeps the column
// from crowding out the session pane on a narrow card.
const SLATE_MIN_WIDTH = 260
const SLATE_MAX_WIDTH = 560
const SLATE_DEFAULT_WIDTH = 320

interface Props {
  run: RunData
  className?: string
  compact?: boolean
  zoom?: number
  isSelected?: boolean
  isDragging?: boolean
  /** Hide the header (used when an external drag handle replaces it) */
  headless?: boolean
  /** Pointer event handlers forwarded to the header for drag */
  onHeaderPointerDown?: (e: ReactPointerEvent) => void
  onHeaderPointerMove?: (e: ReactPointerEvent) => void
  onHeaderPointerUp?: (e: ReactPointerEvent) => void
}

type FilePanelMode = 'touched' | 'tree'

export function RunWorkspaceWidget({ run, className = '', compact = false, zoom = 1, isSelected = false, isDragging = false, headless = false, onHeaderPointerDown: _onHeaderPointerDown, onHeaderPointerMove: _onHeaderPointerMove, onHeaderPointerUp: _onHeaderPointerUp }: Props) {

  const [filesCollapsed, setFilesCollapsed] = useState(compact)
  const [filePanelMode, setFilePanelMode] = useState<FilePanelMode>('touched')
  const [handsCollapsed, setHandsCollapsed] = useState(false)
  const [sessionTab, setSessionTab] = useState<'recap' | 'terminal'>(run.port ? 'terminal' : 'recap')
  const [filesPanelWidth, setFilesPanelWidth] = useState(180)
  const [handsPanelHeight, setHandsPanelHeight] = useState(120)
  // Slate column width — restored from the per-browser pref on mount, written on
  // drag end (Slate v2 U1/R1). Mirrors the files-panel resize below.
  const [slateWidth, setSlateWidth] = useState(() => getPref('slateWidth') ?? SLATE_DEFAULT_WIDTH)
  const resizeDragRef = useRef<{ startX: number; startW: number } | null>(null)
  const handsResizeDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const slateResizeDragRef = useRef<{ startX: number; startW: number } | null>(null)

  const [termTick, bumpTerm] = useReducer((n: number) => n + 1, 0)
  const config = useConfig()
  const composerDefault = config?.ui.promptComposerDefault ?? false
  const [promptComposerExpanded, setPromptComposerExpanded] = useState(composerDefault)
  // One-shot init: when config first arrives, seed local state from it (then user controls it).
  const composerInitedRef = useRef(config != null)
  useEffect(() => {
    if (!composerInitedRef.current && config != null) {
      composerInitedRef.current = true
      setPromptComposerExpanded(composerDefault)
    }
  }, [config, composerDefault])
  const [composerFocusTrigger, bumpComposerFocus] = useReducer((n: number) => n + 1, 0)

  const rootRef = useRef<HTMLDivElement>(null)
  const [focusZone, setFocusZone] = useState<FocusZone | null>(null)
  const [terminalFocused, setTerminalFocused] = useState(false)
  const [_fileSelectionIndex, setFileSelectionIndex] = useState(0)
  const [centerTabIndex, setCenterTabIndex] = useState(0)

  const leftExpanded = !filesCollapsed
  const runAccent = resolveRunAccent(run.color)

  // The Slate column is additive: only present (and only a focus zone) when the
  // run actually has surfaces, so an empty run keeps its three-panel layout.
  const hasSlate = (run.slate?.length ?? 0) > 0

  const ZONES: FocusZone[] = [
    ...(leftExpanded ? (['left-tab', 'file-list'] as FocusZone[]) : []),
    'center-tabs',
    ...(hasSlate ? (['slate'] as FocusZone[]) : []),
    'right-panel',
  ]

  const { activeContextKey } = useWidgetFocus(run.id)
  const { pushFocus, popFocus, path } = useFocusPath()

  // Push/pop terminal context — used by both the Ctrl+\ key path and the click toggle
  const handleTerminalToggle = useCallback(() => {
    if (activeContextKey === 'run-terminal') {
      setTerminalFocused(false)
      popFocus()
      requestAnimationFrame(() => rootRef.current?.focus())
    } else {
      pushFocus({ id: run.id, type: 'run-terminal', label: 'Terminal' })
    }
  }, [activeContextKey, pushFocus, popFocus, run.id, rootRef])

  const onFocusNext = useCallback(() => {
    setFocusZone(prev => {
      const idx = prev ? ZONES.indexOf(prev) : -1
      return ZONES[(idx + 1) % ZONES.length] ?? ZONES[0]!
    })
  }, [leftExpanded, hasSlate])

  const onFocusPrev = useCallback(() => {
    setFocusZone(prev => {
      const idx = prev ? ZONES.indexOf(prev) : 0
      return ZONES[(idx - 1 + ZONES.length) % ZONES.length] ?? ZONES[0]!
    })
  }, [leftExpanded, hasSlate])

  // Sync terminal focus when context router navigates into run-terminal
  useEffect(() => {
    if (activeContextKey === 'run-terminal') {
      setTerminalFocused(true)
      requestAnimationFrame(() => {
        const iframe = rootRef.current?.querySelector('iframe') as HTMLIFrameElement | null
        if (iframe) {
          iframe.focus()
          iframe.contentWindow?.postMessage({ type: 'terminal-focus' }, '*')
        }
      })
    }
  }, [activeContextKey, rootRef])

  // When the window regains focus (iframe lost focus), clear terminal state and pop the context
  useEffect(() => {
    const onWindowFocus = () => {
      setTerminalFocused(false)
      popFocus()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [popFocus])

  // When widget becomes selected and prompt composer is open, focus the composer
  useEffect(() => {
    if (isSelected && promptComposerExpanded) {
      bumpComposerFocus()
    }
  }, [isSelected, promptComposerExpanded])

  // Expose action dispatch so context router can trigger widget actions
  const { triggerHollywoodHit, triggerScanLine } = useFlourish(rootRef)

  useEffect(() => {
    registerActionHandler(run.id, (action) => {
      // terminal-exit must fire even when terminal has focus
      if (action === 'terminal-exit') {
        popFocus()
        requestAnimationFrame(() => rootRef.current?.focus())
        return
      }
      // All other widget hotkeys suspended when terminal has focus
      if (terminalFocused) return
      switch (action) {
        case 'focus-next':      onFocusNext();                                    break
        case 'focus-prev':      onFocusPrev();                                    break
        case 'file-down':       setFileSelectionIndex(i => i + 1);               break
        case 'file-up':         setFileSelectionIndex(i => Math.max(i - 1, 0));  break
        case 'tab-next':        setCenterTabIndex(i => (i + 1) % 2);             break
        case 'tab-prev':        setCenterTabIndex(i => (i - 1 + 2) % 2);        break
        case 'activate':        /* no-op for now */                               break
        case 'toggle-prompt':   setPromptComposerExpanded(e => !e);              break
        case 'fit-viewport':    fitWidgetToViewport(`run-${run.id}`);            break
      }
    })
    return () => deregisterActionHandler(run.id)
  })

  useEffect(() => {
    registerFlourishHandler(run.id, triggerHollywoodHit)
    registerScanHandler(run.id, triggerScanLine)
    return () => deregisterFlourishHandler(run.id)
  }, [run.id, triggerHollywoodHit, triggerScanLine])

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeDragRef.current = { startX: e.clientX, startW: filesPanelWidth }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [filesPanelWidth])

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeDragRef.current) return
    setFilesPanelWidth(Math.max(120, Math.min(500, resizeDragRef.current.startW + (e.clientX - resizeDragRef.current.startX))))
  }, [])

  const onResizePointerUp = useCallback(() => { resizeDragRef.current = null }, [])

  // Slate column resize — the grab handle sits on the Slate's LEFT border, so
  // dragging left (clientX decreasing) widens it (R1). Persisted on drag end.
  const onSlateResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    slateResizeDragRef.current = { startX: e.clientX, startW: slateWidth }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [slateWidth])

  const onSlateResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!slateResizeDragRef.current) return
    const next = slateResizeDragRef.current.startW + (slateResizeDragRef.current.startX - e.clientX)
    setSlateWidth(Math.max(SLATE_MIN_WIDTH, Math.min(SLATE_MAX_WIDTH, next)))
  }, [])

  const onSlateResizePointerUp = useCallback(() => {
    if (!slateResizeDragRef.current) return
    slateResizeDragRef.current = null
    // Persist the settled width so it survives reload (R1).
    setSlateWidth((w) => { setPref('slateWidth', w); return w })
  }, [])

  const onHandsResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    handsResizeDragRef.current = { startY: e.clientY, startH: handsPanelHeight }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [handsPanelHeight])

  const onHandsResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!handsResizeDragRef.current) return
    // Dragging up increases height (startY - clientY is positive when moving up)
    setHandsPanelHeight(Math.max(60, Math.min(400, handsResizeDragRef.current.startH + (handsResizeDragRef.current.startY - e.clientY))))
  }, [])

  const onHandsResizePointerUp = useCallback(() => { handsResizeDragRef.current = null }, [])

  const handleOpenFile = useCallback((filePath: string) => {
    apiFetch('/api/editor/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, sessionId: run.sessionId }),
    }).catch(() => {})
  }, [run.sessionId])

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid={`widget-root-${run.id}`}
      className={`relative flex flex-col overflow-hidden bg-surface-base border ${className}`}
      style={terminalFocused
        ? { borderColor: hexToRgba(runAccent, 0.1), boxShadow: 'none' }
        : isDragging
          ? { borderColor: hexToRgba(runAccent, 0.9), boxShadow: `0 20px 80px ${hexToRgba(runAccent, 0.55)}, 0 40px 120px ${hexToRgba(runAccent, 0.3)}, 0 0 0 2px ${hexToRgba(runAccent, 0.8)}, 0 0 40px ${hexToRgba(runAccent, 0.2)}` }
          : isSelected
            ? { borderColor: hexToRgba(runAccent, 0.9), boxShadow: `0 0 0 1px ${hexToRgba(runAccent, 0.5)}, 0 0 16px ${hexToRgba(runAccent, 0.25)}` }
            : { borderColor: hexToRgba(runAccent, 0.3), boxShadow: `0 0 6px ${hexToRgba(runAccent, 0.1)}` }
      }
    >
      {/* Flourish animation layers */}
      <div className="flourish-scan-line" />
      <div className="flourish-ripple-ring" />
      {/* Header doubles as drag handle */}
      {!headless && (
        <RunWorkspaceHeader
          run={run}
          compact={compact}
          onRefreshTerminal={bumpTerm}
          activeTab={sessionTab}
          onActiveTabChange={setSessionTab}
        />
      )}

      {/* Three-panel workspace */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {filesCollapsed ? (
          <div
            data-testid="collapsed-files"
            className="w-6 flex flex-col items-center justify-center bg-surface-panel cursor-pointer hover:bg-surface-hover"
            style={{ borderRight: `1px solid ${hexToRgba(runAccent, 0.2)}` }}
            onClick={() => setFilesCollapsed(false)}
          >
            <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr] rotate-180">Files</span>
          </div>
        ) : (
          <div
            className="flex flex-col bg-surface-panel relative flex-shrink-0 min-h-0"
            style={{ width: filesPanelWidth, borderRight: `1px solid ${hexToRgba(runAccent, 0.2)}` }}
          >
            {/* Mode toggle tabs */}
            <div
              data-testid="focus-zone-left-tab"
              className={`flex ${focusZone === 'left-tab' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
              style={{ borderBottom: `1px solid ${hexToRgba(runAccent, 0.15)}` }}
            >
              <button
                onClick={() => setFilePanelMode('touched')}
                className={`flex-1 px-2 py-1 text-2xs font-mono uppercase tracking-wider transition-colors ${
                  filePanelMode === 'touched'
                    ? ''
                    : 'text-slate-500 hover:text-slate-300 hover:bg-surface-hover'
                }`}
                style={filePanelMode === 'touched' ? { color: runAccent, backgroundColor: hexToRgba(runAccent, 0.1), borderBottom: `1px solid ${runAccent}` } : undefined}
              >
                Changed
              </button>
              <button
                onClick={() => setFilePanelMode('tree')}
                className={`flex-1 px-2 py-1 text-2xs font-mono uppercase tracking-wider transition-colors ${
                  filePanelMode === 'tree'
                    ? ''
                    : 'text-slate-500 hover:text-slate-300 hover:bg-surface-hover'
                }`}
                style={filePanelMode === 'tree' ? { color: runAccent, backgroundColor: hexToRgba(runAccent, 0.1), borderBottom: `1px solid ${runAccent}` } : undefined}
              >
                Explorer
              </button>
              <button
                onClick={() => setFilesCollapsed(true)}
                className="px-1 text-slate-500"
                style={{ color: runAccent }}
              >
                <span className="material-symbols-outlined text-sm">chevron_left</span>
              </button>
            </div>
            {/* Panel content */}
            <div
              data-testid="focus-zone-file-list"
              className={`flex flex-col flex-1 min-h-0 overflow-hidden ${focusZone === 'file-list' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
            >
              {filePanelMode === 'touched' ? (
                <TouchedFilesPanel files={run.touchedFiles} sessionId={run.sessionId} onOpenFile={handleOpenFile} />
              ) : (
                <FileTreePanel sessionId={run.sessionId} onOpenFile={handleOpenFile} />
              )}
            </div>
            {/* Hands panel at bottom - only show if NATS enabled */}
            {run.natsEnabled && !handsCollapsed && (
              <div className="relative flex-shrink-0" style={{ height: handsPanelHeight }}>
                {/* Vertical resize handle */}
                <div
                  className="absolute top-0 left-0 right-0 h-1.5 cursor-row-resize transition-colors z-10 hover:bg-primary/30"
                  style={{ backgroundColor: hexToRgba(runAccent, 0.18) }}
                  onPointerDown={onHandsResizePointerDown}
                  onPointerMove={onHandsResizePointerMove}
                  onPointerUp={onHandsResizePointerUp}
                />
                <HandsPanel
                  sessionId={run.sessionId}
                  onCollapse={() => setHandsCollapsed(true)}
                />
              </div>
            )}
            {/* Collapsed hands indicator */}
            {run.natsEnabled && handsCollapsed && (
              <div
                className="h-6 flex items-center justify-center bg-surface-panel cursor-pointer hover:bg-surface-hover border-t border-primary/10"
                onClick={() => setHandsCollapsed(false)}
                title="Show Hands panel"
              >
                <span className="text-2xs font-mono text-slate-500 flex items-center gap-1">
                  <span>🤚</span>
                  <span>Hands</span>
                </span>
              </div>
            )}
            {/* Resize handle */}
            <div
              className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize transition-colors z-10"
              style={{ backgroundColor: hexToRgba(runAccent, 0.18) }}
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
            />
          </div>
        )}
        <div
          data-testid="focus-zone-center-tabs"
          className={`flex-1 flex flex-col min-w-0 min-h-0 ${focusZone === 'center-tabs' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
        >
          <RunSessionPanel
            recapEntries={run.recapEntries}
            rawLogs={run.rawLogs}
            port={run.port}
            sessionId={run.sessionId}
            status={run.status}
            color={run.color}
            termTick={termTick}
            terminalFocused={terminalFocused}
            zoom={zoom}
            onTerminalToggle={handleTerminalToggle}
            onTerminalPointerFocus={() => {
              setTerminalFocused(true)
              if (activeContextKey === 'run-terminal') return
              // Ensure run-workspace is in the path before pushing run-terminal.
              // TerminalFrame.onPointerDown stops propagation so the widget may not
              // be "selected" via the normal path — push run-workspace manually if needed.
              if (!path.some(n => n.id === run.id && n.type === 'run-workspace')) {
                pushFocus({ id: run.id, type: 'run-workspace', label: run.id })
              }
              pushFocus({ id: run.id, type: 'run-terminal', label: 'Terminal' })
            }}
            activeTabIndex={focusZone === 'center-tabs' ? centerTabIndex : undefined}
            controlledTab={sessionTab}
            onControlledTabChange={setSessionTab}
            promptComposerExpanded={promptComposerExpanded}
            onPromptComposerToggle={() => setPromptComposerExpanded(e => !e)}
            composerFocusTrigger={composerFocusTrigger}
          />
        </div>
        {hasSlate && (
          <div
            data-testid="focus-zone-slate"
            className={`flex ${focusZone === 'slate' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
          >
            <div
              className="relative h-full flex flex-col overflow-hidden bg-surface-panel border-l border-primary/10 flex-shrink-0"
              style={{ width: slateWidth }}
            >
              {/* Left-border drag handle — widen by dragging left (R1). */}
              <div
                data-testid="slate-resize-handle"
                className="absolute top-0 left-0 w-1.5 h-full cursor-col-resize transition-colors z-10"
                style={{ backgroundColor: hexToRgba(runAccent, 0.18) }}
                onPointerDown={onSlateResizePointerDown}
                onPointerMove={onSlateResizePointerMove}
                onPointerUp={onSlateResizePointerUp}
              />
              <SlatePanel runId={run.id} surfaces={run.slate} width={slateWidth} />
            </div>
          </div>
        )}
        <div
          data-testid="focus-zone-right-panel"
          className={`flex ${focusZone === 'right-panel' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
        >
          <div className="w-40 h-full flex flex-col bg-surface-panel">
            <TelemetryPanel
              sessionId={run.sessionId}
              runAccent={runAccent}
            />
          </div>
        </div>
      </div>

    </div>
  )
}
