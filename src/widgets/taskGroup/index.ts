import { registerWidgetComponent } from '../widgetComponentRegistry'
import { TaskGroupWidget } from './TaskGroupWidget'

// All grouping dimension types use the same TaskGroupWidget.
// toWidgetType() returns the node type string unchanged for non-run types,
// so each dimension type must be registered explicitly.
for (const type of ['initiative', 'epic', 'task', 'worktree'] as const) {
  registerWidgetComponent({
    type,
    component: TaskGroupWidget,
    isContainer: true,
    // No defaultSize — containers are sized by the layout algorithm
    minSize: { width: 200, height: 100 },
    dragHandleSelector: '.widget-drag-handle',
    // Drop-target visual state is handled inline in TaskGroupWidget via isDropTarget prop
    supportsMinimize: false,
  })
}
