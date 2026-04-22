// src/hotkeys/widgets/imageViewerWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'image-viewer',
  displayName: 'Image',
  contexts: [],
  bindings: [
    { key: 'KeyZ', label: 'Fit to viewport', action: 'fit-viewport' },
  ],
})
