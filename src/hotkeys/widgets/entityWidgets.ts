// src/hotkeys/widgets/entityWidgets.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'task',
  displayName: 'Task',
  contexts: [],
  bindings: [
    { key: 'Enter', label: 'Settings', action: 'settings' },
  ],
})

registerWidget({
  type: 'epic',
  displayName: 'Epic',
  contexts: [],
  bindings: [
    { key: 'Enter', label: 'Settings', action: 'settings' },
  ],
})

registerWidget({
  type: 'initiative',
  displayName: 'Initiative',
  contexts: [],
  bindings: [
    { key: 'Enter', label: 'Settings', action: 'settings' },
  ],
})
