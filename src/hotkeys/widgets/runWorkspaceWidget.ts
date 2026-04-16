// src/hotkeys/widgets/runWorkspaceWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'run-workspace',
  displayName: 'Agent Session',
  contexts: [
    { key: 'Ctrl+Backslash', type: 'run-terminal', label: 'Terminal' },
  ],
  bindings: [
    { key: 'Tab',        label: 'Next panel',        action: 'focus-next' },
    { key: 'Shift+Tab',  label: 'Prev panel',        action: 'focus-prev' },
    { key: 'ArrowDown',  label: 'Down in file list', action: 'file-down' },
    { key: 'ArrowUp',    label: 'Up in file list',   action: 'file-up' },
    { key: 'ArrowRight', label: 'Next tab',          action: 'tab-next' },
    { key: 'ArrowLeft',  label: 'Prev tab',          action: 'tab-prev' },
    { key: 'Enter',      label: 'Activate',          action: 'activate' },
    { key: 'KeyP',       label: 'Prompt composer',   action: 'toggle-prompt' },
    { key: 'KeyZ',       label: 'Fit to viewport',   action: 'fit-viewport' },
  ],
})
