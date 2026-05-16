import { describe, it, expect } from 'vitest'
import type { Plugin } from '@tinstar/plugin-api'
import { bootBundledPlugins } from '../loader'
import { PluginRegistry } from '../registry'
import { getWidgetComponent } from '../../../widgets/widgetComponentRegistry'

describe('full bundled pipeline', () => {
  it('registers a widget end-to-end so getWidgetComponent finds it', async () => {
    const FakeWidget = () => null
    const plugin: Plugin = {
      activate(api) {
        return [api.widgets.register({
          type: 'integration-widget',
          component: FakeWidget,
          isContainer: false,
          minSize: { width: 100, height: 100 },
        })]
      },
    }
    const bundle = {
      integration: {
        pkg: {
          name: 'integration',
          version: '0.0.1',
          tinstar: { apiVersion: '5', displayName: 'I' },
        },
        module: plugin,
      },
    }
    const registry = new PluginRegistry()
    await bootBundledPlugins(bundle, registry)

    expect(registry.get('integration')?.state).toBe('active')
    expect(getWidgetComponent('integration-widget')?.component).toBe(FakeWidget)
  })
})
