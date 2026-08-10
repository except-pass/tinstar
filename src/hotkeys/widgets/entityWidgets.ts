// src/hotkeys/widgets/entityWidgets.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'file-editor',
  displayName: 'File',
  contexts: [],
  bindings: [
    { key: 'KeyE', label: 'Open in editor', action: 'open-in-editor' },
    { key: 'KeyW', label: 'Toggle word wrap', action: 'toggle-word-wrap' },
    { key: 'KeyZ', label: 'Fit to viewport', action: 'fit-viewport' },
  ],
})
