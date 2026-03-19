import { registerWidgetComponent } from '../widgetComponentRegistry'
import { BrowserWidget } from './BrowserWidget'

registerWidgetComponent({
  type: 'browser-widget',
  component: BrowserWidget,
  isContainer: false,
  defaultSize: { width: 800, height: 600 },
  minSize: { width: 320, height: 240 },
  dragHandleSelector: '.widget-drag-handle',
  supportsMinimize: false,
})
