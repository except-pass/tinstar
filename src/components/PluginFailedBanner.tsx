import { useEffect, useState } from 'react'
import { pluginRegistry } from '../widgets'
import type { PluginRecord } from '../core/pluginHost/registry'

export function PluginFailedBanner() {
  const [failed, setFailed] = useState<PluginRecord[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    const id = setInterval(() => {
      setFailed(pluginRegistry.list().filter(r => r.state === 'failed'))
    }, 5000)
    return () => clearInterval(id)
  }, [])

  const visible = failed.filter(r => !dismissed.has(r.name))
  if (visible.length === 0) return null

  return (
    <div
      className="fixed top-2 right-2 z-50 max-w-md space-y-1"
      data-testid="plugin-failed-banner"
    >
      {visible.map(rec => (
        <div
          key={rec.name}
          className="bg-red-950/90 border border-red-700/50 rounded p-3 text-xs"
          data-testid={`plugin-failed-${rec.name}`}
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="font-mono font-semibold text-red-300">
                Plugin failed: {rec.name}
              </div>
              <div className="text-red-200 mt-1">{rec.error}</div>
            </div>
            <button
              className="text-red-400 hover:text-red-200 ml-2"
              onClick={() => setDismissed(d => new Set(d).add(rec.name))}
              data-testid={`dismiss-${rec.name}`}
              aria-label="Dismiss"
            >×</button>
          </div>
        </div>
      ))}
    </div>
  )
}
