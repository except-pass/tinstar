import { registerWidgetComponent, type WidgetProps } from '../widgetComponentRegistry'
import { RunWorkspaceWidget } from '../../components/RunWorkspaceWidget'
import type { RunData } from '../../types'

function RunWorkspaceAdapter({ data, zoom, isSelected, isDragging }: WidgetProps) {
  const run = data as RunData
  return <RunWorkspaceWidget run={run} className="w-full h-full" zoom={zoom} isSelected={isSelected} isDragging={isDragging} />
}

/** Default canvas width for a run workspace. Exported so the canvas's arrange
 *  fallback can't drift from the registration. */
export const RUN_WORKSPACE_DEFAULT_WIDTH = 2400

registerWidgetComponent({
  type: 'run-workspace',
  component: RunWorkspaceAdapter,
  isContainer: false,
  // The Slate added a third column (files · terminal/recap · telemetry · Slate),
  // so the old 1560 default left every panel cramped. A run workspace is the
  // primary surface — default it wide enough to essentially fill the viewport.
  // Existing cards keep their saved size (the layout hook prefers `prev`), so
  // this only affects newly-laid-out runs.
  defaultSize: { width: RUN_WORKSPACE_DEFAULT_WIDTH, height: 1230 },
  minSize: { width: 300, height: 150 },
  dragHandleSelector: '.widget-drag-handle',
  getFrameClass: ({ isDragging, isSelected }) => {
    if (isDragging) return 'widget-run-dragging'
    if (isSelected) return 'widget-run-selected'
    return ''
  },
  supportsMinimize: true,
  capabilities: ['spawnable', 'session-host'],
  creator: 'session-backed',
})
