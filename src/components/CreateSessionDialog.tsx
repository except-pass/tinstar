import { useState, useRef, useEffect, useCallback } from 'react'
import { DEFAULT_RUN_ACCENT } from './runAccent'
import { ColorPalette } from './ColorPalette'

export interface SessionPrefill {
  project?: string
  backend?: 'docker' | 'tmux'
  worktreeMode?: 'none' | 'new' | 'existing'
  skipPermissions?: boolean
  profile?: string
  runColor?: string
  taskId?: string
  epicId?: string
  initiativeId?: string
  sources?: Record<string, { type: string; name: string }>
}

interface Props {
  onClose: () => void
  prefill?: SessionPrefill
}

type Backend = 'docker' | 'tmux'
type WorktreeMode = 'none' | 'new' | 'existing'

interface EntityOption { id: string; name: string }

function generateName(): string {
  const adj = ['swift', 'bold', 'keen', 'calm', 'warm', 'cool', 'bright', 'sharp', 'quick', 'deft']
  const noun = ['fox', 'hawk', 'wolf', 'bear', 'lynx', 'pike', 'wren', 'crow', 'hare', 'elk']
  const a = adj[Math.floor(Math.random() * adj.length)]
  const n = noun[Math.floor(Math.random() * noun.length)]
  const id = Math.random().toString(36).slice(2, 6)
  return `${a}-${n}-${id}`
}

/** Sanitize a session name: allow letters, digits, dashes, and underscores */
function sanitizeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

function InheritedFrom({ source }: { source?: { type: string; name: string } }) {
  if (!source) return null
  return (
    <span className="ml-1.5 text-2xs text-slate-500 normal-case tracking-normal font-normal">
      · from {source.type}: <span className="text-slate-400">{source.name}</span>
    </span>
  )
}

