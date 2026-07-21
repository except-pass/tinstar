// The open-points hero surface (plan U6, R13/R16). Store-backed points — whether
// authored by the agent, the user, or a process — share ONE list. Each row shows:
//   · an author badge and a status pill,
//   · a visual STATE TRACK (open → discuss → waiting → resolved) so the point's
//     lifecycle reads at a glance,
//   · an expandable THREAD (SurfaceThread) with a reply input,
//   · a soft RESOLVE checkbox (the resolve affordance is NOT the point's identity —
//     resolving keeps the thread readable), and
//   · an interactive body (Choice/TextInput/Submit) when the file declares controls,
//     rendered through the shared control components with form state keyed per
//     control-component id (R13); a Submit routes to the answer endpoint.
// A single ADD-A-POINT input at the foot lets the user open a new point.
//
// Optimistic UI throughout (modelled on RoundupWidget): resolve flips the track
// immediately and reverts on failure; a new point appears at once and reconciles
// when the SSE `run` delta carries it on run.slate (run.slate IS the channel — no
// second subscription).
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SlateSurface, PointStatus } from '../../types'
import { A2uiRenderer } from '../../a2ui/A2uiRenderer'
import { isAnswerable } from '../../a2ui/controls'
import type { NoticeFormState } from '../../a2ui/controlComponents'
import { apiFetch } from '../../apiClient'
import { SurfaceThread } from './SurfaceThread'

/** The visible track stages, in order. `resolved` is terminal; `dismissed` is a
 *  side exit (rendered as a dimmed row, not a track position). */
const TRACK: Array<{ key: PointStatus; label: string }> = [
  { key: 'open', label: 'open' },
  { key: 'discussing', label: 'discuss' },
  { key: 'waiting', label: 'waiting' },
  { key: 'resolved', label: 'resolved' },
]

/** Which track index a status lights up to. `dismissed` returns -1 (off-track). */
function stageOf(status: PointStatus | undefined): number {
  switch (status) {
    case 'discussing':
      return 1
    case 'waiting':
      return 2
    case 'resolved':
      return 3
    case 'dismissed':
      return -1
    case 'open':
    default:
      return 0
  }
}

const PILL_TONE: Record<PointStatus, string> = {
  open: 'bg-indigo-500/20 text-indigo-300',
  discussing: 'bg-amber-500/20 text-amber-300',
  waiting: 'bg-sky-500/20 text-sky-300',
  resolved: 'bg-emerald-500/20 text-emerald-300',
  dismissed: 'bg-slate-600/30 text-slate-400',
}

const AUTHOR_TONE: Record<SlateSurface['author'], string> = {
  agent: 'bg-amber-500/15 text-amber-300',
  user: 'bg-slate-500/20 text-slate-300',
  process: 'bg-cyan-500/15 text-cyan-300',
}

const EMPTY_SET: ReadonlySet<string> = new Set()

/** A single point row. Holds its own optimistic resolve + answer form state, keyed
 *  per control-component id, so multiple choice groups on one body stay independent. */
