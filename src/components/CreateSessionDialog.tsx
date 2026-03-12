import { useState, useRef, useEffect, useCallback } from 'react'

export interface SessionPrefill {
  project?: string
  backend?: 'docker' | 'tmux'
  worktreeMode?: 'none' | 'new' | 'existing'
  skipPermissions?: boolean
  profile?: string
  taskId?: string
}

interface Props {
  onClose: () => void
  prefill?: SessionPrefill
}

type Backend = 'docker' | 'tmux'
type WorktreeMode = 'none' | 'new' | 'existing'

interface EntityOption { id: string; name: string }

export function CreateSessionDialog({ onClose, prefill }: Props) {
  const [name, setName] = useState('')
  const [backend, setBackend] = useState<Backend>(prefill?.backend ?? 'tmux')
  const [project, setProject] = useState(prefill?.project ?? '')
  const [projects, setProjects] = useState<Array<{ name: string; path: string }>>([])
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>(prefill?.worktreeMode ?? 'none')
  const [skipPermissions, setSkipPermissions] = useState(prefill?.skipPermissions ?? true)
  const [prompt, setPrompt] = useState('')
  const [taskId, setTaskId] = useState(prefill?.taskId ?? '')
  const [entities, setEntities] = useState<{ initiatives: EntityOption[]; epics: EntityOption[]; tasks: EntityOption[] }>({ initiatives: [], epics: [], tasks: [] })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  // Fetch projects list and entities
  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.ok && d.data && typeof d.data === 'object') {
          setProjects(Object.entries(d.data).map(([name, path]) => ({ name, path: path as string })))
        }
      })
      .catch(() => {})

    fetch('/api/state')
      .then(r => r.ok ? r.json() : null)
      .then(state => {
        if (!state) return
        setEntities({
          initiatives: (state.initiatives ?? []).map((i: { id: string; name: string }) => ({ id: i.id, name: i.name })),
          epics: (state.epics ?? []).map((e: { id: string; name: string }) => ({ id: e.id, name: e.name })),
          tasks: (state.tasks ?? []).map((t: { id: string; name: string }) => ({ id: t.id, name: t.name })),
        })
      })
      .catch(() => {})
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || submitting) return
    setSubmitting(true)
    setError(null)

    const body: Record<string, unknown> = {
      name: name.trim(),
      backend,
      skipPermissions,
    }
    if (project) body.project = project
    if (worktreeMode === 'new') body.worktree = true
    if (prompt.trim()) body.prompt = prompt.trim()
    if (taskId) body.taskId = taskId

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error?.message ?? 'Failed to create session')
        setSubmitting(false)
        return
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }, [name, backend, project, worktreeMode, skipPermissions, prompt, submitting, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSubmit()
  }, [handleSubmit, onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface-panel border border-white/10 rounded-lg p-5 w-[480px] shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-display uppercase tracking-wider text-primary mb-4">
          New Session
        </h3>

        {/* Name */}
        <div className="mb-3">
          <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Name</label>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
            placeholder="my-session"
            className="w-full px-3 py-2 bg-surface-base border border-white/10 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
            data-testid="session-name-input"
          />
        </div>

        {/* Backend + Project row */}
        <div className="flex gap-3 mb-3">
          {/* Backend toggle */}
          <div className="flex-1">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Backend</label>
            <div className="flex rounded border border-white/10 overflow-hidden">
              {(['docker', 'tmux'] as Backend[]).map(b => (
                <button
                  key={b}
                  className={[
                    'flex-1 px-3 py-1.5 text-xs transition-colors',
                    backend === b
                      ? 'bg-primary/20 text-primary border-primary/40'
                      : 'bg-surface-base text-slate-400 hover:text-slate-200',
                  ].join(' ')}
                  onClick={() => setBackend(b)}
                >
                  {b.charAt(0).toUpperCase() + b.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Project picker */}
          <div className="flex-1">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Project</label>
            <select
              value={project}
              onChange={e => setProject(e.target.value)}
              className="w-full px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
            >
              <option value="">None</option>
              {projects.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Worktree mode */}
        {project && (
          <div className="mb-3">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Worktree</label>
            <div className="flex rounded border border-white/10 overflow-hidden">
              {(['none', 'new', 'existing'] as WorktreeMode[]).map(m => (
                <button
                  key={m}
                  className={[
                    'flex-1 px-3 py-1.5 text-xs transition-colors',
                    worktreeMode === m
                      ? 'bg-primary/20 text-primary'
                      : 'bg-surface-base text-slate-400 hover:text-slate-200',
                  ].join(' ')}
                  onClick={() => setWorktreeMode(m)}
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Attach to entity */}
        {entities.tasks.length > 0 && (
          <div className="mb-3">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Attach to Task</label>
            <select
              value={taskId}
              onChange={e => setTaskId(e.target.value)}
              className="w-full px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
            >
              <option value="">None (unattached)</option>
              {entities.tasks.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Skip permissions */}
        <div className="flex items-center gap-2 mb-3">
          <input
            type="checkbox"
            id="skip-perms"
            checked={skipPermissions}
            onChange={e => setSkipPermissions(e.target.checked)}
            className="accent-primary"
          />
          <label htmlFor="skip-perms" className="text-xs text-slate-300 cursor-pointer">
            Skip permissions
          </label>
          <span className="text-2xs text-slate-500">
            (--dangerously-skip-permissions)
          </span>
        </div>

        {/* Starting prompt */}
        <div className="mb-4">
          <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">
            Starting Prompt
          </label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Initial message to send to Claude..."
            rows={3}
            className="w-full px-3 py-2 bg-surface-base border border-white/10 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none resize-none"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="mb-3 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded px-3 py-2">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-between items-center">
          <span className="text-2xs text-slate-500">Ctrl+Enter to create</span>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30 disabled:opacity-50"
              onClick={handleSubmit}
              disabled={!name.trim() || submitting}
              data-testid="create-session-submit"
            >
              {submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
