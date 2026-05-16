import { useEffect, useState } from 'react'
import { pluginRegistry } from '../../widgets'
import { fetchPluginsConfig, savePluginsConfig } from '../../core/pluginApi/pluginsConfigClient'
import type { PluginRecord } from '../../core/pluginHost/registry'
import type { PluginsConfig } from '../../core/pluginHost/pluginsConfig'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; config: PluginsConfig }
  | { kind: 'error'; error: string }

export function PluginsTab() {
  const [records, setRecords] = useState<PluginRecord[]>(() => pluginRegistry.list())
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    fetchPluginsConfig().then(r => {
      if (!mounted) return
      if (r.ok) setLoadState({ kind: 'loaded', config: r.config })
      else setLoadState({ kind: 'error', error: r.error })
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setRecords(pluginRegistry.list()), 500)
    return () => clearInterval(id)
  }, [])

  const toggle = async (name: string) => {
    if (loadState.kind !== 'loaded') return  // refuse to save before we know the baseline
    const isDisabled = loadState.config.disabled.includes(name)
    const nextDisabled = isDisabled
      ? loadState.config.disabled.filter(n => n !== name)
      : [...loadState.config.disabled, name]
    const next = { ...loadState.config, disabled: nextDisabled }
    setSaving(true)
    setSaveError(null)
    try {
      await savePluginsConfig(next)
      setLoadState({ kind: 'loaded', config: next })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSaveError(`Couldn't save: ${msg}. Changes were not applied.`)
      // eslint-disable-next-line no-console
      console.error('[plugins-tab] save failed', e)
    } finally {
      setSaving(false)
    }
  }

  if (loadState.kind === 'loading') {
    return <div className="plugins-tab" data-testid="plugins-tab"><p className="text-xs text-slate-500">Loading plugin config…</p></div>
  }
  if (loadState.kind === 'error') {
    return (
      <div className="plugins-tab" data-testid="plugins-tab">
        <p className="text-xs text-red-400" data-testid="plugins-tab-error">
          Couldn't load plugin config: {loadState.error}. Toggles are disabled to avoid overwriting your settings. Reopen Settings to retry.
        </p>
      </div>
    )
  }

  const config = loadState.config

  return (
    <div className="plugins-tab" data-testid="plugins-tab">
      <p className="text-xs text-slate-500 mb-3">
        Disabled plugins skip activation on next app reload.
        {saving && <span className="ml-2 text-amber-400">Saving…</span>}
        {saveError && <span className="ml-2 text-red-400" data-testid="save-error">{saveError}</span>}
      </p>
      <ul className="space-y-2">
        {records.map(rec => {
          const isDisabled = config.disabled.includes(rec.name)
          return (
            <li key={rec.name} className="flex items-center justify-between p-2 rounded border border-white/10" data-testid={`plugin-row-${rec.name}`}>
              <div className="flex-1">
                <div className="font-mono text-sm">
                  {rec.name} <span className="text-slate-500">v{rec.version}</span>
                </div>
                <div className="text-xs text-slate-500">{rec.manifest.displayName}</div>
                {rec.state === 'failed' && (
                  <div className="text-xs text-red-400 mt-1" data-testid={`plugin-error-${rec.name}`}>
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
        {records.length === 0 && <li className="text-sm text-slate-500">No plugins loaded yet.</li>}
      </ul>
    </div>
  )
}
