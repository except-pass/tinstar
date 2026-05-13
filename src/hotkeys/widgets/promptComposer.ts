import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'prompt-composer',
  displayName: 'Composer',
  contexts: [],
  bindings: [
    { key: 'Ctrl+Enter', label: 'Send prompt',          action: 'composer-send' },
    { key: 'PageUp',     label: 'Scroll terminal up',   action: 'composer-scroll-up' },
    { key: 'PageDown',   label: 'Scroll terminal down', action: 'composer-scroll-down' },
    { key: 'Escape',     label: 'Send Escape to terminal', action: 'composer-escape' },
    { key: 'ArrowUp',    label: 'History (when empty)', action: 'composer-history' },
    { key: 'Alt+Digit1', label: 'Send "1"', action: 'composer-send-digit-1' },
    { key: 'Alt+Digit2', label: 'Send "2"', action: 'composer-send-digit-2' },
    { key: 'Alt+Digit3', label: 'Send "3"', action: 'composer-send-digit-3' },
    { key: 'Alt+Digit4', label: 'Send "4"', action: 'composer-send-digit-4' },
    { key: 'Alt+Digit5', label: 'Send "5"', action: 'composer-send-digit-5' },
    { key: 'Alt+KeyY',   label: 'Send "y"', action: 'composer-send-y' },
    { key: 'Alt+KeyN',   label: 'Send "n"', action: 'composer-send-n' },
  ],
})
