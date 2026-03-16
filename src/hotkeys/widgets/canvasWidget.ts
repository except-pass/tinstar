// src/hotkeys/widgets/canvasWidget.ts
import { registerWidget } from '../widgetRegistry'

registerWidget({
  type: 'canvas',
  displayName: 'Canvas',
  contexts: [],  // Canvas-level navigation into widgets is handled by SelectionProvider/[ ] keys, not context push
  bindings: [],  // Canvas bindings are tier-1 reserved (handled by useGlobalHotkeys + useCanvasHotkeys)
})
