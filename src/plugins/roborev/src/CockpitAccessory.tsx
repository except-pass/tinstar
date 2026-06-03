import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { parseReviewList, sortReviews, applyOptimisticAction, actionArgv, pickBootstrapSource, type Review, type ReviewAction } from './reviews'

interface WidgetData { sessionId?: string; launched?: boolean }
const POLL_MS = 4000

// Module-level guards survive StrictMode remounts; keyed by widget nodeId.
const creatingSessions = new Set<string>()
const launchedSessions = new Set<string>()

export function makeCockpitAccessory(api: TinstarPluginAPI): ComponentType {
  return function CockpitAccessory() {
    const term = api.primitives.useTerminal()
    const [data, setData] = api.widget.useData<WidgetData>()
    const [reviews, setReviews] = useState<Review[]>([])
    const [error, setError] = useState<string | null>(null)
    const sessionId = term.sessionId || data?.sessionId || ''
    const nodeId = api.constellations.useMyNodeId()
    const dataRef = useRef(data)
    dataRef.current = data

    // 1. Bootstrap: create a shell session in an active worktree if we have none.
    useEffect(() => {
      if (sessionId || dataRef.current?.sessionId || creatingSessions.has(nodeId)) return
      creatingSessions.add(nodeId)
      ;(async () => {
        try {
          const raw = await (await api.http.fetch('/api/state')).json()
          const state = raw?.data ?? raw
          const src = pickBootstrapSource(state)
          if (!src) { setError('No active repo session to base the cockpit on'); creatingSessions.delete(nodeId); return }
          const res = await api.http.fetch('/api/sessions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `roborev-cockpit-${src.worktreePath.split('/').pop()}`, project: src.project, worktreePath: src.worktreePath, cliTemplate: 'shell' }),
          })
          const body = await res.json()
          if (body?.ok && body.data?.id) setData({ ...(dataRef.current ?? {}), sessionId: body.data.id })
          else { setError(body?.error?.message ?? 'Failed to create session'); creatingSessions.delete(nodeId) }
        } catch (e) { setError((e as Error).message); creatingSessions.delete(nodeId) }
      })()
    }, [sessionId, nodeId, setData])

    // 2. Launch roborev tui into the session once (pty buffers input; no readiness wait).
    useEffect(() => {
      if (!sessionId || dataRef.current?.launched || launchedSessions.has(nodeId)) return
      launchedSessions.add(nodeId)
      term.sendText('roborev tui --repo --branch --no-quit', { enter: true })
        .then(() => setData({ ...(dataRef.current ?? {}), sessionId, launched: true }))
        .catch((e) => { setError((e as Error).message); launchedSessions.delete(nodeId) })
    }, [sessionId, nodeId, setData, term])

    // 3. Poll review data via exec (runs in the session's worktree → branch-scoped).
    const refetch = useCallback(async () => {
      if (!sessionId) return
      try {
        const { stdout, code } = await term.exec(['roborev', 'list', '--json'])
        if (code !== 0) { setError('roborev list failed'); return }
        setReviews(sortReviews(parseReviewList(stdout))); setError(null)
      } catch (e) { setError((e as Error).message) }
    }, [sessionId, term])

    useEffect(() => {
      if (!sessionId) return
      void refetch()
      const t = setInterval(() => void refetch(), POLL_MS)
      return () => clearInterval(t)
    }, [sessionId, refetch])

    const act = useCallback(async (jobId: number, action: ReviewAction, message?: string) => {
      setReviews((cur) => applyOptimisticAction(cur, jobId, action))
      try {
        const { code } = await term.exec(actionArgv(jobId, action, message))
        if (code !== 0) setError(`roborev ${action} failed`)
      } catch (e) { setError((e as Error).message) } finally { void refetch() }
    }, [term, refetch])

    if (!sessionId) return <Pane>{error ? <Err msg={error} /> : <Muted>Starting roborev…</Muted>}</Pane>
    const open = reviews.filter((r) => !r.closed).length
    return (
      <Pane>
        <div style={{ fontSize: 11, color: '#94a3b8', padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>● {open} open</div>
        {error && <Err msg={error} />}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {reviews.map((r) => (
            <Row key={r.id} r={r}
              onClose={() => act(r.id, r.closed ? 'reopen' : 'close')}
              onComment={() => { const m = window.prompt('Comment:'); if (m) void act(r.id, 'comment', m) }} />
          ))}
          {reviews.length === 0 && <Muted>No reviews for this branch.</Muted>}
        </div>
      </Pane>
    )
  }
}

function Pane({ children }: { children: ReactNode }) { return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0b1220' }}>{children}</div> }
function Muted({ children }: { children: ReactNode }) { return <div style={{ padding: 8, fontSize: 12, color: '#64748b' }}>{children}</div> }
function Err({ msg }: { msg: string }) { return <div style={{ padding: 8, fontSize: 11, color: '#f87171' }}>{msg}</div> }

function Row({ r, onClose, onComment }: { r: Review; onClose: () => void; onComment: () => void }) {
  const dot = r.status === 'failed' ? '#f87171' : r.status === 'running' ? '#fbbf24' : r.status === 'queued' ? '#64748b' : '#34d399'
  return (
    <div style={{ padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.05)', opacity: r.closed ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#e2e8f0' }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, flexShrink: 0 }} />
        <span style={{ color: r.verdict === 'P' ? '#34d399' : '#f87171' }}>{r.verdict ?? '–'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.commit_subject}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <Btn onClick={onClose}>{r.closed ? 'reopen' : 'close'}</Btn>
        <Btn onClick={onComment}>comment</Btn>
      </div>
    </div>
  )
}
function Btn({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button onClick={onClick} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#cbd5e1', cursor: 'pointer' }}>{children}</button> }
