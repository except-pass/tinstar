import { registerWidgetComponent } from '../widgetComponentRegistry'
import { NatsTrafficWidget } from './NatsTrafficWidget'

registerWidgetComponent({
  type: 'nats-traffic',
  component: NatsTrafficWidget,
  isContainer: false,
  defaultSize: { width: 800, height: 400 },
  minSize: { width: 400, height: 200 },
  dragHandleSelector: '.widget-drag-handle',
})
