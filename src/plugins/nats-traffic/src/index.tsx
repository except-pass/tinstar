// Built-in plugin — consumes @tinstar/plugin-api only.
// Host imports are forbidden by ESLint (see docs/adrs/0002-plugin-api-boundary.md).
import type { ComponentType } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeSaloonWidget } from './Saloon'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('saloon plugin activating')
  const component = makeSaloonWidget(api) as ComponentType<WidgetProps>
  const registration = {
    component,
    isContainer: false,
    defaultSize: { width: 1200, height: 600 },
    minSize: { width: 400, height: 200 },
    dragHandleSelector: '.widget-drag-handle',
  }
  return [
    api.widgets.register({ type: 'saloon', ...registration }),
    // Backward-compat alias: this widget shipped as `nats-traffic` in v5.0 and
    // was renamed to `saloon` in v5.1. Persisted plugin-widget instances store
    // their `widgetType`, so without this alias any `nats-traffic` instance a
    // user created on 5.0 would resolve to the host's unknown-type placeholder.
    // No `spawnable` capability → the alias resolves old instances but never
    // appears in the add-widget palette.
    api.widgets.register({ type: 'nats-traffic', ...registration }),
  ]
}
