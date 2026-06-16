import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { parseReviewList, pickFleetSessions, fleetRow, fleetOpenTotal, type FleetRow } from './reviews'

const POLL_MS = 12_000

/**
 * Standalone roborev fleet overview: one row per agent session, showing the open
 * roborev findings in that session's worktree. Read-only prototype — it runs
 * `roborev list --open --json` in each worktree via the generic per-session exec
 * endpoint (no roborev-specific server route), so it stays a pure frontend plugin.
 */
export function makeFleetView(api: TinstarPluginAPI): ComponentType<WidgetProps> {
  return function FleetView() {
    const [rows, setRows] = useState<FleetRow[] | null>(null)
    const [loading, setLoading] = useState(false)
    const busyRef = useRef(false)

    const load = useCallback(async () => {
      if (busyRef.current) return
      busyRef.current = true
      setLoading(true)
      try {
        const state = (await (await api.http.fetch('/api/state')).json()) as Parameters<typeof pickFleetSessions>[0]
        const sessions = pickFleetSessions(state)
        const next = await Promise.all(sessions.map(async (s) => {
          try {
            const r = await api.http.fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/exec`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ argv: ['roborev', 'list', '--open', '--json'] }),
            })
            const j = (await r.json()) as { ok: boolean; data?: { stdout: string; code: number } }
            if (!j.ok || !j.data || j.data.code !== 0) return fleetRow(s, null)
            return fleetRow(s, parseReviewList(j.data.stdout))
          } catch {
            return fleetRow(s, null)
          }
        }))
        // Most backlog first; probe-failures (open=null) sink to the bottom.
        next.sort((a, b) => (b.open ?? -1) - (a.open ?? -1) || a.sessionId.localeCompare(b.sessionId))
        setRows(next)
      } catch {
        setRows([])
      } finally {
        busyRef.current = false
        setLoading(false)
      }
    }, [])

    useEffect(() => {
      void load()
      const t = setInterval(() => void load(), POLL_MS)
      return () => clearInterval(t)
    }, [load])

    const total = rows ? fleetOpenTotal(rows) : 0

    return (
      <Pane>
        <div className="widget-drag-handle" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', cursor: 'grab' }}>
          <span style={{ color: '#22d3ee', fontSize: 11, letterSpacing: 0.5 }}>ROBOREV FLEET</span>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>● {total} open</span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void load()}
            disabled={loading}
            title="Refresh"
            style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#cbd5e1', cursor: 'pointer' }}
          >
            {loading ? '…' : '⟳'}
          </button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {rows === null && <Muted>Scanning sessions…</Muted>}
          {rows && rows.length === 0 && <Muted>No agent sessions with a worktree.</Muted>}
          {rows && rows.map((r) => <RowView key={r.sessionId} r={r} />)}
        </div>
      </Pane>
    )
  }
}

function RowView({ r }: { r: FleetRow }) {
  const wt = r.worktree.split('/').filter(Boolean).pop() ?? r.worktree
  const probeFailed = r.open === null
  return (
    <div style={{ padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sessionId}</div>
        <div style={{ fontSize: 10, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.project ? `${r.project} · ` : ''}{wt}
        </div>
      </div>
      {probeFailed ? (
        <span style={{ fontSize: 10, color: '#64748b' }} title="roborev not available in this worktree">—</span>
      ) : (
        <span style={{ fontSize: 11, color: r.open ? '#e2e8f0' : '#64748b', flexShrink: 0 }}>
          {r.open} open{r.failed ? <span style={{ color: '#f87171' }}> · {r.failed} failed</span> : null}
        </span>
      )}
    </div>
  )
}

function Pane({ children }: { children: ReactNode }) { return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0b1220', color: '#cbd5e1' }}>{children}</div> }
function Muted({ children }: { children: ReactNode }) { return <div style={{ padding: 10, fontSize: 12, color: '#64748b' }}>{children}</div> }
