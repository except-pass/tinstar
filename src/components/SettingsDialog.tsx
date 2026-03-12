import { useState, useRef, useEffect, useCallback } from 'react'

interface Project {
  name: string
  path: string
}

interface Props {
  onClose: () => void
}

export function SettingsDialog({ onClose }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const fetchProjects = useCallback(() => {
    fetch('/api/projects')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.ok && d.data && typeof d.data === 'object') {
          setProjects(
            Object.entries(d.data).map(([name, path]) => ({ name, path: path as string })),
          )
        } else {
          setProjects([])
        }
        setLoading(false)
      })
      .catch(() => {
        setProjects([])
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const handleAdd = useCallback(async () => {
    const trimName = newName.trim()
    const trimPath = newPath.trim()
    if (!trimName || !trimPath) return
    setError(null)

    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimName, path: trimPath }),
    })
    const data = await res.json()
    if (!data.ok) {
      setError(data.error?.message ?? 'Failed to add project')
      return
    }
    setNewName('')
    setNewPath('')
    fetchProjects()
  }, [newName, newPath, fetchProjects])

  const handleDelete = useCallback(async (name: string) => {
    await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
    fetchProjects()
  }, [fetchProjects])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface-panel border border-white/10 rounded-lg p-5 w-[520px] shadow-xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') onClose() }}
      >
        <h3 className="text-sm font-display uppercase tracking-wider text-primary mb-4">
          Settings
        </h3>

        {/* Projects section */}
        <div className="mb-4">
          <h4 className="text-xs font-display uppercase tracking-wider text-slate-300 mb-2">
            Projects
          </h4>
          <p className="text-2xs text-slate-500 mb-3">
            Register git repos so sessions can attach to them.
          </p>

          {loading ? (
            <div className="text-xs text-slate-500">Loading...</div>
          ) : (
            <div className="space-y-1 mb-3 max-h-48 overflow-y-auto scrollbar-thin">
              {projects.length === 0 ? (
                <div className="text-xs text-slate-500 py-2">No projects registered.</div>
              ) : (
                projects.map(p => (
                  <div
                    key={p.name}
                    className="flex items-center gap-2 px-3 py-2 bg-surface-base rounded border border-white/5 group"
                  >
                    <span className="text-xs text-primary font-display uppercase tracking-wider flex-shrink-0">
                      {p.name}
                    </span>
                    <span className="text-2xs text-slate-500 truncate flex-1" title={p.path}>
                      {p.path}
                    </span>
                    <button
                      className="text-xs text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      onClick={() => handleDelete(p.name)}
                      aria-label={`Remove ${p.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Add project form */}
          <div className="flex gap-2 items-end">
            <div className="flex-shrink-0 w-28">
              <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Name</label>
              <input
                ref={nameRef}
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                placeholder="my-project"
                className="w-full px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
              />
            </div>
            <div className="flex-1">
              <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Path</label>
              <input
                type="text"
                value={newPath}
                onChange={e => setNewPath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                placeholder="/home/user/repo"
                className="w-full px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
              />
            </div>
            <button
              className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30 disabled:opacity-50 flex-shrink-0"
              onClick={handleAdd}
              disabled={!newName.trim() || !newPath.trim()}
            >
              Add
            </button>
          </div>

          {error && (
            <div className="mt-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded px-3 py-1.5">
              {error}
            </div>
          )}
        </div>

        {/* Config info */}
        <div className="border-t border-white/10 pt-3 mb-4 space-y-1">
          <div className="text-2xs text-slate-500">
            Config dir: <span className="text-slate-400">~/.config/tinstar/</span>
          </div>
          <div className="text-2xs text-slate-500">
            Server log: <span className="text-slate-400">~/.config/tinstar/server.log</span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end">
          <button
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
