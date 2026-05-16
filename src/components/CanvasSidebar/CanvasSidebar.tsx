import { useCallback, useEffect, useState } from 'react'
import type { Camera } from '../../hooks/useCanvasCamera'
import type { WidgetLayout } from '../../hooks/useWidgetLayouts'
import type { TreeNode, Run, BrowserWidget, EditorWidget, ImageWidget, NatsTrafficWidget } from '../../domain/types'
import { CanvasHud } from '../CanvasHud/CanvasHud'
import { CanvasMinimap } from '../CanvasMinimap'
import { MarshalTerminal } from './MarshalTerminal'

const STORAGE_KEY = 'tinstar-canvas-sidebar-collapsed'
const SIDEBAR_WIDTH = 320

interface Props {
  camera: Camera
  setCamera: React.Dispatch<React.SetStateAction<Camera>>
  layouts: Map<string, WidgetLayout>
  tree: TreeNode[]
  runMap: Map<string, Run>
  editorWidgetMap: Map<string, EditorWidget>
  browserWidgetMap: Map<string, BrowserWidget>
  imageWidgetMap: Map<string, ImageWidget>
  natsTrafficWidgetMap: Map<string, NatsTrafficWidget>
  onFocusRun?: (runId: string) => void
  selectedRunIds?: Set<string>
  /** Toggle refs forwarded for keyboard hotkeys (T = telemetry, M = minimap) */
  hudToggleRef?: React.MutableRefObject<(() => void) | null>
  minimapToggleRef?: React.MutableRefObject<(() => void) | null>
  /** When true, ignore the localStorage-collapsed preference and render expanded.
   * The user's preference is preserved (not mutated) so it returns to its
   * previous state once forceExpanded becomes false. */
  forceExpanded?: boolean
}

/** Right-side canvas sidebar: telemetry HUD on top, marshal terminal in the
 * middle, minimap on the bottom. Collapses to a thin button. */
export function CanvasSidebar(props: Props) {
  const [storedCollapsed, setStoredCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')
  const collapsed = props.forceExpanded ? false : storedCollapsed

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(storedCollapsed))
  }, [storedCollapsed])

  const toggle = useCallback(() => setStoredCollapsed(c => !c), [])

  if (collapsed) {
    return (
      <button
        onClick={toggle}
        className="absolute top-3 right-3 bg-surface-panel border border-white/10 p-1.5 rounded-sm text-slate-500 hover:text-slate-300 transition-colors select-none z-30"
        title="Show canvas sidebar"
        data-testid="canvas-sidebar-toggle"
      >
        <span className="material-symbols-outlined text-base" style={{ fontSize: '16px' }}>dock_to_left</span>
      </button>
    )
  }

  return (
    <div
      className="absolute top-0 right-0 h-full flex flex-col bg-surface-panel/95 border-l border-white/10 z-20 select-none"
      style={{ width: SIDEBAR_WIDTH }}
      data-testid="canvas-sidebar"
      onPointerDown={(e) => e.stopPropagation()}
      onWheelCapture={(e) => e.stopPropagation()}
    >
      {/* Header — collapse handle */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-white/10 text-2xs font-mono uppercase tracking-wider text-slate-500">
        <span>Canvas</span>
        {!props.forceExpanded && (
          <button
            onClick={toggle}
            className="text-slate-500 hover:text-slate-300"
            title="Collapse sidebar"
            data-testid="canvas-sidebar-collapse"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>dock_to_right</span>
          </button>
        )}
      </div>

      {/* Telemetry HUD — top */}
      <div className="shrink-0 max-h-[55%] overflow-y-auto scrollbar-thin">
        <CanvasHud
          embedded
          runMap={props.runMap}
          onFocusRun={props.onFocusRun}
          selectedRunIds={props.selectedRunIds}
          toggleRef={props.hudToggleRef}
        />
      </div>

      {/* Marshal terminal — middle (takes the remaining height) */}
      <MarshalTerminal />

      {/* Minimap — bottom */}
      <div className="shrink-0">
        <CanvasMinimap
          embedded
          camera={props.camera}
          setCamera={props.setCamera}
          layouts={props.layouts}
          tree={props.tree}
          runMap={props.runMap}
          editorWidgetMap={props.editorWidgetMap}
          browserWidgetMap={props.browserWidgetMap}
          imageWidgetMap={props.imageWidgetMap}
          natsTrafficWidgetMap={props.natsTrafficWidgetMap}
          toggleRef={props.minimapToggleRef}
        />
      </div>
    </div>
  )
}
