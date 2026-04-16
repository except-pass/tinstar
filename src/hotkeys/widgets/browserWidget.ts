// src/hotkeys/widgets/browserWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'browser-widget',
  displayName: 'Browser',
  contexts: [],
  bindings: [
    { key: 'KeyZ', label: 'Fit to viewport', action: 'fit-viewport' },
  ],
})
