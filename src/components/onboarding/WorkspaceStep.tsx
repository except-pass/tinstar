import { useState } from 'react'
import { apiUrl } from '../../apiClient'

export function WorkspaceStep() {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onCreate = async () => {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(apiUrl('/api/spaces'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message || `create failed (${res.status})`)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-slate-400 text-sm">Workspaces are the top-level containers for your tasks, sessions, and worktrees.</p>
      <div className="flex gap-2">
        <input
          data-testid="workspace-name-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. V4.1 Onboarding"
          className="flex-1 bg-surface-base border border-white/10 rounded px-2 py-1 font-mono text-sm"
        />
        <button
          data-testid="workspace-create"
          onClick={onCreate}
          disabled={busy || !name.trim()}
          className="px-3 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-sm disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      {error && <div data-testid="workspace-error" className="text-red-400 text-sm">{error}</div>}
    </div>
  )
}
