import { apiFetch } from '../../apiClient'
import type { PluginsConfig } from '../pluginHost/pluginsConfig'

const EMPTY: PluginsConfig = { disabled: [], external: [] }

export async function fetchPluginsConfig(): Promise<PluginsConfig> {
  try {
    const res = await apiFetch('/api/plugins-config')
    if (!res.ok) return EMPTY
    const json = await res.json()
    return json as PluginsConfig
  } catch {
    return EMPTY
  }
}

export async function savePluginsConfig(config: PluginsConfig): Promise<void> {
  const res = await apiFetch('/api/plugins-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error(`saving plugins config failed: ${res.status}`)
}
