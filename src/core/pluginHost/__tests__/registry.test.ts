import { describe, it, expect, vi } from 'vitest'
import type { Plugin, TinstarPluginAPI, Disposable, PluginManifest } from '@tinstar/plugin-api'
import { PluginRegistry, type PluginRecord } from '../registry'

function makeRecord(name = 'test'): PluginRecord {
  return {
    name,
    version: '0.0.1',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

function makeApi(rec: PluginRecord): TinstarPluginAPI {
  return {
    pluginId: rec.name,
    version: rec.version,
    widgets: { register: () => ({ dispose: () => {} }) },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }
}

describe('PluginRegistry', () => {
  it('activates a plugin, calling activate(api) and storing returned disposables', async () => {
    const reg = new PluginRegistry()
    const dispose = vi.fn()
    const plugin: Plugin = {
      activate: () => [{ dispose }],
    }
    const record = makeRecord('alpha')

    await reg.activate(record, plugin, makeApi)

    const stored = reg.get('alpha')
    expect(stored?.state).toBe('active')
    expect(stored?.disposables.length).toBe(1)
    expect(dispose).not.toHaveBeenCalled()
  })

  it('treats a void activate() return as zero disposables', async () => {
    const reg = new PluginRegistry()
    const plugin: Plugin = { activate: () => undefined }
    const record = makeRecord('beta')

    await reg.activate(record, plugin, makeApi)

    expect(reg.get('beta')?.state).toBe('active')
    expect(reg.get('beta')?.disposables).toEqual([])
  })

  it('marks a plugin failed and disposes partial registrations if activate throws', async () => {
    const reg = new PluginRegistry()
    const dispose = vi.fn()
    const plugin: Plugin = {
      activate: (api) => {
        // Register one widget, then throw. The partial registration should be disposed.
        api.widgets.register({ type: 't', component: () => null, isContainer: false, minSize: { width: 0, height: 0 } })
        throw new Error('boom')
      },
    }
    const record = makeRecord('gamma')

    // Stub API that mirrors what the real createPluginApi does: push the
    // returned disposable onto record.disposables so the registry can clean
    // up after a thrown activate().
    const trackingApi = (rec: PluginRecord): TinstarPluginAPI => ({
      pluginId: rec.name,
      version: rec.version,
      widgets: {
        register: () => {
          const d: Disposable = { dispose }
          rec.disposables.push(d)
          return d
        },
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    })

    await reg.activate(record, plugin, trackingApi)

    const stored = reg.get('gamma')
    expect(stored?.state).toBe('failed')
    expect(stored?.error).toContain('boom')
    expect(stored?.errorStack).toBeDefined()
    expect(dispose).toHaveBeenCalledTimes(1)  // partial registration was disposed
    expect(stored?.disposables).toEqual([])    // and cleared from the record
  })

  it('deactivate() disposes everything and resets state to pending', async () => {
    const reg = new PluginRegistry()
    const dispose = vi.fn()
    const plugin: Plugin = { activate: () => [{ dispose }, { dispose }] }
    const record = makeRecord('delta')

    await reg.activate(record, plugin, makeApi)
    reg.deactivate('delta')

    expect(dispose).toHaveBeenCalledTimes(2)
    expect(reg.get('delta')?.state).toBe('pending')
    expect(reg.get('delta')?.disposables).toEqual([])
  })

  it('refuses to re-activate an already-active plugin (no silent clobber)', async () => {
    const reg = new PluginRegistry()
    const dispose = vi.fn()
    const plugin = { activate: () => [{ dispose }] }
    const record = makeRecord('reentry')

    await reg.activate(record, plugin, makeApi)
    expect(reg.get('reentry')?.state).toBe('active')

    // Second activate on the same name must throw without touching existing disposables.
    await expect(reg.activate(record, plugin, makeApi)).rejects.toThrow(/already-active/)
    expect(dispose).not.toHaveBeenCalled()  // first registration NOT clobbered
  })

  it('list() returns all known plugin records', async () => {
    const reg = new PluginRegistry()
    await reg.activate(makeRecord('a'), { activate: () => [] }, makeApi)
    await reg.activate(makeRecord('b'), { activate: () => [] }, makeApi)
    expect(reg.list().map(r => r.name).sort()).toEqual(['a', 'b'])
  })

  it('awaits an async activate before marking active', async () => {
    const reg = new PluginRegistry()
    let resolved = false
    const plugin: Plugin = {
      activate: async () => {
        await new Promise(r => setTimeout(r, 5))
        resolved = true
        return []
      },
    }
    const record = makeRecord('asyncOk')
    await reg.activate(record, plugin, makeApi)
    expect(resolved).toBe(true)
    expect(reg.get('asyncOk')?.state).toBe('active')
  })

  it('catches an async activate rejection and marks failed', async () => {
    const reg = new PluginRegistry()
    const plugin: Plugin = {
      activate: async () => { throw new Error('async-boom') },
    }
    const record = makeRecord('asyncFail')
    await reg.activate(record, plugin, makeApi)
    expect(reg.get('asyncFail')?.state).toBe('failed')
    expect(reg.get('asyncFail')?.error).toContain('async-boom')
    expect(reg.get('asyncFail')?.errorStack).toBeDefined()
  })
})