export function CreateSessionDialog({ onClose, prefill }: Props) {
  const [placeholder] = useState(generateName)
  const [name, setName] = useState('')
  const [backend, setBackend] = useState<Backend>(prefill?.backend ?? 'tmux')
  const [profile, setProfile] = useState(prefill?.profile ?? '')
  const [profiles, setProfiles] = useState<Array<{ name: string; image: string }>>([])
  const [project, setProject] = useState(prefill?.project ?? '')
  const [projects, setProjects] = useState<Array<{ name: string; path: string }>>([])
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>(prefill?.worktreeMode ?? 'none')
  const [worktreePath, setWorktreePath] = useState('')
  const [availableWorktrees, setAvailableWorktrees] = useState<Array<{ path: string; branch?: string }>>([])
  const [skipPermissions, setSkipPermissions] = useState(prefill?.skipPermissions ?? true)
  const [prompt, setPrompt] = useState('')
  const [runColor, setRunColor] = useState(prefill?.runColor ?? DEFAULT_RUN_ACCENT)
  const [taskId, setTaskId] = useState(prefill?.taskId ?? '')
  const [entities, setEntities] = useState<{ initiatives: EntityOption[]; epics: EntityOption[]; tasks: EntityOption[] }>({ initiatives: [], epics: [], tasks: [] })
  const [addingProject, setAddingProject] = useState(false)
  const [newProjectPath, setNewProjectPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const sources = prefill?.sources ?? {}

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

  // Fetch configured image profiles when backend is docker
  useEffect(() => {
    if (backend !== 'docker') return
    fetch('/api/docker/profiles')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.ok && Array.isArray(d.data)) setProfiles(d.data)
      })
      .catch(() => {})
  }, [backend])

  // Fetch existing worktrees when project is selected and mode is 'existing'
  useEffect(() => {
    if (!project || worktreeMode !== 'existing') {
      setAvailableWorktrees([])
      setWorktreePath('')
      return
    }
    fetch(`/api/projects/${encodeURIComponent(project)}/worktrees`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.ok && Array.isArray(d.data)) {
          setAvailableWorktrees(d.data)
          if (d.data.length > 0) setWorktreePath(d.data[0].path)
        }
      })
      .catch(() => {})
  }, [project, worktreeMode])

  const effectiveName = name || placeholder

  const handleSubmit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    setError(null)

    const body: Record<string, unknown> = {
      name: effectiveName,
      backend,
      skipPermissions,
    }
    if (profile) body.profile = profile
    if (project) body.project = project
    if (worktreeMode === 'new') body.worktree = true
    if (worktreeMode === 'existing' && worktreePath) body.worktreePath = worktreePath
    if (prompt.trim()) body.prompt = prompt.trim()
    if (taskId) body.taskId = taskId
    if (runColor) body.color = runColor
    if (prefill?.epicId) body.epicId = prefill.epicId
    if (prefill?.initiativeId) body.initiativeId = prefill.initiativeId

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
  }, [effectiveName, backend, profile, project, worktreeMode, worktreePath, skipPermissions, prompt, taskId, runColor, prefill?.epicId, prefill?.initiativeId, submitting, onClose])

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
            autoFocus
            type="text"
            value={name}
            onChange={e => setName(sanitizeName(e.target.value))}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
            placeholder={placeholder}
            className="w-full px-3 py-2 bg-surface-base border border-white/10 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
            data-testid="session-name-input"
          />
        </div>

        {/* Backend + Project row */}
        <div className="flex gap-3 mb-3">
          {/* Backend toggle */}
          <div className="flex-1">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">
              Backend<InheritedFrom source={sources.backend} />
            </label>
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
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block group relative cursor-default">
              Project<InheritedFrom source={sources.project} />
              <span className="pointer-events-none absolute left-0 top-full mt-1 z-50 hidden group-hover:block w-56 px-2 py-1.5 rounded bg-slate-800 border border-white/10 text-2xs text-slate-300 leading-relaxed shadow-lg normal-case tracking-normal">
                Sets the working directory. For tmux: opens at the project path (or a sibling worktree dir). For Docker: bind-mounted the same way. None = no mount.
              </span>
            </label>
            <select
              value={addingProject ? '__add__' : project}
              onChange={e => {
                if (e.target.value === '__add__') {
                  setAddingProject(true)
                } else {
                  setProject(e.target.value)
                  setAddingProject(false)
                }
              }}
              className="w-full px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
            >
              {projects.length === 0 ? (
                <option value="" disabled>No projects yet — add one to get started</option>
              ) : (
                <option value="">None</option>
              )}
              {projects.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
              <option value="__add__">+ Add project</option>
            </select>
            {addingProject && (
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={newProjectPath}
                  onChange={e => setNewProjectPath(e.target.value)}
                  placeholder="/path/to/project"
                  autoFocus
                  className="flex-1 px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newProjectPath.trim()) {
                      const name = newProjectPath.trim().split('/').pop() || 'project'
                      fetch('/api/projects', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, path: newProjectPath.trim() }),
                      }).then(r => r.json()).then(() => {
                        setProjects(prev => [...prev, { name, path: newProjectPath.trim() }])
                        setProject(name)
                        setAddingProject(false)
                        setNewProjectPath('')
                      })
                    } else if (e.key === 'Escape') {
                      setAddingProject(false)
                      setNewProjectPath('')
                    }
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Docker image profile */}
        {backend === 'docker' && profiles.length > 0 && (
          <div className="mb-3">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">
              Image<InheritedFrom source={sources.profile} />
            </label>
            <select
              value={profile}
              onChange={e => setProfile(e.target.value)}
              className="w-full px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
            >
              <option value="">Default</option>
              {profiles.map(p => (
                <option key={p.name} value={p.name}>{p.name} ({p.image})</option>
              ))}
            </select>
          </div>
        )}

        {/* Worktree mode */}
        {project && (
          <div className="mb-3">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">
              Worktree<InheritedFrom source={sources.worktree} />
            </label>
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

        {/* Existing worktree picker */}
        {project && worktreeMode === 'existing' && (
          <div className="mb-3">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Select Worktree</label>
            {availableWorktrees.length === 0 ? (
              <div className="text-xs text-slate-500 italic px-1">No existing worktrees found for this project</div>
            ) : (
              <select
                value={worktreePath}
                onChange={e => setWorktreePath(e.target.value)}
                className="w-full px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
              >
                {availableWorktrees.map(wt => (
                  <option key={wt.path} value={wt.path}>
                    {wt.branch ?? wt.path.split('/').pop() ?? wt.path}
                  </option>
                ))}
              </select>
            )}
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


        {/* Run color */}
        <div className="mb-3">
          <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">
            Run Color<InheritedFrom source={sources.defaultRunColor} />
          </label>
          <ColorPalette value={runColor} onChange={setRunColor} />
          <div className="flex items-center gap-2 mt-2">
            <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: runColor }} />
            <span className="text-xs font-mono" style={{ color: runColor }}>{runColor}</span>
          </div>
        </div>

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
            Skip permissions<InheritedFrom source={sources.skipPermissions} />
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
              disabled={submitting}
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
