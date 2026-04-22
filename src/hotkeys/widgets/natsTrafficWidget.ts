// src/hotkeys/widgets/natsTrafficWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'nats-traffic',
  displayName: 'NATS Traffic',
  contexts: [],
  bindings: [
    { key: 'KeyZ', label: 'Fit to viewport', action: 'fit-viewport' },
  ],
})
