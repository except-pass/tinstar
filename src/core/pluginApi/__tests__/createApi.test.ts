import { describe, it, expect, vi } from 'vitest'
import type { PluginRecord } from '../../pluginHost/registry'
import type { PluginManifest } from '@tinstar/plugin-api'
import { createPluginApi } from '../createApi'
import { getWidgetComponent } from '../../../widgets/widgetComponentRegistry'

function makeRecord(name = 'browser'): PluginRecord {
  return {
    name,
    version: '0.0.1',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

const FakeWidget = () => null

describe('createPluginApi', () => {
  // Tests use unique widget type names per case to avoid cross-test pollution
  // of the module-level widget registry (no global reset hook exists yet).

  it('exposes pluginId and version from the record', () => {
    const rec = makeRecord('alpha')
    rec.version = '1.2.3'
    const api = createPluginApi(rec)
    expect(api.pluginId).toBe('alpha')
    expect(api.version).toBe('1.2.3')
  })

  it('widgets.register makes the widget findable via getWidgetComponent', () => {
    const rec = makeRecord('beta')
    const api = createPluginApi(rec)
    api.widgets.register({
      type: 'beta-widget',
      component: FakeWidget,
      isContainer: false,
      minSize: { width: 100, height: 100 },
    })
    expect(getWidgetComponent('beta-widget')?.component).toBe(FakeWidget)
  })

  it('widgets.register tracks the disposable on the plugin record', () => {
    const rec = makeRecord('gamma')
    const api = createPluginApi(rec)
    api.widgets.register({
      type: 'gamma-widget',
      component: FakeWidget,
      isContainer: false,
      minSize: { width: 100, height: 100 },
    })
    expect(rec.disposables.length).toBe(1)
  })

  it('disposing a registration removes the widget from the central registry', () => {
    const rec = makeRecord('delta')
    const api = createPluginApi(rec)
    const d = api.widgets.register({
      type: 'delta-widget',
      component: FakeWidget,
      isContainer: false,
      minSize: { width: 100, height: 100 },
    })
    expect(getWidgetComponent('delta-widget')).toBeDefined()
    d.dispose()
    expect(getWidgetComponent('delta-widget')).toBeUndefined()
  })

  it('logger prefixes messages with [pluginId]', () => {
    const rec = makeRecord('epsilon')
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const api = createPluginApi(rec)
    api.logger.info('hello', { n: 1 })
    expect(spy).toHaveBeenCalledWith('[epsilon]', 'hello', { n: 1 })
    spy.mockRestore()
  })

  it('duplicate widget type: throws once, returns no-op disposable, logs warn', () => {
    const recA = makeRecord('zeta-a')
    const apiA = createPluginApi(recA)
    apiA.widgets.register({
      type: 'zeta-shared',
      component: FakeWidget,
      isContainer: false,
      minSize: { width: 100, height: 100 },
    })

    const recB = makeRecord('zeta-b')
    const apiB = createPluginApi(recB)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const d = apiB.widgets.register({
      type: 'zeta-shared',
      component: FakeWidget,
      isContainer: false,
      minSize: { width: 100, height: 100 },
    })
    expect(warn).toHaveBeenCalled()
    const firstCall = warn.mock.calls[0]
    expect(firstCall.join(' ')).toContain('zeta-shared')
    expect(recB.disposables.length).toBe(0)
    d.dispose()  // should be safe no-op
    expect(getWidgetComponent('zeta-shared')).toBeDefined()  // original still there
    warn.mockRestore()
  })
})
