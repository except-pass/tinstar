import { registerWidgetComponent, type WidgetProps } from '../widgetComponentRegistry'
import { RunWorkspaceWidget } from '../../components/RunWorkspaceWidget'
import type { RunData } from '../../types'

function RunWorkspaceAdapter({ data, zoom, isSelected, isDragging }: WidgetProps) {
  const run = data as RunData
  return <RunWorkspaceWidget run={run} className="w-full h-full" zoom={zoom} isSelected={isSelected} isDragging={isDragging} />
}

registerWidgetComponent({
  type: 'run-workspace',
  component: RunWorkspaceAdapter,
  isContainer: false,
  defaultSize: { width: 1560, height: 1230 },
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
