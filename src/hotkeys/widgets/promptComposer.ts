import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'prompt-composer',
  displayName: 'Composer',
  contexts: [],
  bindings: [
    { key: 'Ctrl+Enter', label: 'Send prompt',        action: 'composer-send' },
    { key: 'PageUp',     label: 'Scroll terminal up',   action: 'composer-scroll-up' },
    { key: 'PageDown',   label: 'Scroll terminal down', action: 'composer-scroll-down' },
    { key: 'Escape',     label: 'Send Escape to terminal', action: 'composer-escape' },
    { key: 'ArrowUp',    label: 'History (when empty)', action: 'composer-history' },
  ],
})
