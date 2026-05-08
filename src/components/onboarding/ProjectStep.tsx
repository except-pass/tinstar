import { useState } from 'react'
import { apiUrl } from '../../apiClient'
import { desktopApi } from '../../desktop/desktopApi'

export function ProjectStep() {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const browse = desktopApi.openDirectoryDialog

  const onBrowse = async () => {
    if (!browse) return
    const picked = await browse()
    if (picked) {
      setPath(picked)
      if (!name) {
        const inferred = picked.split('/').filter(Boolean).pop() ?? ''
        setName(inferred)
      }
    }
  }

  const onRegister = async () => {
    if (!name.trim() || !path.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(apiUrl('/api/projects'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), path: path.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message || `register failed (${res.status})`)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-slate-400 text-sm">A project is a git repo tinstar can spawn sessions inside. Point at any local clone.</p>
      <div className="flex gap-2 flex-wrap">
        <input
          data-testid="project-name-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="name (e.g. myapp)"
          className="w-32 bg-surface-base border border-white/10 rounded px-2 py-1 font-mono text-sm"
        />
        <input
          data-testid="project-path-input"
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/path/to/repo"
          className="flex-1 bg-surface-base border border-white/10 rounded px-2 py-1 font-mono text-sm"
        />
        {browse && (
          <button
            data-testid="project-browse"
            onClick={onBrowse}
            className="px-2 py-1 border border-white/10 rounded text-sm"
          >
            Browse…
          </button>
        )}
        <button
          data-testid="project-register"
          onClick={onRegister}
          disabled={busy || !name.trim() || !path.trim()}
          className="px-3 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-sm disabled:opacity-50"
        >
          {busy ? 'Registering…' : 'Register'}
        </button>
      </div>
      {error && <div data-testid="project-error" className="text-red-400 text-sm">{error}</div>}
    </div>
  )
}
