import { useEffect, useState } from 'react'
import { pluginRegistry } from '../../widgets'
import { fetchPluginsConfig, savePluginsConfig } from '../../core/pluginApi/pluginsConfigClient'
import type { PluginRecord } from '../../core/pluginHost/registry'
import type { PluginsConfig } from '../../core/pluginHost/pluginsConfig'

export function PluginsTab() {
  const [records, setRecords] = useState<PluginRecord[]>(() => pluginRegistry.list())
  const [config, setConfig] = useState<PluginsConfig>({ disabled: [], external: [] })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let mounted = true
    fetchPluginsConfig().then(c => { if (mounted) setConfig(c) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setRecords(pluginRegistry.list()), 500)
    return () => clearInterval(id)
  }, [])

  const toggle = async (name: string) => {
    const isDisabled = config.disabled.includes(name)
    const nextDisabled = isDisabled
      ? config.disabled.filter(n => n !== name)
      : [...config.disabled, name]
    const next = { ...config, disabled: nextDisabled }
    setSaving(true)
    try {
      await savePluginsConfig(next)
      setConfig(next)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="plugins-tab" data-testid="plugins-tab">
      <p className="text-xs text-slate-500 mb-3">
        Disabled plugins skip activation on next app reload.
        {saving && <span className="ml-2 text-amber-400">Saving…</span>}
      </p>
      <ul className="space-y-2">
        {records.map(rec => {
          const isDisabled = config.disabled.includes(rec.name)
          return (
            <li
              key={rec.name}
              className="flex items-center justify-between p-2 rounded border border-white/10"
              data-testid={`plugin-row-${rec.name}`}
            >
              <div className="flex-1">
                <div className="font-mono text-sm">
                  {rec.name} <span className="text-slate-500">v{rec.version}</span>
                </div>
                <div className="text-xs text-slate-500">{rec.manifest.displayName}</div>
                {rec.state === 'failed' && (
                  <div
                    className="text-xs text-red-400 mt-1"
                    data-testid={`plugin-error-${rec.name}`}
                  >
                    failed: {rec.error}
                  </div>
                )}
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  data-testid={`plugin-toggle-${rec.name}`}
                  checked={!isDisabled}
                  onChange={() => toggle(rec.name)}
                  disabled={saving}
                  className="mr-2"
                />
                <span className="text-xs text-slate-400">{isDisabled ? 'off' : 'on'}</span>
              </label>
            </li>
          )
        })}
        {records.length === 0 && (
          <li className="text-sm text-slate-500">No plugins loaded yet.</li>
        )}
      </ul>
    </div>
  )
}
