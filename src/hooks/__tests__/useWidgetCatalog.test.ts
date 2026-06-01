import { describe, it, expect } from 'vitest'
import { mergeCatalog, type CatalogEntry } from '../useWidgetCatalog'

describe('mergeCatalog', () => {
  const host = [
    { type: 'run-workspace', defaultSize: { width: 1320, height: 1230 },
      capabilities: ['spawnable', 'session-host'], creator: 'session-backed' as const },
    { type: 'task-group', isContainer: true, capabilities: undefined, creator: undefined },
  ]
  const plugin = [
    { pluginId: 'browser', widgetType: 'browser-widget', label: 'Browser',
      defaultSize: { width: 800, height: 600 }, capabilities: ['spawnable', 'web-view'],
      creator: 'standalone' as const, icon: '/x.svg' },
    { pluginId: 'nats-traffic', widgetType: 'saloon', label: 'Saloon',
      capabilities: ['spawnable'], creator: 'standalone' as const },
    { pluginId: 'misc', widgetType: 'no-cap', label: 'NoCap' }, // no capabilities → excluded
  ]

  it('includes only spawnable widgets from both registries', () => {
    const out = mergeCatalog(host as any, plugin as any)
    const types = out.map((e: CatalogEntry) => e.type).sort()
    expect(types).toEqual(['browser-widget', 'run-workspace', 'saloon'])
  })

  it('labels host widgets and carries creator/pluginId', () => {
    const out = mergeCatalog(host as any, plugin as any)
    const run = out.find(e => e.type === 'run-workspace')!
    expect(run.creator).toBe('session-backed')
    expect(run.pluginId).toBeUndefined()
    expect(run.label).toBe('Run workspace') // host label fallback map
    const br = out.find(e => e.type === 'browser-widget')!
    expect(br.creator).toBe('standalone')
    expect(br.pluginId).toBe('browser')
  })

  it('excludes container widgets even if mislabeled', () => {
    const out = mergeCatalog(host as any, plugin as any)
    expect(out.find(e => e.type === 'task-group')).toBeUndefined()
  })
})
