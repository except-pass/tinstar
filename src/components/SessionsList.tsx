import { useState, useEffect, useCallback, useRef } from 'react'

interface SessionInfo {
  name: string
  backend: 'docker' | 'tmux'
  state: string
  project: string | null
  port: number | null
  workspace: { path: string | null; worktree: boolean } | null
  created: string
}

const STATE_COLORS: Record<string, string> = {
  running: '#00ff88',
  idle: '#ffaa00',
  creating: '#94a3b8',
  needs_attention: '#ff3366',
  stopped: '#64748b',
}

interface Props {
  onOpenSession?: (session: SessionInfo) => void
}

export function SessionsList({ onOpenSession }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const deletingRef = useRef<Set<string>>(new Set())

  const fetchSessions = useCallback(() => {
    fetch('/api/sessions')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        let data: SessionInfo[] = []
        if (d?.ok && Array.isArray(d.data)) {
          data = d.data
        } else if (d?.ok && d.data && typeof d.data === 'object') {
          data = Array.isArray(d.data) ? d.data : Object.values(d.data)
        }
        // Filter out sessions that were recently deleted but whose dirs haven't been cleaned up yet
        setSessions(data.filter(s => !deletingRef.current.has(s.name)))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, 10_000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  const handleStop = useCallback(async (name: string) => {
    await fetch(`/api/sessions/${encodeURIComponent(name)}/stop`, { method: 'POST' })
    fetchSessions()
  }, [fetchSessions])

  const handleStart = useCallback(async (name: string) => {
    await fetch(`/api/sessions/${encodeURIComponent(name)}/start`, { method: 'POST' })
    fetchSessions()
  }, [fetchSessions])

  const handleDelete = useCallback(async (name: string) => {
    // Optimistic removal — dir deletion is async on the server, so filtering here
    // prevents the session from reappearing on the next poll before cleanup finishes
    deletingRef.current.add(name)
    setSessions(prev => prev.filter(s => s.name !== name))
    await fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' })
    // Clear the deleting marker after enough time for background cleanup to finish
    setTimeout(() => deletingRef.current.delete(name), 15_000)
  }, [])

  if (loading) {
    return <div className="px-3 py-2 text-2xs text-slate-500">Loading sessions...</div>
  }

  if (sessions.length === 0) {
    return <div className="px-3 py-2 text-2xs text-slate-500">No sessions.</div>
  }

  return (
    <div className="space-y-0.5">
      {sessions.map(s => (
        <div
          key={s.name}
          className="group flex items-center gap-1.5 px-3 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer text-xs"
          onClick={() => onOpenSession?.(s)}
        >
          {/* State dot */}
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: STATE_COLORS[s.state] ?? '#475569' }}
          />

          {/* Name */}
          <span className="truncate flex-1 text-slate-200">{s.name}</span>

          {/* Backend badge */}
          <span className="text-2xs text-slate-500 flex-shrink-0">{s.backend}</span>

          {/* Port link */}
          {s.port && s.state === 'running' && (
            <a
              href={`http://localhost:${s.port}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-2xs text-primary/60 hover:text-primary flex-shrink-0"
              onClick={e => e.stopPropagation()}
              title="Open ttyd terminal"
            >
              :{s.port}
            </a>
          )}

          {/* Actions (visible on hover) */}
          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0">
            {(s.state === 'running' || s.state === 'idle') && (
              <button
                className="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-amber-400"
                onClick={e => { e.stopPropagation(); handleStop(s.name) }}
                title="Stop"
              >
                <span className="material-symbols-outlined text-xs">stop</span>
              </button>
            )}
            {s.state === 'stopped' && (
              <button
                className="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-green-400"
                onClick={e => { e.stopPropagation(); handleStart(s.name) }}
                title="Start"
              >
                <span className="material-symbols-outlined text-xs">play_arrow</span>
              </button>
            )}
            <button
              className="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-red-400"
              onClick={e => { e.stopPropagation(); handleDelete(s.name) }}
              title="Delete"
            >
              <span className="material-symbols-outlined text-xs">close</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
