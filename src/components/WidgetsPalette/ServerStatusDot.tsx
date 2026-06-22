import { useState } from 'react'
import { apiFetch } from '../../apiClient'

export interface ServerStatusDotProps {
  pluginId: string
  displayName: string
  status: 'up' | 'down' | 'unknown'
  startable: boolean
  /** 'server' = plugin-declared server block (Start/View-log popover);
   *  'nats' = the Saloon's host NATS broker light (informational popover). */
  kind?: 'server' | 'nats'
  onStart: (pluginId: string) => void
}

const COLOR: Record<ServerStatusDotProps['status'], string> = {
  up: 'bg-emerald-400',
  down: 'bg-red-400',
  unknown: 'bg-amber-400 animate-pulse',
}

const LABEL: Record<'server' | 'nats', Record<ServerStatusDotProps['status'], string>> = {
  server: { up: 'Server up', down: 'Server down', unknown: 'Checking…' },
  nats: { up: 'NATS broker up', down: 'NATS broker down', unknown: 'Checking NATS…' },
}

export function ServerStatusDot({ pluginId, displayName, status, startable, kind = 'server', onStart }: ServerStatusDotProps) {
  const label = LABEL[kind][status]
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<string | null>(null)

  const viewLog = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const r = await apiFetch(`/api/plugin-servers/${encodeURIComponent(pluginId)}/log`)
      const j = (await r.json()) as { ok: boolean; data?: { log: string } }
      if (!r.ok || !j.ok) { setLog('(failed to read log)'); return }
      setLog(j.data?.log || '(log empty)')
    } catch { setLog('(failed to read log)') }
  }

  return (
    // draggable=false + stopPropagation so a press-drag starting on the dot never
    // bleeds into the palette tile's native HTML5 drag (which would spawn the widget).
    <div
      className="absolute top-1 left-1 z-10"
      draggable={false}
      onDragStart={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        data-testid={`server-status-dot-${pluginId}`}
        data-status={status}
        title={label}
        aria-label={`${displayName}: ${label}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className={`block h-2.5 w-2.5 rounded-full ring-1 ring-black/30 ${COLOR[status]}`}
      />
      {open && (
        <div
          className="absolute left-0 top-3.5 z-20 w-52 rounded-md border border-white/10 bg-surface-raised p-2 text-left shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-1 text-2xs font-medium text-slate-200">{displayName} — {label}</div>
          {kind === 'nats' ? (
            <div className="text-2xs text-slate-400">
              {status === 'up'
                ? 'Host NATS observer is connected to the broker.'
                : 'Host NATS observer is not connected. Open a Saloon to reconnect, or check the broker.'}
            </div>
          ) : (
            <>
              {status === 'down' && startable && (
                <button
                  type="button"
                  data-testid={`server-status-start-${pluginId}`}
                  onClick={(e) => { e.stopPropagation(); onStart(pluginId); setOpen(false) }}
                  className="w-full rounded bg-primary/20 px-2 py-1 text-2xs text-primary hover:bg-primary/30"
                >
                  Start server
                </button>
              )}
              {status === 'down' && !startable && (
                <div className="text-2xs text-slate-400">No start command declared. Start it manually.</div>
              )}
              <button
                type="button"
                onClick={viewLog}
                className="mt-1 w-full text-left text-[10px] text-slate-400 underline hover:text-slate-200"
              >
                View log
              </button>
              {log !== null && (
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-1 text-[10px] text-slate-300">{log}</pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
