import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { FileEditorWidget } from './FileEditorWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('file-editor plugin activating')
  return [
    api.widgets.register({
      type: 'file-editor',
      component: FileEditorWidget,
      isContainer: false,
      defaultSize: { width: 640, height: 480 },
      minSize: { width: 300, height: 200 },
      dragHandleSelector: '.widget-drag-handle',
      supportsMinimize: false,
    }),
  ]
}
