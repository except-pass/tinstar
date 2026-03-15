import { useState, useRef, useEffect, useCallback } from 'react'

interface Project {
  name: string
  path: string
}

interface ImageProfile {
  name: string
  image: string
  home?: string
}

type Section = 'projects' | 'docker' | 'editor'

interface Props {
  onClose: () => void
}

export function SettingsDialog({ onClose }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const projectsRef = useRef<HTMLDivElement>(null)
  const dockerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  // Projects
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Editor
  const [editorCmd, setEditorCmd] = useState('')
  const [editorSaved, setEditorSaved] = useState(false)

  // Docker image profiles
  const [profiles, setProfiles] = useState<ImageProfile[]>([])
  const [dockerImages, setDockerImages] = useState<string[]>([])
  const [newProfileName, setNewProfileName] = useState('')
  const [selectedImage, setSelectedImage] = useState('')
  const [profileError, setProfileError] = useState<string | null>(null)

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

  const fetchProfiles = useCallback(() => {
    fetch('/api/docker/profiles')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setProfiles(d.data ?? []) })
      .catch(() => {})
  }, [])

  const fetchDockerImages = useCallback(() => {
    fetch('/api/docker/images')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setDockerImages(d.data ?? []) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchProjects()
    fetchProfiles()
    fetchDockerImages()
    fetch('/api/config')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && typeof d.data?.editor === 'string') setEditorCmd(d.data.editor) })
      .catch(() => {})
  }, [fetchProjects, fetchProfiles, fetchDockerImages])

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

  const handleAddProfile = useCallback(async () => {
    const trimName = newProfileName.trim()
    if (!trimName || !selectedImage) return
    setProfileError(null)

    const optimistic: ImageProfile = { name: trimName, image: selectedImage }
    setProfiles(prev => [...prev, optimistic])
    setNewProfileName('')
    setSelectedImage('')

    const res = await fetch('/api/docker/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimName, image: selectedImage }),
    })
    const data = await res.json()
    if (!data.ok) {
      setProfiles(prev => prev.filter(p => p !== optimistic))
      setProfileError(data.error?.message ?? 'Failed to add profile')
      setNewProfileName(trimName)
      setSelectedImage(selectedImage)
    }
  }, [newProfileName, selectedImage])

  const handleDeleteProfile = useCallback(async (name: string) => {
    await fetch(`/api/docker/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })
    fetchProfiles()
  }, [fetchProfiles])

  const scrollTo = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const sections: { key: Section; label: string; icon: string; ref: React.RefObject<HTMLDivElement | null> }[] = [
    { key: 'projects', label: 'Projects', icon: 'folder', ref: projectsRef },
    { key: 'docker', label: 'Docker', icon: 'deployed_code', ref: dockerRef },
    { key: 'editor', label: 'Editor', icon: 'edit', ref: editorRef },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface-panel border border-white/10 rounded-lg shadow-xl w-[560px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') onClose() }}
      >
        {/* Title bar + section nav */}
        <div className="border-b border-white/10 px-5 pt-4 pb-0">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-display uppercase tracking-wider text-primary">
              Settings
            </h3>
            <button
              className="text-slate-500 hover:text-slate-300 transition-colors"
              onClick={onClose}
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
          <nav className="flex gap-4">
            {sections.map(s => (
              <button
                key={s.key}
                onClick={() => scrollTo(s.ref)}
                className="flex items-center gap-1.5 pb-2 text-2xs font-mono uppercase tracking-wider text-slate-500 hover:text-primary border-b border-transparent hover:border-primary/50 transition-colors"
              >
                <span className="material-symbols-outlined text-xs">{s.icon}</span>
                {s.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Scrollable content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">

          {/* ── Projects ── */}
          <div ref={projectsRef} className="px-5 pt-5 pb-6">
            <h4 className="text-xs font-display uppercase tracking-wider text-slate-300 mb-1">
              Projects
            </h4>
            <p className="text-2xs text-slate-500 mb-4">
              Register git repos so sessions can attach to them.
            </p>

            {loading ? (
              <div className="text-xs text-slate-500">Loading...</div>
            ) : (
              <div className="space-y-1 mb-4">
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

          {/* ── Separator ── */}
          <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* ── Docker Images ── */}
          <div ref={dockerRef} className="px-5 pt-5 pb-6">
            <h4 className="text-xs font-display uppercase tracking-wider text-slate-300 mb-1">
              Docker Images
            </h4>
            <p className="text-2xs text-slate-500 mb-4">
              Register Docker images as named profiles for new sessions.
            </p>

            <div className="space-y-1 mb-4">
              {profiles.length === 0 ? (
                <div className="text-xs text-slate-500 py-2">No image profiles registered.</div>
              ) : (
                profiles.map(p => (
                  <div
                    key={p.name}
                    className="flex items-center gap-2 px-3 py-2 bg-surface-base rounded border border-white/5 group"
                  >
                    <span className="text-xs text-primary font-display uppercase tracking-wider flex-shrink-0">
                      {p.name}
                    </span>
                    <span className="text-2xs text-slate-500 truncate flex-1 font-mono" title={p.image}>
                      {p.image}
                    </span>
                    <button
                      className="text-xs text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      onClick={() => handleDeleteProfile(p.name)}
                      aria-label={`Remove ${p.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="flex gap-2 items-end">
              <div className="flex-shrink-0 w-28">
                <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Name</label>
                <input
                  type="text"
                  value={newProfileName}
                  onChange={e => setNewProfileName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddProfile() }}
                  placeholder="my-image"
                  className="w-full px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Image</label>
                <select
                  value={selectedImage}
                  onChange={e => setSelectedImage(e.target.value)}
                  className="w-full px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
                >
                  <option value="" className="text-slate-500">Select image...</option>
                  {dockerImages.map(img => (
                    <option key={img} value={img}>{img}</option>
                  ))}
                </select>
              </div>
              <button
                className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30 disabled:opacity-50 flex-shrink-0"
                onClick={handleAddProfile}
                disabled={!newProfileName.trim() || !selectedImage}
              >
                Add
              </button>
            </div>

            {profileError && (
              <div className="mt-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded px-3 py-1.5">
                {profileError}
              </div>
            )}
          </div>

          {/* ── Separator ── */}
          <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* ── Editor ── */}
          <div ref={editorRef} className="px-5 pt-5 pb-6">
            <h4 className="text-xs font-display uppercase tracking-wider text-slate-300 mb-1">
              Editor Command
            </h4>
            <p className="text-2xs text-slate-500 mb-4">
              Command to open files. Use <code className="text-slate-400">{'{{path}}'}</code> as the file path placeholder.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={editorCmd}
                onChange={e => { setEditorCmd(e.target.value); setEditorSaved(false) }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && editorCmd.trim()) {
                    fetch('/api/config', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ editor: editorCmd }),
                    }).then(() => setEditorSaved(true)).catch(() => {})
                  }
                }}
                placeholder="cursor {{path}}"
                className="flex-1 px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 font-mono placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
              />
              <button
                className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30 disabled:opacity-50 flex-shrink-0"
                disabled={!editorCmd.trim()}
                onClick={() => {
                  fetch('/api/config', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ editor: editorCmd }),
                  }).then(() => setEditorSaved(true)).catch(() => {})
                }}
              >
                {editorSaved ? 'Saved' : 'Save'}
              </button>
            </div>
            <div className="flex gap-3 mt-3 text-2xs text-slate-600">
              <span>cursor {'{{path}}'}</span>
              <span>code -g {'{{path}}'}</span>
              <span>subl {'{{path}}'}</span>
            </div>
          </div>

          {/* ── Footer info ── */}
          <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          <div className="px-5 py-4 text-2xs text-slate-600">
            Config dir: <span className="text-slate-500">~/.config/tinstar/</span>
          </div>

        </div>
      </div>
    </div>
  )
}
