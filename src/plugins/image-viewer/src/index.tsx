import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { ImageViewerWidget } from './ImageViewerWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('image-viewer plugin activating')
  return [
    api.widgets.register({
      type: 'image-viewer',
      component: ImageViewerWidget,
      isContainer: false,
      defaultSize: { width: 640, height: 480 },
      minSize: { width: 200, height: 150 },
      dragHandleSelector: '.widget-drag-handle',
      getFrameClass: ({ isSelected, isDragging }) => {
        if (isDragging) return 'widget-run-dragging'
        if (isSelected) return 'widget-run-selected'
        return ''
      },
    }),
  ]
}
