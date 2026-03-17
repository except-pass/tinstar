import { registerWidgetComponent } from '../widgetComponentRegistry'
import { FileEditorWidget } from './FileEditorWidget'

registerWidgetComponent({
  type: 'file-editor',
  component: FileEditorWidget,
  isContainer: false,
  defaultSize: { width: 640, height: 480 },
  minSize: { width: 300, height: 200 },
  dragHandleSelector: '.widget-drag-handle',
  supportsMinimize: false,
})
