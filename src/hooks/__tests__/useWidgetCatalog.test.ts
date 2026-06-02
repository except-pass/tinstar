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
    // Installed external plugin: palette-draggable, no capabilities → spawnable by default.
    { pluginId: 'stretchplan', widgetType: 'stretchplan-task', label: 'Stretchplan', spawn: 'palette' },
    // palette+context widget (e.g. file-editor) → excluded.
    { pluginId: 'fe', widgetType: 'file-editor', label: 'File editor', spawn: 'palette+context' },
    { pluginId: 'misc', widgetType: 'no-cap', label: 'NoCap' }, // no spawn, no capabilities → excluded
    // Session-backed plugin widget: palette-draggable but the [+] flow can't spawn it
    // (it would create a run-workspace instead) → excluded from the catalog.
    { pluginId: 'sb', widgetType: 'sb-widget', label: 'SessionBacked', spawn: 'palette', creator: 'session-backed' as const },
  ]

  it('includes spawnable widgets: capability-declared OR palette-installable', () => {
    const out = mergeCatalog(host as any, plugin as any)
    const types = out.map((e: CatalogEntry) => e.type).sort()
    expect(types).toEqual(['browser-widget', 'run-workspace', 'saloon', 'stretchplan-task'])
  })

  it('includes a palette plugin with no declared capabilities (stretchplan)', () => {
    const out = mergeCatalog(host as any, plugin as any)
    const sp = out.find(e => e.type === 'stretchplan-task')!
    expect(sp).toBeTruthy()
    expect(sp.pluginId).toBe('stretchplan')
    expect(sp.creator).toBe('standalone') // default
  })

  it('excludes session-backed plugin widgets (the [+] flow cannot spawn them)', () => {
    const out = mergeCatalog(host as any, plugin as any)
    expect(out.find(e => e.type === 'sb-widget')).toBeUndefined()
  })

  it('excludes palette+context plugin widgets', () => {
    const out = mergeCatalog(host as any, plugin as any)
    expect(out.find(e => e.type === 'file-editor')).toBeUndefined()
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
