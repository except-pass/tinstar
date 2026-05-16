import type { Plugin, TinstarPluginAPI, Disposable, PluginManifest } from '@tinstar/plugin-api'

export type PluginState = 'pending' | 'active' | 'failed'

export interface PluginRecord {
  name: string
  version: string
  manifest: PluginManifest
  state: PluginState
  error?: string
  /** Disposables returned from activate(), plus anything tracked during activate(). */
  disposables: Disposable[]
}

export type CreateApiFn = (rec: PluginRecord) => TinstarPluginAPI

export class PluginRegistry {
  private plugins = new Map<string, PluginRecord>()

  list(): PluginRecord[] {
    return [...this.plugins.values()]
  }

  get(name: string): PluginRecord | undefined {
    return this.plugins.get(name)
  }

  async activate(record: PluginRecord, plugin: Plugin, createApi: CreateApiFn): Promise<void> {
    record.disposables = []
    this.plugins.set(record.name, record)

    try {
      const api = createApi(record)
      const result = plugin.activate(api)
      // activate() may also return additional disposables on top of whatever
      // the API tracked internally. We treat the union as the plugin's full
      // disposable set.
      if (Array.isArray(result)) {
        record.disposables = [...record.disposables, ...result]
      }
      record.state = 'active'
    } catch (e) {
      record.state = 'failed'
      record.error = e instanceof Error ? e.message : String(e)
      this.disposeAll(record)
    }
  }

  deactivate(name: string): void {
    const rec = this.plugins.get(name)
    if (!rec) return
    this.disposeAll(rec)
    rec.state = 'pending'
  }

  private disposeAll(rec: PluginRecord): void {
    for (const d of rec.disposables) {
      try { d.dispose() } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[plugin-host] dispose() threw for ${rec.name}`, e)
      }
    }
    rec.disposables = []
  }
}
