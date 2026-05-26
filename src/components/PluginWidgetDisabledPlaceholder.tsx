import { apiFetch } from '../apiClient'
import type { PluginWidgetInstance } from '../domain/types'

interface Props {
  instance: PluginWidgetInstance
  reason: 'disabled' | 'uninstalled' | 'unknown-type'
}

export function PluginWidgetDisabledPlaceholder({ instance, reason }: Props) {
  const message =
    reason === 'disabled'     ? `${instance.pluginId} is disabled.`
    : reason === 'uninstalled' ? `${instance.pluginId} is no longer installed.`
    :                            `Widget type "${instance.widgetType}" is not registered.`

  return (
    <div
      data-testid={`plugin-widget-disabled-${instance.id}`}
      style={{
        padding: 12, fontSize: 12, color: '#fca5a5',
        background: '#7f1d1d', borderRadius: 4,
        height: '100%', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div>{message}</div>
      <div style={{ opacity: 0.75, fontSize: 11 }}>
        Enable in Settings → Plugins, or remove this widget.
      </div>
      <button
        onClick={() => apiFetch(`/api/plugin-widgets/${instance.id}`, { method: 'DELETE' })}
        style={{
          alignSelf: 'flex-start',
          background: '#1f2937', color: '#e5e7eb',
          border: '1px solid #374151', padding: '4px 10px',
          borderRadius: 4, cursor: 'pointer', fontSize: 12,
        }}
      >
        Remove widget
      </button>
    </div>
  )
}
