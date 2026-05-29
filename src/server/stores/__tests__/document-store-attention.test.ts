// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../document-store'
import type { PluginWidgetInstance, AttentionState } from '../../../domain/types'

function makeInstance(store: DocumentStore): PluginWidgetInstance {
  return {
    id: 'pw-attn1',
    pluginId: 'fixture',
    widgetType: 'fixture-widget',
    spaceId: store.activeSpaceId || 'spc-default',
    position: { x: 0, y: 0 },
    size: { width: 320, height: 240 },
    data: null,
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
  }
}

describe('DocumentStore.setPluginWidgetAttention', () => {
  it('sets, replaces, and clears attention', () => {
    const store = new DocumentStore()
    const instance = makeInstance(store)
    store.upsertPluginWidget(instance.id, instance)

    store.setPluginWidgetAttention(instance.id, {
      level: 'urgent', reason: 'Build failed', setAt: '2026-05-27T00:01:00.000Z',
    })
    expect(store.getAllPluginWidgets()[0]?.attention?.reason).toBe('Build failed')

    store.setPluginWidgetAttention(instance.id, {
      level: 'info', reason: 'Build green', setAt: '2026-05-27T00:02:00.000Z',
    })
    expect(store.getAllPluginWidgets()[0]?.attention?.level).toBe('info')

    store.setPluginWidgetAttention(instance.id, null)
    expect(store.getAllPluginWidgets()[0]?.attention).toBeUndefined()
  })

  it('emits a pluginWidget change on attention set', () => {
    const store = new DocumentStore()
    const instance = makeInstance(store)
    store.upsertPluginWidget(instance.id, instance)
    const events: Array<{ entity: string; id: string; data: unknown }> = []
    store.changes.on('change', (e: any) => { if (e.entity === 'pluginWidget') events.push(e) })

    store.setPluginWidgetAttention(instance.id, {
      level: 'urgent', reason: 'r', setAt: '2026-05-27T00:01:00.000Z',
    })
    expect(events.some(e => e.id === instance.id)).toBe(true)
  })

  it('no-op when setting the same level+reason (does not bump setAt)', () => {
    const store = new DocumentStore()
    const instance = makeInstance(store)
    store.upsertPluginWidget(instance.id, instance)
    const a: AttentionState = { level: 'urgent', reason: 'r', setAt: '2026-05-27T00:01:00.000Z' }
    store.setPluginWidgetAttention(instance.id, a)
    const before = store.getAllPluginWidgets()[0]?.attention?.setAt
    store.setPluginWidgetAttention(instance.id, { ...a, setAt: '2026-05-27T00:02:00.000Z' })
    const after = store.getAllPluginWidgets()[0]?.attention?.setAt
    expect(after).toBe(before)
  })

  it('attention vanishes when the widget is deleted', () => {
    const store = new DocumentStore()
    const instance = makeInstance(store)
    store.upsertPluginWidget(instance.id, instance)
    store.setPluginWidgetAttention(instance.id, {
      level: 'urgent', reason: 'r', setAt: '2026-05-27T00:01:00.000Z',
    })
    store.deletePluginWidget(instance.id)
    expect(store.getAllPluginWidgets()).toHaveLength(0)
  })
})
