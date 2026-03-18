// src/hotkeys/widgets/runTerminalWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'run-terminal',
  displayName: 'Terminal',
  contexts: [],
  bindings: [
    { key: 'Ctrl+Shift+Backslash', label: 'Exit terminal', action: 'terminal-exit' },
  ],
})
