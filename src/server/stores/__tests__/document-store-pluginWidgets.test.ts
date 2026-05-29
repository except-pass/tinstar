// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { DocumentStore } from '../document-store'
import type { PluginWidgetInstance } from '../../../domain/types'

describe('DocumentStore.pluginWidgets', () => {
  let store: DocumentStore
  beforeEach(() => { store = new DocumentStore() })

  it('upsert + getAll + delete round-trip', () => {
    const spaceId = store.activeSpaceId || 'spc-default'
    const instance: PluginWidgetInstance = {
      id: 'pw-test1',
      pluginId: 'fixture-plugin',
      widgetType: 'fixture-widget',
      spaceId,
      position: { x: 10, y: 20 },
      size: { width: 360, height: 280 },
      data: { hello: 'world' },
      createdAt: '2026-05-26T00:00:00.000Z',
      updatedAt: '2026-05-26T00:00:00.000Z',
    }
    store.upsertPluginWidget(instance.id, instance)
    expect(store.getAllPluginWidgets()).toEqual([instance])
    store.deletePluginWidget(instance.id)
    expect(store.getAllPluginWidgets()).toEqual([])
  })

  it('emits a "pluginWidget" change on upsert and delete', () => {
    const store2 = new DocumentStore()
    const events: Array<{ entity: string; id: string; data: unknown }> = []
    store2.changes.on('change', (e: any) => { if (e.entity === 'pluginWidget') events.push(e) })
    const spaceId = store2.activeSpaceId || 'spc-default'
    const instance: PluginWidgetInstance = {
      id: 'pw-test2',
      pluginId: 'p',
      widgetType: 'w',
      spaceId,
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: null,
      createdAt: 'x',
      updatedAt: 'x',
    }
    store2.upsertPluginWidget(instance.id, instance)
    store2.deletePluginWidget(instance.id)
    expect(events).toHaveLength(2)
    expect(events[0]?.data).toBeTruthy()
    expect(events[1]?.data).toBeNull()
  })
})
