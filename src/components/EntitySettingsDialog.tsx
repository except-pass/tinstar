import { useEffect, useState, useCallback } from 'react'
import type { GroupingDimension, EntitySettings, ResolvedSettings } from '../domain/types'

interface Props {
  entityId: string
  entityType: GroupingDimension
  entityName: string
  onClose: () => void
}

interface SettingRowProps {
  label: string
  settingKey: keyof EntitySettings
  resolved: ResolvedSettings
  children: (value: EntitySettings[keyof EntitySettings], onChange: (v: EntitySettings[keyof EntitySettings]) => void) => React.ReactNode
  onToggle: (key: keyof EntitySettings, enabled: boolean) => void
  onValueChange: (key: keyof EntitySettings, value: EntitySettings[keyof EntitySettings]) => void
}

function SettingRow({ label, settingKey, resolved, children, onToggle, onValueChange }: SettingRowProps) {
  const localValue = resolved.local[settingKey]
  const resolvedValue = resolved.resolved[settingKey]
  const source = resolved.sources[settingKey]
  const isLocal = localValue !== undefined
  const hasValue = resolvedValue !== undefined

  return (
    <div className="flex items-start gap-3 py-2">
      {/* Checkbox to opt-in to local override */}
      <label className="flex items-center gap-2 cursor-pointer min-w-[140px]">
        <input
          type="checkbox"
          checked={isLocal}
          onChange={(e) => onToggle(settingKey, e.target.checked)}
          className={`w-3.5 h-3.5 rounded border cursor-pointer ${isLocal ? 'accent-[#00f0ff]' : 'accent-slate-500'}`}
        />
        <span className={`text-xs font-mono uppercase tracking-wide ${isLocal ? 'text-primary' : 'text-slate-500'}`}>
          {label}
        </span>
      </label>

      <div className="flex-1">
        {isLocal ? (
          // Local override — show cyan controls
          <div className="text-primary">
            {children(localValue, (v) => onValueChange(settingKey, v))}
          </div>
        ) : hasValue && source ? (
          // Inherited value — show amber pill
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border"
            style={{ borderColor: 'rgba(255, 170, 0, 0.4)', color: '#ffaa00', background: 'rgba(255, 170, 0, 0.1)' }}
          >
            {String(resolvedValue)}
            <span className="text-2xs opacity-70">
              (set in {source.type.charAt(0).toUpperCase() + source.type.slice(1)} {source.name})
            </span>
          </span>
        ) : (
          // Not set anywhere
          <span className="text-xs text-slate-500 italic">Not set</span>
        )}
      </div>
    </div>
  )
}

