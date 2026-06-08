import { useState, useRef, useEffect, useCallback } from 'react'
import { PluginsTab } from './Settings/PluginsTab'
import { useDimensionMeta, autoPlural } from '../hooks/useDimensionMeta'
import { useBackendState } from '../hooks/useBackendState'
import type { LevelLabel } from '../domain/types'
import { AgentIcon } from './agentIcon'
import { apiFetch } from '../apiClient'
import { useConfig, useConfigPatch } from '../context/ConfigContext'

interface Project {
  name: string
  path: string
}

interface CliTemplate {
  name: string
  icon?: string
  adapter?: string
  telemetry?: boolean
  startCmd: string
  resumeCmd: string
}

type Section = 'projects' | 'agents' | 'editor' | 'labels' | 'widgets' | 'plugins'

interface Props {
  onClose: () => void
}

export function SettingsDialog({ onClose }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const projectsRef = useRef<HTMLDivElement>(null)
  const agentsRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const widgetsRef = useRef<HTMLDivElement>(null)
  const pluginsRef = useRef<HTMLDivElement | null>(null)

  const { activeSpaceId, spaces } = useBackendState()
  const activeSpace = spaces.find(s => s.id === activeSpaceId)
  const currentMeta = useDimensionMeta()
  const config = useConfig()
  const patchConfig = useConfigPatch()

  const [labelLevels, setLabelLevels] = useState<LevelLabel[]>(() =>
    currentMeta.map(m => ({ icon: m.icon, label: m.label, plural: '' }))
  )
  const [labelsDirty, setLabelsDirty] = useState(false)
  const [labelsSaving, setLabelsSaving] = useState(false)

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

  // CLI templates (agent backends)
  const [templates, setTemplates] = useState<CliTemplate[]>([])
  const [newTplName, setNewTplName] = useState('')
  const [newTplIcon, setNewTplIcon] = useState('')
  const [newTplAdapter, setNewTplAdapter] = useState('generic')
  const [newTplStart, setNewTplStart] = useState('')
  const [newTplResume, setNewTplResume] = useState('')
  const [newTplTelemetry, setNewTplTelemetry] = useState(true)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<CliTemplate | null>(null)

  // Widget settings (config)
  const [promptComposerDefault, setPromptComposerDefault] = useState(() => config?.ui.promptComposerDefault ?? false)

  useEffect(() => {
    if (config) setPromptComposerDefault(config.ui.promptComposerDefault)
  }, [config?.ui.promptComposerDefault])

  // File Explorer settings
  const [uploadMaxMb, setUploadMaxMb] = useState(() => Math.round((config?.uploadMaxBytes ?? 100 * 1024 * 1024) / (1024 * 1024)))
  const [uploadSaveError, setUploadSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (config) setUploadMaxMb(Math.round(config.uploadMaxBytes / (1024 * 1024)))
  }, [config?.uploadMaxBytes])

  const fetchProjects = useCallback(() => {
    apiFetch('/api/projects')
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

  const fetchTemplates = useCallback(() => {
    apiFetch('/api/cli-templates')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setTemplates(d.data ?? []) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchProjects()
    fetchTemplates()
    apiFetch('/api/config')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && typeof d.data?.editor === 'string') setEditorCmd(d.data.editor) })
      .catch(() => {})
  }, [fetchProjects, fetchTemplates])

  const handleAdd = useCallback(async () => {
    const trimName = newName.trim()
    const trimPath = newPath.trim()
    if (!trimName || !trimPath) return
    setError(null)

    const res = await apiFetch('/api/projects', {
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
    await apiFetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
    fetchProjects()
  }, [fetchProjects])

  const handleAddTemplate = useCallback(async () => {
    const trimName = newTplName.trim()
    const trimStart = newTplStart.trim()
    const trimResume = newTplResume.trim()
    if (!trimName || !trimStart || !trimResume) return
    setTemplateError(null)

    const res = await apiFetch('/api/cli-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimName, icon: newTplIcon.trim() || undefined, adapter: newTplAdapter, telemetry: newTplTelemetry, startCmd: trimStart, resumeCmd: trimResume }),
    })
    const data = await res.json()
    if (!data.ok) {
      setTemplateError(data.error?.message ?? 'Failed to add template')
      return
    }
    setNewTplName('')
    setNewTplIcon('')
    setNewTplAdapter('generic')
    setNewTplTelemetry(true)
    setNewTplStart('')
    setNewTplResume('')
    fetchTemplates()
  }, [newTplName, newTplStart, newTplResume, fetchTemplates])

  const handleDeleteTemplate = useCallback(async (name: string) => {
    await apiFetch(`/api/cli-templates/${encodeURIComponent(name)}`, { method: 'DELETE' })
    fetchTemplates()
  }, [fetchTemplates])

  const handleEditTemplate = useCallback((t: CliTemplate) => {
    setEditingTemplate(t.name)
    setEditDraft({ ...t })
  }, [])

  const handleSaveTemplate = useCallback(async () => {
    if (!editDraft || !editingTemplate) return
    setTemplateError(null)
    const res = await apiFetch(`/api/cli-templates/${encodeURIComponent(editingTemplate)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editDraft),
    })
    const data = await res.json()
    if (!data.ok) {
      setTemplateError(data.error?.message ?? 'Failed to save template')
      return
    }
    setEditingTemplate(null)
    setEditDraft(null)
    fetchTemplates()
  }, [editDraft, editingTemplate, fetchTemplates])

  const handleCancelEdit = useCallback(() => {
    setEditingTemplate(null)
    setEditDraft(null)
  }, [])

  const handleSaveLabels = useCallback(async () => {
    if (!activeSpaceId) return
    setLabelsSaving(true)
    try {
      const res = await apiFetch(`/api/spaces/${activeSpaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelConfig: { levels: labelLevels } }),
      })
      if (res.ok) setLabelsDirty(false)
    } finally {
      setLabelsSaving(false)
    }
  }, [activeSpaceId, labelLevels])

  const handleResetLabels = useCallback(() => {
    setLabelLevels([
      { icon: '🚀', label: 'Initiative' },
      { icon: '🏔️', label: 'Epic' },
      { icon: '🗂️', label: 'Task' },
    ])
    setLabelsDirty(true)
  }, [])

  const scrollTo = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const sections: { key: Section; label: string; icon: string; ref: React.RefObject<HTMLDivElement | null> }[] = [
    { key: 'projects', label: 'Projects', icon: 'folder', ref: projectsRef },
    { key: 'agents', label: 'Agents', icon: 'terminal', ref: agentsRef },
    { key: 'editor', label: 'Editor', icon: 'edit', ref: editorRef },
    { key: 'labels', label: 'Entity Labels', icon: 'label', ref: labelsRef },
    { key: 'widgets', label: 'Widgets', icon: 'widgets', ref: widgetsRef },
    { key: 'plugins', label: 'Plugins', icon: 'extension', ref: pluginsRef },
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

          {/* ── Agent CLI Templates ── */}
          <div ref={agentsRef} className="px-5 pt-5 pb-6">
            <h4 className="text-xs font-display uppercase tracking-wider text-slate-300 mb-1">
              Agent CLI Templates
            </h4>
            <p className="text-2xs text-slate-500 mb-4">
              Named CLI commands for agent backends. Use <code className="text-slate-400">{'{sessionId}'}</code> and <code className="text-slate-400">{'{prompt}'}</code> as placeholders.
            </p>

            <div className="space-y-1 mb-4">
              {templates.length === 0 ? (
                <div className="text-xs text-slate-500 py-2">No templates configured.</div>
              ) : (
                templates.map(t => editingTemplate === t.name && editDraft ? (
                  <div
                    key={t.name}
                    className="px-3 py-3 bg-surface-base rounded border border-primary/30 space-y-2"
                  >
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Name</label>
                        <input
                          type="text"
                          value={editDraft.name}
                          onChange={e => setEditDraft({ ...editDraft, name: e.target.value })}
                          className="w-full px-2 py-1.5 bg-surface-panel border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Icon <span className="text-slate-600 normal-case tracking-normal">(emoji or /path/to.svg)</span></label>
                        <div className="flex items-center gap-1.5">
                          <span className="flex items-center justify-center w-7 h-7 bg-surface-panel border border-white/10 rounded flex-shrink-0">
                            <AgentIcon icon={editDraft.icon} className="w-4 h-4" />
                          </span>
                          <input
                            type="text"
                            value={editDraft.icon ?? ''}
                            onChange={e => setEditDraft({ ...editDraft, icon: e.target.value })}
                            placeholder="▶ or /agent-icons/foo.svg"
                            className="flex-1 min-w-0 px-2 py-1.5 bg-surface-panel border border-white/10 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
                          />
                        </div>
                      </div>
                      <div className="w-24">
                        <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Adapter</label>
                        <select
                          value={editDraft.adapter ?? 'generic'}
                          onChange={e => setEditDraft({ ...editDraft, adapter: e.target.value })}
                          className="w-full px-2 py-1.5 bg-surface-panel border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
                        >
                          <option value="claude">claude</option>
                          <option value="codex">codex</option>
                          <option value="generic">generic</option>
                        </select>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editDraft.telemetry !== false}
                        onChange={e => setEditDraft({ ...editDraft, telemetry: e.target.checked })}
                        className="accent-primary w-3.5 h-3.5"
                      />
                      <span className="text-xs text-slate-300">Enable telemetry</span>
                      <span className="text-2xs text-slate-600">(OTLP metrics export)</span>
                    </label>
                    <div>
                      <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Start command</label>
                      <input
                        type="text"
                        value={editDraft.startCmd}
                        onChange={e => setEditDraft({ ...editDraft, startCmd: e.target.value })}
                        className="w-full px-2 py-1.5 bg-surface-panel border border-white/10 rounded text-xs text-slate-200 font-mono focus:border-primary/50 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Resume command</label>
                      <input
                        type="text"
                        value={editDraft.resumeCmd}
                        onChange={e => setEditDraft({ ...editDraft, resumeCmd: e.target.value })}
                        className="w-full px-2 py-1.5 bg-surface-panel border border-white/10 rounded text-xs text-slate-200 font-mono focus:border-primary/50 focus:outline-none"
                      />
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30"
                        onClick={handleSaveTemplate}
                      >
                        Save
                      </button>
                      <button
                        className="px-3 py-1.5 text-xs text-slate-400 border border-white/10 rounded hover:bg-white/5"
                        onClick={handleCancelEdit}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={t.name}
                    className="px-3 py-2 bg-surface-base rounded border border-white/5 group cursor-pointer hover:border-white/10"
                    onClick={() => handleEditTemplate(t)}
                  >
                    <div className="flex items-center gap-2">
                      {t.icon && (
                        <span className="text-sm flex-shrink-0 inline-flex items-center justify-center w-4 h-4">
                          <AgentIcon icon={t.icon} />
                        </span>
                      )}
                      <span className="text-xs text-primary font-display uppercase tracking-wider flex-shrink-0">
                        {t.name}
                      </span>
                      {t.adapter && (
                        <span className="text-2xs text-slate-600 font-mono">{t.adapter}</span>
                      )}
                      {t.telemetry !== false && (
                        <span className="text-2xs text-emerald-600" title="OTLP telemetry enabled">telem</span>
                      )}
                      <span className="flex-1" />
                      <button
                        className="text-xs text-slate-500 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mr-1"
                        onClick={e => { e.stopPropagation(); handleEditTemplate(t) }}
                        aria-label={`Edit ${t.name}`}
                      >
                        <span className="material-symbols-outlined text-xs">edit</span>
                      </button>
                      <button
                        className="text-xs text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        onClick={e => { e.stopPropagation(); handleDeleteTemplate(t.name) }}
                        aria-label={`Remove ${t.name}`}
                      >
                        ×
                      </button>
                    </div>
                    <div className="text-2xs text-slate-500 font-mono mt-1 truncate" title={t.startCmd}>
                      start: {t.startCmd}
                    </div>
                    <div className="text-2xs text-slate-500 font-mono truncate" title={t.resumeCmd}>
                      resume: {t.resumeCmd}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Name</label>
                  <input
                    type="text"
                    value={newTplName}
                    onChange={e => setNewTplName(e.target.value)}
                    placeholder="My Agent"
                    className="w-full px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Icon <span className="text-slate-600 normal-case tracking-normal">(emoji or /path/to.svg)</span></label>
                  <div className="flex items-center gap-1.5">
                    <span className="flex items-center justify-center w-7 h-7 bg-surface-base border border-white/10 rounded flex-shrink-0">
                      <AgentIcon icon={newTplIcon} className="w-4 h-4" />
                    </span>
                    <input
                      type="text"
                      value={newTplIcon}
                      onChange={e => setNewTplIcon(e.target.value)}
                      placeholder="▶ or /agent-icons/foo.svg"
                      className="flex-1 min-w-0 px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="w-24">
                  <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Adapter</label>
                  <select
                    value={newTplAdapter}
                    onChange={e => setNewTplAdapter(e.target.value)}
                    className="w-full px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
                  >
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                    <option value="generic">generic</option>
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newTplTelemetry}
                  onChange={e => setNewTplTelemetry(e.target.checked)}
                  className="accent-primary w-3.5 h-3.5"
                />
                <span className="text-xs text-slate-300">Enable telemetry</span>
                <span className="text-2xs text-slate-600">(OTLP metrics export)</span>
              </label>
              <div>
                <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Start command</label>
                <input
                  type="text"
                  value={newTplStart}
                  onChange={e => setNewTplStart(e.target.value)}
                  placeholder="agent --auto --session-id {sessionId} -- {prompt}"
                  className="w-full px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 font-mono placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">Resume command</label>
                <input
                  type="text"
                  value={newTplResume}
                  onChange={e => setNewTplResume(e.target.value)}
                  placeholder="agent --auto --resume {sessionId}"
                  className="w-full px-2 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 font-mono placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
                />
              </div>
              <button
                className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30 disabled:opacity-50"
                onClick={handleAddTemplate}
                disabled={!newTplName.trim() || !newTplStart.trim() || !newTplResume.trim()}
              >
                Add
              </button>
            </div>

            {templateError && (
              <div className="mt-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded px-3 py-1.5">
                {templateError}
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
                    apiFetch('/api/config', {
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
                  apiFetch('/api/config', {
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

          {/* ── Separator ── */}
          <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* ── Entity Labels ── */}
          <div ref={labelsRef} className="px-5 pt-5 pb-6">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-xs font-display uppercase tracking-wider text-slate-300">
                Entity Labels
              </h4>
              {activeSpace && (
                <span className="text-2xs text-slate-500 bg-surface-raised border border-white/7 rounded px-2 py-0.5">
                  {activeSpace.name}
                </span>
              )}
            </div>

            {/* Column headers */}
            <div className="flex items-center gap-2 px-3 mb-1 text-2xs text-slate-600 uppercase tracking-wide">
              <span style={{minWidth:44}}>Level</span>
              <span style={{width:30}}>Icon</span>
              <span className="flex-1">Singular</span>
              <span style={{width:96}}>Plural</span>
              <span style={{width:20}}></span>
            </div>

            {/* Level rows */}
            <div className="flex flex-col gap-1.5">
              {labelLevels.map((lvl, i) => {
                const isLeaf = i === labelLevels.length - 1
                return (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 bg-surface-raised border border-white/7 rounded-md">
                    <span className="text-2xs text-slate-500 font-mono" style={{minWidth:44}}>
                      Level {i + 1}{isLeaf && <span className="text-green-500 ml-1">●</span>}
                    </span>
                    {/* Icon — simple emoji input */}
                    <input
                      className="w-8 h-7 text-center bg-surface-panel border border-white/10 rounded text-base cursor-pointer"
                      value={lvl.icon}
                      maxLength={2}
                      onChange={e => {
                        const next = [...labelLevels]
                        next[i] = { ...next[i]!, icon: e.target.value }
                        setLabelLevels(next)
                        setLabelsDirty(true)
                      }}
                      title="Click to change icon (paste any emoji)"
                    />
                    {/* Singular */}
                    <input
                      className="flex-1 bg-surface-panel border border-white/10 rounded px-2 py-1 text-xs text-slate-200 focus:border-primary/50 outline-none"
                      value={lvl.label}
                      placeholder="Label"
                      onChange={e => {
                        const next = [...labelLevels]
                        next[i] = { ...next[i]!, label: e.target.value }
                        setLabelLevels(next)
                        setLabelsDirty(true)
                      }}
                    />
                    {/* Plural */}
                    <input
                      className="bg-surface-panel border border-white/10 rounded px-2 py-1 text-xs text-slate-400 focus:border-primary/50 outline-none"
                      style={{width:96}}
                      value={lvl.plural ?? ''}
                      placeholder={autoPlural(lvl.label) || 'auto'}
                      onChange={e => {
                        const next = [...labelLevels]
                        next[i] = { ...next[i]!, plural: e.target.value }
                        setLabelLevels(next)
                        setLabelsDirty(true)
                      }}
                    />
                    {/* Remove button — only non-leaf */}
                    <button
                      className={`text-xs w-5 h-5 flex items-center justify-center rounded transition-colors ${!isLeaf && labelLevels.length > 1 ? 'text-slate-500 hover:text-red-400 hover:bg-red-400/10' : 'opacity-0 pointer-events-none'}`}
                      onClick={() => {
                        if (isLeaf || labelLevels.length <= 1) return
                        setLabelLevels(labelLevels.filter((_, j) => j !== i))
                        setLabelsDirty(true)
                      }}
                      aria-label="Remove level"
                    >✕</button>
                  </div>
                )
              })}
            </div>

            {/* Add level button */}
            {labelLevels.length < 3 && (
              <button
                className="mt-2 w-full py-2 text-xs text-slate-500 border border-dashed border-white/10 rounded-md hover:text-slate-300 hover:border-white/20 transition-colors"
                onClick={() => {
                  setLabelLevels([{ icon: '📦', label: 'Group', plural: '' }, ...labelLevels])
                  setLabelsDirty(true)
                }}
              >
                + Add level above leaf
              </button>
            )}

            <p className="text-2xs text-slate-600 mt-3">
              Labels apply to this space only. Plural is auto-computed if left blank. No data migration needed.
            </p>

            {/* Footer actions */}
            <div className="flex items-center justify-between mt-4">
              <button
                className="text-2xs text-slate-600 underline decoration-slate-700 hover:text-slate-400"
                onClick={handleResetLabels}
              >
                Reset to defaults
              </button>
              <button
                className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/35 rounded hover:bg-primary/30 disabled:opacity-40 disabled:cursor-default transition-colors"
                disabled={!labelsDirty || labelsSaving}
                onClick={handleSaveLabels}
              >
                {labelsSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          {/* ── Separator ── */}
          <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* ── Widgets ── */}
          <div ref={widgetsRef} className="px-5 pt-5 pb-6">
            <h4 className="text-xs font-display uppercase tracking-wider text-slate-300 mb-4">
              Widgets
            </h4>

            {/* Run Session Widget */}
            <div className="mb-4">
              <h5 className="text-2xs font-mono uppercase tracking-wider text-slate-500 mb-2">
                Run Session
              </h5>
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={promptComposerDefault}
                  onChange={e => {
                    const val = e.target.checked
                    setPromptComposerDefault(val)
                    patchConfig({ ui: { promptComposerDefault: val } as never }).catch(err => {
                      console.warn('[settings] composer default patch failed:', err)
                    })
                  }}
                  className="w-4 h-4 rounded border border-white/20 bg-surface-base accent-primary cursor-pointer"
                />
                <span className="text-xs text-slate-300 group-hover:text-slate-100 transition-colors">
                  Prompt composer open by default
                </span>
              </label>
              <p className="text-2xs text-slate-600 mt-1 ml-7">
                When enabled, new session widgets will have the prompt composer expanded.
              </p>
            </div>

            {/* Telemetry panels */}
            <div className="mb-4">
              <h5 className="text-2xs font-mono uppercase tracking-wider text-slate-500 mb-2">
                Telemetry panels
              </h5>
              <p className="text-2xs text-slate-600 mb-2">
                Show or hide individual panels in per-session telemetry and the canvas HUD.
              </p>
              <div className="space-y-1">
                {([
                  ['cost',       'Cost'],
                  ['tokens',     'Tokens'],
                  ['cacheHit',   'Cache hit'],
                  ['duty',       'Duty cycle'],
                  ['turnLength', 'Turn length'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={config?.ui.telemetryPanels?.[key] ?? (key === 'cacheHit' ? false : true)}
                      onChange={e => {
                        const val = e.target.checked
                        patchConfig({ ui: { telemetryPanels: { [key]: val } as never } as never }).catch(err => {
                          console.warn('[settings] telemetry toggle failed:', err)
                        })
                      }}
                      className="w-4 h-4 rounded border border-white/20 bg-surface-base accent-primary cursor-pointer"
                    />
                    <span className="text-xs text-slate-300 group-hover:text-slate-100 transition-colors">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* File Explorer */}
            <div className="mb-4">
              <h5 className="text-2xs font-mono uppercase tracking-wider text-slate-500 mb-2">
                File Explorer
              </h5>
              <label className="flex items-center gap-3">
                <span className="text-xs text-slate-300">Max upload size (MB)</span>
                <input
                  type="number"
                  min={1}
                  max={1024}
                  value={uploadMaxMb}
                  onChange={e => setUploadMaxMb(Math.max(1, Math.min(1024, Number(e.target.value) || 1)))}
                  onBlur={() => {
                    const bytes = uploadMaxMb * 1024 * 1024
                    patchConfig({ uploadMaxBytes: bytes })
                      .then(() => setUploadSaveError(null))
                      .catch(err => {
                        console.warn('[settings] upload size patch failed:', err)
                        setUploadSaveError(String(err))
                      })
                  }}
                  className="w-20 px-2 py-1 text-xs font-mono bg-surface-base border border-white/20 rounded text-slate-200 focus:outline-none focus:border-primary/60"
                />
              </label>
              {uploadSaveError && (
                <p className="text-2xs text-red-400 mt-1 ml-3">{uploadSaveError}</p>
              )}
              <p className="text-2xs text-slate-600 mt-1">
                Server-enforced cap for files uploaded via drag-and-drop onto the file tree.
              </p>
            </div>
          </div>

          {/* ── Separator ── */}
          <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* ── Plugins ── */}
          <div ref={pluginsRef} className="px-5 py-4 border-b border-white/10">
            <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">Plugins</h4>
            <PluginsTab />
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
