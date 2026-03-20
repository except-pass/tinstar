// src/hotkeys/widgets/entityWidgets.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'file-editor',
  displayName: 'File',
  contexts: [],
  bindings: [
    { key: 'KeyE', label: 'Open in editor', action: 'open-in-editor' },
    { key: 'KeyW', label: 'Toggle word wrap', action: 'toggle-word-wrap' },
  ],
})


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