export function EntitySettingsDialog({ entityId, entityType, entityName, onClose }: Props) {
  const [settings, setSettings] = useState<ResolvedSettings | null>(null)
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([])
  const [loading, setLoading] = useState(true)

  // Fetch resolved settings
  useEffect(() => {
    const typeMap: Record<string, string> = { initiative: 'initiatives', epic: 'epics', task: 'tasks' }
    const endpoint = typeMap[entityType]
    if (!endpoint) return

    Promise.all([
      fetch(`/api/${endpoint}/${entityId}/settings`).then(r => r.json()),
      fetch('/api/projects').then(r => r.json()),
    ]).then(([settingsRes, projectsRes]) => {
      if (settingsRes.ok) setSettings(settingsRes.data)
      if (Array.isArray(projectsRes)) setProjects(projectsRes)
      setLoading(false)
    })
  }, [entityId, entityType])

  const patchSettings = useCallback(async (patch: Record<string, unknown>) => {
    const typeMap: Record<string, string> = { initiative: 'initiatives', epic: 'epics', task: 'tasks' }
    const endpoint = typeMap[entityType]
    if (!endpoint) return

    await fetch(`/api/${endpoint}/${entityId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: patch }),
    })

    // Refetch resolved settings
    const res = await fetch(`/api/${endpoint}/${entityId}/settings`)
    const data = await res.json()
    if (data.ok) setSettings(data.data)
  }, [entityId, entityType])

  const handleToggle = useCallback((key: keyof EntitySettings, enabled: boolean) => {
    if (enabled) {
      // Copy inherited value as starting local value, or use a default
      const inherited = settings?.resolved[key]
      const defaults: Record<keyof EntitySettings, unknown> = {
        project: inherited ?? '',
        backend: inherited ?? 'tmux',
        worktree: inherited ?? 'none',
        skipPermissions: inherited ?? false,
        profile: inherited ?? '',
      }
      patchSettings({ [key]: defaults[key] })
    } else {
      // Clear local override
      patchSettings({ [key]: null })
    }
  }, [settings, patchSettings])

  const handleValueChange = useCallback((key: keyof EntitySettings, value: EntitySettings[keyof EntitySettings]) => {
    patchSettings({ [key]: value })
  }, [patchSettings])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div
        className="bg-surface-panel border border-primary/20 rounded-lg shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        data-testid="entity-settings-dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/10">
          <div>
            <h2 className="text-sm font-display text-primary">{entityName} Settings</h2>
            <p className="text-2xs text-slate-500 mt-0.5">
              {entityType.charAt(0).toUpperCase() + entityType.slice(1)} settings with closest-ancestor inheritance
            </p>
          </div>
          <button
            className="text-slate-500 hover:text-slate-300"
            onClick={onClose}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          {loading || !settings ? (
            <div className="text-xs text-slate-500 py-4 text-center">Loading...</div>
          ) : (
            <div className="space-y-1">
              <SettingRow
                label="Project"
                settingKey="project"
                resolved={settings}
                onToggle={handleToggle}
                onValueChange={handleValueChange}
              >
                {(value, onChange) => (
                  <select
                    className="bg-surface-base border border-primary/30 rounded px-2 py-1 text-xs text-primary outline-none"
                    value={String(value ?? '')}
                    onChange={(e) => onChange(e.target.value || undefined)}
                  >
                    <option value="">Select project...</option>
                    {projects.map(p => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                )}
              </SettingRow>

              <SettingRow
                label="Backend"
                settingKey="backend"
                resolved={settings}
                onToggle={handleToggle}
                onValueChange={handleValueChange}
              >
                {(value, onChange) => (
                  <div className="flex gap-1">
                    {(['docker', 'tmux'] as const).map(opt => (
                      <button
                        key={opt}
                        className={`px-2 py-1 text-xs rounded border ${
                          value === opt
                            ? 'bg-primary/20 border-primary/40 text-primary'
                            : 'bg-surface-base border-white/10 text-slate-400 hover:border-primary/20'
                        }`}
                        onClick={() => onChange(opt)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              </SettingRow>

              <SettingRow
                label="Worktree"
                settingKey="worktree"
                resolved={settings}
                onToggle={handleToggle}
                onValueChange={handleValueChange}
              >
                {(value, onChange) => (
                  <div className="flex gap-1">
                    {(['none', 'new', 'existing'] as const).map(opt => (
                      <button
                        key={opt}
                        className={`px-2 py-1 text-xs rounded border ${
                          value === opt
                            ? 'bg-primary/20 border-primary/40 text-primary'
                            : 'bg-surface-base border-white/10 text-slate-400 hover:border-primary/20'
                        }`}
                        onClick={() => onChange(opt)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              </SettingRow>

              <SettingRow
                label="Skip Perms"
                settingKey="skipPermissions"
                resolved={settings}
                onToggle={handleToggle}
                onValueChange={handleValueChange}
              >
                {(value, onChange) => (
                  <button
                    className={`px-2 py-1 text-xs rounded border ${
                      value
                        ? 'bg-primary/20 border-primary/40 text-primary'
                        : 'bg-surface-base border-white/10 text-slate-400'
                    }`}
                    onClick={() => onChange(!value)}
                  >
                    {value ? 'Yes' : 'No'}
                  </button>
                )}
              </SettingRow>

              <SettingRow
                label="Profile"
                settingKey="profile"
                resolved={settings}
                onToggle={handleToggle}
                onValueChange={handleValueChange}
              >
                {(value, onChange) => (
                  <input
                    className="bg-surface-base border border-primary/30 rounded px-2 py-1 text-xs text-primary outline-none w-full"
                    value={String(value ?? '')}
                    onChange={(e) => onChange(e.target.value || undefined)}
                    placeholder="Docker image..."
                  />
                )}
              </SettingRow>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
