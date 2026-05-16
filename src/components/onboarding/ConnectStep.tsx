import { useState } from 'react'
import { desktopApi } from '../../desktop/desktopApi'

export function ConnectStep() {
  const [url, setUrl] = useState('http://localhost:5273')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSave = async () => {
    setError(null)
    setBusy(true)
    try {
      const ok = desktopApi.probeBackend
        ? await desktopApi.probeBackend(url)
        : await fetch(`${url.replace(/\/$/, '')}/api/state`).then(r => r.ok).catch(() => false)
      if (!ok) {
        setError(`Backend at ${url} is unreachable. Check the URL or start a tinstar instance.`)
        return
      }
      if (desktopApi.saveConfig) {
        await desktopApi.saveConfig({ backend: { mode: 'remote', url } })
      }
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  const onStartLocal = async () => {
    if (!desktopApi.startLocalBackend) return
    setBusy(true)
    setError(null)
    try {
      const pid = await desktopApi.startLocalBackend()
      const localUrl = 'http://localhost:5273'
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250))
        const ok = desktopApi.probeBackend ? await desktopApi.probeBackend(localUrl) : false
        if (ok) {
          await desktopApi.saveConfig?.({ backend: { mode: 'local-managed', url: localUrl, managePid: pid } })
          window.location.reload()
          return
        }
      }
      setError('Started a local backend but it did not become reachable in time.')
    } catch (e) {
      setError(`Failed to start local backend: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-slate-400 text-sm">Tinstar's frontend connects to a backend over HTTP. Paste the URL of a running backend, or have me start one for you.</p>
      <div className="flex gap-2">
        <input
          data-testid="connect-url-input"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="http://localhost:5273"
          className="flex-1 bg-surface-base border border-white/10 rounded px-2 py-1 font-mono text-sm"
        />
        <button
          data-testid="connect-save"
          onClick={onSave}
          disabled={busy}
          className="px-3 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-sm"
        >
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
      {desktopApi.startLocalBackend && (
        <button
          data-testid="connect-start-local"
          onClick={onStartLocal}
          disabled={busy}
          className="text-xs text-slate-400 underline"
        >
          Or start a local backend for me
        </button>
      )}
      {error && <div data-testid="connect-error" className="text-red-400 text-sm">{error}</div>}
    </div>
  )
}
