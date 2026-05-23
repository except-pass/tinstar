import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeFileEditorWidget } from './FileEditorWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('file-editor plugin activating')
  return [
    api.widgets.register({
      type: 'file-editor',
      component: makeFileEditorWidget(api) as ComponentType<WidgetProps>,
      isContainer: false,
      defaultSize: { width: 640, height: 480 },
      minSize: { width: 300, height: 200 },
      dragHandleSelector: '.widget-drag-handle',
      supportsMinimize: false,
    }),
  ]
}
