import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { sortReviews, resolveRepoPath, applyOptimisticAction, type Review, type ReviewAction } from './reviews'

interface WidgetData { sessionId?: string; repoPath?: string }

export function makeCockpitAccessory(api: TinstarPluginAPI): ComponentType {
  return function CockpitAccessory() {
    const { sessionId } = api.primitives.useTerminal()
    const [data, setData] = api.widget.useData<WidgetData>()
    const [reviews, setReviews] = useState<Review[]>([])
    const [repoPath, setRepoPath] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const creatingRef = useRef(false)

    // --- Session bootstrap: create a roborev-tui session if this widget has none.
    useEffect(() => {
      const snapshot = data
      if (sessionId || snapshot?.sessionId || creatingRef.current) return
      creatingRef.current = true
      ;(async () => {
        try {
          const stateRes = await api.http.fetch('/api/state')
          const state = (await stateRes.json()) as { runs?: Record<string, { id: string; worktree?: string; repo?: string }> }
          const firstRun = state.runs ? Object.values(state.runs)[0] : undefined
          const worktreePath = snapshot?.repoPath || firstRun?.worktree || firstRun?.repo
          if (!worktreePath) { setError('No repo available to launch roborev in'); return }
          const res = await api.http.fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `roborev-cockpit-${worktreePath.split('/').pop()}`, worktreePath, cliTemplate: 'roborev-tui' }),
          })
          const body = await res.json()
          if (body?.ok && body.data?.id) setData({ ...(snapshot ?? {}), sessionId: body.data.id, repoPath: worktreePath })
          else setError(body?.error?.message ?? 'Failed to create roborev session')
        } catch (e) {
          setError((e as Error).message)
        }
      })()
    }, [sessionId, data, setData])

    const activeSession = sessionId || data?.sessionId || ''

    // --- Resolve the repo path from host state once we have a session.
    useEffect(() => {
      if (!activeSession) return
      let cancelled = false
      ;(async () => {
        const res = await api.http.fetch('/api/state')
        const state = await res.json()
        if (!cancelled) setRepoPath(resolveRepoPath(state, activeSession, data?.repoPath))
      })()
      return () => { cancelled = true }
    }, [activeSession, data?.repoPath])

    // --- Fetch the review list (scoped to repoPath).
    const refetch = useCallback(async () => {
      if (!repoPath) return
      try {
        const res = await api.http.fetch(`/api/roborev/reviews?repo=${encodeURIComponent(repoPath)}`)
        const body = await res.json()
        if (body?.ok) { setReviews(sortReviews(body.data as Review[])); setError(null) }
        else setError(body?.error?.message ?? 'Failed to load reviews')
      } catch (e) {
        setError((e as Error).message)
      }
    }, [repoPath])

    useEffect(() => { void refetch() }, [refetch])

    // --- Live: any roborev_stream event = "state changed, refetch".
    useEffect(() => {
      const sub = api.events.subscribe('roborev_stream', () => { void refetch() })
      return () => sub.dispose()
    }, [refetch])

    const act = useCallback(async (jobId: number, action: ReviewAction, message?: string) => {
      setReviews((cur) => applyOptimisticAction(cur, jobId, action))
      try {
        const res = await api.http.fetch('/api/roborev/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: repoPath, jobId, action, message }),
        })
        const body = await res.json()
        if (!body?.ok) setError(body?.error?.message ?? 'Action failed')
      } catch (e) {
        setError((e as Error).message)
      } finally {
        void refetch()
      }
    }, [repoPath, refetch])

    if (!activeSession) return <Pane>{error ? <Err msg={error} /> : <Muted>Starting roborev…</Muted>}</Pane>
    if (!repoPath) return <Pane><Muted>Resolving repo…</Muted></Pane>

    const open = reviews.filter((r) => !r.closed).length
    return (
      <Pane>
        <div style={{ fontSize: 11, color: '#94a3b8', padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          ● {open} open · {repoPath.split('/').pop()}
        </div>
        {error && <Err msg={error} />}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {reviews.map((r) => (
            <ReviewRow key={r.id} r={r}
              onClose={() => act(r.id, r.closed ? 'reopen' : 'close')}
              onComment={() => { const m = window.prompt('Comment:'); if (m) void act(r.id, 'comment', m) }} />
          ))}
          {reviews.length === 0 && <Muted>No reviews for this branch.</Muted>}
        </div>
      </Pane>
    )
  }
}

function Pane({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0b1220' }}>{children}</div>
}
function Muted({ children }: { children: ReactNode }) {
  return <div style={{ padding: 8, fontSize: 12, color: '#64748b' }}>{children}</div>
}
function Err({ msg }: { msg: string }) {
  return <div style={{ padding: 8, fontSize: 11, color: '#f87171' }}>{msg}</div>
}

function ReviewRow({ r, onClose, onComment }: { r: Review; onClose: () => void; onComment: () => void }) {
  const dot = r.status === 'failed' ? '#f87171' : r.status === 'running' ? '#fbbf24' : r.status === 'queued' ? '#64748b' : '#34d399'
  const pass = r.verdict === 'P'
  return (
    <div style={{ padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.05)', opacity: r.closed ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#e2e8f0' }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, flexShrink: 0 }} />
        <span style={{ color: pass ? '#34d399' : '#f87171' }}>{r.verdict ?? '–'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.commit_subject}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <Btn onClick={onClose}>{r.closed ? 'reopen' : 'close'}</Btn>
        <Btn onClick={onComment}>comment</Btn>
      </div>
    </div>
  )
}
function Btn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button onClick={onClick} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#cbd5e1', cursor: 'pointer' }}>{children}</button>
}