function OpenPointRow({ runId, surface }: { runId: string; surface: SlateSurface }) {
  const [expanded, setExpanded] = useState(false)
  // Optimistic status override (null = trust the server value). Cleared only once
  // the reconciled surface actually carries the new status — NOT by watching
  // surface.status directly, which an SSE delta racing the response can echo back
  // unchanged, leaving the row stuck optimistic.
  const [optimisticStatus, setOptimisticStatus] = useState<PointStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Answer form (only wired when the body declares controls).
  const [selected, setSelected] = useState<Map<string, Set<string>>>(new Map())
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [optimisticAnswered, setOptimisticAnswered] = useState(false)

  useEffect(() => {
    if (optimisticStatus === null) return
    if (surface.status === optimisticStatus) setOptimisticStatus(null)
  }, [surface.status, optimisticStatus])

  const status = optimisticStatus ?? surface.status ?? 'open'
  const stage = stageOf(status)
  const resolved = status === 'resolved'
  const interactive = isAnswerable(surface.body)

  const lifecycle = useCallback(
    async (action: 'resolve' | 'reopen' | 'dismiss', nextStatus: PointStatus) => {
      if (busy) return
      setError(null)
      setBusy(true)
      const prev = optimisticStatus
      setOptimisticStatus(nextStatus)
      try {
        const res = await apiFetch(`/api/runs/${runId}/slate/points/${surface.id}/${action}`, {
          method: 'POST',
        })
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: { message?: string } }
          | null
        if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `${action} failed (${res.status})`)
        // Success: the SSE run delta reconciles the status; keep the optimistic
        // value until then so the track doesn't flicker back.
      } catch {
        setOptimisticStatus(prev) // revert to the pre-click override (usually null)
        setError(`Could not ${action} this point.`)
      } finally {
        setBusy(false)
      }
    },
    [busy, runId, surface.id, optimisticStatus],
  )

  const toggleResolve = useCallback(() => {
    void lifecycle(resolved ? 'reopen' : 'resolve', resolved ? 'open' : 'resolved')
  }, [resolved, lifecycle])

  const toggleOption = useCallback((choiceId: string, optionId: string, mode: 'single' | 'multi') => {
    setSelected((prev) => {
      const next = new Map(prev)
      const group = new Set(prev.get(choiceId) ?? [])
      if (mode === 'single') {
        next.set(choiceId, new Set([optionId]))
      } else {
        if (group.has(optionId)) group.delete(optionId)
        else group.add(optionId)
        next.set(choiceId, group)
      }
      return next
    })
  }, [])

  const selectedFor = useCallback(
    (choiceId: string): ReadonlySet<string> => selected.get(choiceId) ?? EMPTY_SET,
    [selected],
  )

  const submitAnswer = useCallback(async () => {
    if (submitting || optimisticAnswered) return
    const choices = [...new Set([...selected.values()].flatMap((g) => [...g]))]
    const trimmed = text.trim()
    if (choices.length === 0 && !trimmed) {
      setError('Pick an option or add a note before submitting.')
      return
    }
    setError(null)
    setSubmitting(true)
    setOptimisticAnswered(true)
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/points/${surface.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(choices.length ? { choices } : {}),
          ...(trimmed ? { text: trimmed } : {}),
        }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `answer failed (${res.status})`)
      // The answer persists as a thread reply and arrives on the next run delta.
    } catch {
      setOptimisticAnswered(false)
      setError('Could not deliver your answer. Try again.')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, optimisticAnswered, selected, text, runId, surface.id])

  const form: NoticeFormState = {
    interactive: true,
    answered: optimisticAnswered,
    submitting,
    selectedFor,
    text,
    toggleOption,
    setText,
    submit: submitAnswer,
  }

  const threadCount = surface.thread?.length ?? 0

  return (
    <div
      data-testid={`point-${surface.id}`}
      data-status={status}
      className={`rounded border border-primary/10 bg-surface-base/40 p-2 ${
        status === 'dismissed' ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-start gap-1.5">
        {/* Soft resolve: a checkbox, never the point's identity. */}
        <input
          type="checkbox"
          data-testid={`resolve-${surface.id}`}
          checked={resolved}
          disabled={busy}
          onChange={toggleResolve}
          title={resolved ? 'Reopen this point' : 'Resolve — the thread stays readable'}
          className="mt-0.5 shrink-0 accent-emerald-500"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={`shrink-0 px-1 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${AUTHOR_TONE[surface.author]}`}
            >
              {surface.author}
            </span>
            <span
              data-testid={`pill-${surface.id}`}
              className={`shrink-0 px-1 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide ${PILL_TONE[status]}`}
            >
              {status}
            </span>
            <span
              className={`flex-1 truncate text-xs font-medium leading-snug text-slate-200 ${resolved ? 'line-through text-slate-400' : ''}`}
            >
              {surface.headline ?? '(untitled point)'}
            </span>
          </div>

          {/* State track: open → discuss → waiting → resolved. `data-stage` is the
              lit index so a test can assert the derived/terminal state directly. */}
          <div
            data-testid={`track-${surface.id}`}
            data-stage={stage}
            className="mt-1 flex items-center gap-0.5"
          >
            {TRACK.map((seg, i) => {
              const on = stage >= i && stage >= 0
              const terminal = resolved && i === TRACK.length - 1
              return (
                <span key={seg.key} className="flex items-center gap-0.5">
                  <span
                    data-active={on ? 'true' : undefined}
                    className={`h-1.5 w-1.5 rounded-full ${
                      terminal
                        ? 'bg-emerald-400'
                        : on
                          ? 'bg-indigo-400'
                          : 'bg-primary/15'
                    }`}
                  />
                  <span className={`text-[8px] ${on ? 'text-slate-400' : 'text-slate-600'}`}>
                    {seg.label}
                  </span>
                  {i < TRACK.length - 1 && <span className="text-[8px] text-slate-600">›</span>}
                </span>
              )
            })}
          </div>

          {/* Interactive body (R13): rendered through the shared A2uiRenderer with
              a form so declared controls read/write host-owned state keyed per
              control-component id. A read-only body renders as static prose. */}
          {surface.body && (
            <div className="mt-1.5 text-xs text-slate-200">
              <A2uiRenderer content={surface.body} form={interactive ? form : undefined} />
            </div>
          )}

          {/* Thread — collapsed by default; the reply input lives inside it. */}
          <button
            data-testid={`thread-toggle-${surface.id}`}
            onClick={() => setExpanded((o) => !o)}
            className="mt-1.5 flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300"
          >
            <span>{expanded ? '▾' : '▸'}</span>
            <span>Thread</span>
            {threadCount > 0 && <span className="text-slate-600">· {threadCount}</span>}
          </button>
          {expanded && (
            <div className="mt-1">
              <SurfaceThread runId={runId} pointId={surface.id} thread={surface.thread} />
            </div>
          )}

          {error && <div className="mt-1 text-2xs text-red-300">{error}</div>}
        </div>
      </div>
    </div>
  )
}

/** The add-a-point input: opens a fresh user point via POST …/slate/points. On
 *  success the input clears and the SSE run delta brings the new point into the
 *  list; a failure keeps the text so nothing is lost. */
function AddPoint({ runId }: { runId: string }) {
  const [headline, setHeadline] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = useCallback(async () => {
    const text = headline.trim()
    if (!text || busy) return
    setError(null)
    setBusy(true)
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headline: text }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `add failed (${res.status})`)
      setHeadline('') // reconcile via the SSE run delta
    } catch {
      setError('Could not add your point. Try again.')
    } finally {
      setBusy(false)
    }
  }, [headline, busy, runId])

  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex items-center gap-1">
        <input
          data-testid="add-point-input"
          value={headline}
          placeholder="Add a point…"
          disabled={busy}
          onChange={(e) => setHeadline(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
          }}
          className="flex-1 rounded border border-primary/20 bg-surface-base px-2 py-0.5 text-2xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-70"
        />
        <button
          data-testid="add-point-send"
          onClick={() => void add()}
          disabled={busy}
          className="rounded bg-surface-hover px-2 py-0.5 text-2xs text-slate-200 hover:bg-primary/20 disabled:opacity-50"
        >
          {busy ? '…' : 'Add'}
        </button>
      </div>
      {error && <div className="text-2xs text-red-300">{error}</div>}
    </div>
  )
}

interface Props {
  runId: string
  /** Every `kind === 'open-point'` surface on the run, already sorted. */
  points: SlateSurface[]
}

export function OpenPointsSurface({ runId, points }: Props) {
  // Points sink once resolved/dismissed so the live ones stay at the top.
  const ordered = useMemo(() => {
    const rank = (s: SlateSurface) => (s.status === 'resolved' || s.status === 'dismissed' ? 1 : 0)
    return [...points].sort((a, b) => rank(a) - rank(b))
  }, [points])

  return (
    <div
      data-testid="open-points-surface"
      className="rounded border border-primary/10 bg-surface-base/40 p-2 space-y-1.5"
    >
      <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500">Open points</div>
      {ordered.map((surface) => (
        <OpenPointRow key={surface.id} runId={runId} surface={surface} />
      ))}
      <AddPoint runId={runId} />
    </div>
  )
}
