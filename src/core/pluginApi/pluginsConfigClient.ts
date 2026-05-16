import { apiFetch } from '../../apiClient'
import type { PluginsConfig } from '../pluginHost/pluginsConfig'

export type FetchConfigResult =
  | { ok: true; config: PluginsConfig }
  | { ok: false; error: string }

export async function fetchPluginsConfig(): Promise<FetchConfigResult> {
  try {
    const res = await apiFetch('/api/plugins-config')
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json = await res.json()
    if (!json || typeof json !== 'object') {
      return { ok: false, error: 'malformed response body' }
    }
    // Normalize shape to be defensive — the server should already do this,
    // but if its response drifts we still hand callers a valid PluginsConfig.
    const obj = json as Record<string, unknown>
    const config: PluginsConfig = {
      disabled: Array.isArray(obj.disabled) ? obj.disabled.filter((x): x is string => typeof x === 'string') : [],
      external: Array.isArray(obj.external)
        ? obj.external.filter((e): e is { name: string; path?: string; npm?: string } => {
            if (!e || typeof e !== 'object') return false
            const r = e as Record<string, unknown>
            return typeof r.name === 'string' && r.name !== '' && (typeof r.path === 'string' || typeof r.npm === 'string')
          })
        : [],
    }
    return { ok: true, config }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function savePluginsConfig(config: PluginsConfig): Promise<void> {
  const res = await apiFetch('/api/plugins-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch { /* ignore */ }
    throw new Error(`saving plugins config failed: ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
}
