import { useEffect, useState } from 'react'
import { apiUrl } from '../../apiClient'
import { type Project, parseProjects, groupForPicker } from '../../lib/projects'
import { ProjectPickerOptions } from '../ProjectPickerOptions'

export function FirstSessionStep() {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState('')
  const [name, setName] = useState('first')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(apiUrl('/api/projects'))
      .then(r => r.json())
      .then((resp: { ok: boolean; data?: Record<string, unknown> }) => {
        if (cancelled) return
        const parsed = parseProjects(resp.data as never)
        setProjects(parsed)
        const { favorites, others } = groupForPicker(parsed)
        const first = (favorites[0] ?? others[0])?.name
        if (first) setProject(prev => prev || first)
      })
      .catch(() => { /* upstream onboarding state will reflect */ })
    return () => { cancelled = true }
  }, [])

  const onStart = async () => {
    if (!name.trim() || !project) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(apiUrl('/api/sessions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          backend: 'tmux',
          project,
          cliTemplate: 'claude',
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message || `session create failed (${res.status})`)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-slate-400 text-sm">Sessions are running CLI agents. Start one with the default Claude template — you can spawn more later.</p>
      <div className="flex gap-2 flex-wrap">
        <select
          data-testid="session-project-select"
          value={project}
          onChange={e => setProject(e.target.value)}
          className="bg-surface-base border border-white/10 rounded px-2 py-1 text-sm"
        >
          <ProjectPickerOptions projects={projects} selectedValue={project} />
        </select>
        <input
          data-testid="session-name-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="session name"
          className="flex-1 bg-surface-base border border-white/10 rounded px-2 py-1 font-mono text-sm"
        />
        <button
          data-testid="session-start"
          onClick={onStart}
          disabled={busy || !project || !name.trim()}
          className="px-3 py-1 bg-cyan-700 hover:bg-cyan-600 rounded text-sm disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
      {error && <div data-testid="session-error" className="text-red-400 text-sm">{error}</div>}
    </div>
  )
}
