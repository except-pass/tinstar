import { useState, useRef, useCallback, useReducer, type PointerEvent as ReactPointerEvent } from 'react'
import type { RunData } from '../../types'
import { RunWorkspaceHeader } from './RunWorkspaceHeader'
import { TouchedFilesPanel } from './TouchedFilesPanel'
import { FileTreePanel } from './FileTreePanel'
import { RunSessionPanel } from './RunSessionPanel'
import { ProceduresPanel } from './ProceduresPanel'
import { SkillPickerModal } from './SkillPickerModal'
import { useSkillsContext } from '../SkillsProvider'
import { useWidgetHotkeys, type FocusZone } from '../../hotkeys/useWidgetHotkeys'

interface Props {
  run: RunData
  className?: string
  compact?: boolean
  /** Hide the header (used when an external drag handle replaces it) */
  headless?: boolean
  /** Pointer event handlers forwarded to the header for drag */
  onHeaderPointerDown?: (e: ReactPointerEvent) => void
  onHeaderPointerMove?: (e: ReactPointerEvent) => void
  onHeaderPointerUp?: (e: ReactPointerEvent) => void
}

type FilePanelMode = 'touched' | 'tree'

export function RunWorkspaceWidget({ run, className = '', compact = false, headless = false, onHeaderPointerDown, onHeaderPointerMove, onHeaderPointerUp }: Props) {

  const [filesCollapsed, setFilesCollapsed] = useState(compact)
  const [filePanelMode, setFilePanelMode] = useState<FilePanelMode>('touched')
  const [procsCollapsed, setProcsCollapsed] = useState(true)
  const [filesPanelWidth, setFilesPanelWidth] = useState(180)
  const resizeDragRef = useRef<{ startX: number; startW: number } | null>(null)
  const [termTick, bumpTerm] = useReducer((n: number) => n + 1, 0)

  const rootRef = useRef<HTMLDivElement>(null)
  const [focusZone, setFocusZone] = useState<FocusZone | null>(null)
  const [terminalFocused, setTerminalFocused] = useState(false)
  const [fileSelectionIndex, setFileSelectionIndex] = useState(0)
  const [centerTabIndex, setCenterTabIndex] = useState(0)

  const leftExpanded = !filesCollapsed

  const ZONES: FocusZone[] = leftExpanded
    ? ['left-tab', 'file-list', 'center-tabs', 'right-panel']
    : ['center-tabs', 'right-panel']

  const onFocusNext = useCallback(() => {
    setFocusZone(prev => {
      const idx = prev ? ZONES.indexOf(prev) : -1
      return ZONES[(idx + 1) % ZONES.length] ?? ZONES[0]!
    })
  }, [leftExpanded])

  const onFocusPrev = useCallback(() => {
    setFocusZone(prev => {
      const idx = prev ? ZONES.indexOf(prev) : 0
      return ZONES[(idx - 1 + ZONES.length) % ZONES.length] ?? ZONES[0]!
    })
  }, [leftExpanded])

  useWidgetHotkeys(rootRef, {
    onFocusNext,
    onFocusPrev,
    onFileDown: () => setFileSelectionIndex(i => i + 1),
    onFileUp:   () => setFileSelectionIndex(i => Math.max(i - 1, 0)),
    onTabNext:  () => setCenterTabIndex(i => (i + 1) % 2),
    onTabPrev:  () => setCenterTabIndex(i => (i - 1 + 2) % 2),
    onActivate: () => { /* no-op for now */ },
    onTerminalToggle: () => {
      setTerminalFocused(f => !f)
    },
    terminalFocused,
  })

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

  const handleOpenFile = useCallback((filePath: string) => {
    fetch('/api/editor/open', {
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
      className={`flex flex-col overflow-hidden neon-border bg-surface-base ${className}`}
    >
      {/* Header doubles as drag handle */}
      {!headless && (
        <RunWorkspaceHeader
          run={run}
          compact={compact}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onRefreshTerminal={bumpTerm}
        />
      )}

      {/* Three-panel workspace */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {filesCollapsed ? (
          <div
            data-testid="collapsed-files"
            className="w-6 flex flex-col items-center justify-center bg-surface-panel border-r border-primary/20 cursor-pointer hover:bg-surface-hover"
            onClick={() => setFilesCollapsed(false)}
          >
            <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr] rotate-180">Files</span>
          </div>
        ) : (
          <div className="flex flex-col bg-surface-panel border-r border-primary/20 relative flex-shrink-0" style={{ width: filesPanelWidth }}>
            {/* Mode toggle tabs */}
            <div
              data-testid="focus-zone-left-tab"
              className={`flex border-b border-primary/15 ${focusZone === 'left-tab' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
            >
              <button
                onClick={() => setFilePanelMode('touched')}
                className={`flex-1 px-2 py-1 text-2xs font-mono uppercase tracking-wider transition-colors ${
                  filePanelMode === 'touched'
                    ? 'text-primary bg-primary/10 border-b border-primary'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-surface-hover'
                }`}
              >
                Changed
              </button>
              <button
                onClick={() => setFilePanelMode('tree')}
                className={`flex-1 px-2 py-1 text-2xs font-mono uppercase tracking-wider transition-colors ${
                  filePanelMode === 'tree'
                    ? 'text-primary bg-primary/10 border-b border-primary'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-surface-hover'
                }`}
              >
                Explorer
              </button>
              <button
                onClick={() => setFilesCollapsed(true)}
                className="px-1 text-slate-500 hover:text-primary"
              >
                <span className="material-symbols-outlined text-sm">chevron_left</span>
              </button>
            </div>
            {/* Panel content */}
            <div
              data-testid="focus-zone-file-list"
              className={`flex-1 overflow-hidden ${focusZone === 'file-list' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
            >
              {filePanelMode === 'touched' ? (
                <TouchedFilesPanel files={run.touchedFiles} onOpenFile={handleOpenFile} />
              ) : (
                <FileTreePanel sessionId={run.sessionId} onOpenFile={handleOpenFile} />
              )}
            </div>
            {/* Resize handle */}
            <div
              className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-10"
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
            termTick={termTick}
            terminalFocused={terminalFocused}
            onTerminalToggle={() => setTerminalFocused(f => !f)}
          />
        </div>
        {procsCollapsed ? (
          <div
            data-testid="collapsed-procedures"
            className={`w-6 flex flex-col items-center justify-center bg-surface-panel cursor-pointer hover:bg-surface-hover ${focusZone === 'right-panel' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}`}
            onClick={() => setProcsCollapsed(false)}
          >
            <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr]">Procs</span>
          </div>
        ) : (
          <div
            data-testid="focus-zone-right-panel"
            className={focusZone === 'right-panel' ? 'ring-2 ring-inset ring-indigo-500 rounded' : ''}
          >
            <ProceduresPanel
              taskId={run.taskId}
              sessionId={run.sessionId}
              sessionStatus={run.status}
              onCollapse={() => setProcsCollapsed(true)}
            />
          </div>
        )}
      </div>

    </div>
  )
}
