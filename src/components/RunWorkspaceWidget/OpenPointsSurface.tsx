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
import { RefreshButton } from './slateRefresh'
import { SurfaceAge } from './SurfaceAge'

/** The visible track stages, in order. `resolved` is terminal; `dismissed` is a
 *  side exit (rendered as a dimmed row, not a track position). */
const TRACK: Array<{ key: PointStatus; label: string }> = [
  { key: 'open', label: 'open' },
  { key: 'discussing', label: 'discuss' },
  { key: 'waiting', label: 'waiting' },
  { key: 'resolved', label: 'resolved' },
]

/** Lit-dot hue per stage, index-aligned with TRACK: each filled dot wears its own
 *  stage's hue (not a single accent), so the track reads as a colored lifecycle.
 *  Literal strings for the JIT. Unlit dots use `primary/12` (the faint resting rail). */
const TRACK_DOT_ON = ['bg-hue-open', 'bg-hue-discussing', 'bg-hue-waiting', 'bg-hue-resolved']

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

// One hue per meaning (design language): ~15% fill / ~30% border / bright hue text.
// Literal class strings (no interpolation) so Tailwind's JIT emits them.
const PILL_TONE: Record<PointStatus, string> = {
  open: 'bg-hue-open/15 border border-hue-open/30 text-hue-open',
  discussing: 'bg-hue-discussing/15 border border-hue-discussing/30 text-hue-discussing',
  waiting: 'bg-hue-waiting/15 border border-hue-waiting/30 text-hue-waiting',
  resolved: 'bg-hue-resolved/15 border border-hue-resolved/30 text-hue-resolved',
  dismissed: 'bg-hue-dismissed/20 border border-hue-dismissed/25 text-hue-dismissed',
}

// Author is meta, not meaning — a quiet mono label. The WORD distinguishes agent /
// user / process; color is reserved for status (P1, and P4 forbids the old cyan
// `process` badge — cyan is the live edge only).
const AUTHOR_TONE = 'bg-surface-hover text-ink-low'

const EMPTY_SET: ReadonlySet<string> = new Set()

/** A single point row. Holds its own optimistic resolve + answer form state, keyed
 *  per control-component id, so multiple choice groups on one body stay independent. */
function OpenPointRow({ runId, surface, hidden = false, onHide, onUnhide, refreshing = false, unreachable = false, onRefresh, now }: {
  runId: string
  surface: SlateSurface
  /** Slate v2 U2/R4 — this point is a hidden surface, rendered dimmed. */
  hidden?: boolean
  onHide?: (id: string) => void
  onUnhide?: (id: string) => void
  /** Slate v2 U3 — refresh state is owned by the parent SlatePanel and threaded
   *  down so a per-row ⟳ and the header "refresh all" share one source of truth. */
  refreshing?: boolean
  unreachable?: boolean
  onRefresh?: (surface: SlateSurface) => void
  /** Ticking clock from the panel — drives the row's "updated Xm ago" freshness. */
  now: number
}) {
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
    async (action: 'resolve' | 'reopen' | 'dismiss', nextStatus: PointStatus | null) => {
      if (busy) return
      setError(null)
      setBusy(true)
      const prev = optimisticStatus
      // `null` for reopen: the server re-derives status from the thread
      // (open/discussing/waiting), so we can't guess it here — an optimistic
      // 'open' would never match the derived value and the override would stick
      // forever. Let the SSE delta carry the real status instead.
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
    void lifecycle(resolved ? 'reopen' : 'resolve', resolved ? null : 'resolved')
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
      className={`rounded border border-hairline bg-surface-hover p-2.5 ${
        status === 'dismissed' || hidden ? 'opacity-50' : resolved ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        {/* Soft resolve: a checkbox, never the point's identity. */}
        <input
          type="checkbox"
          data-testid={`resolve-${surface.id}`}
          checked={resolved}
          disabled={busy}
          onChange={toggleResolve}
          title={resolved ? 'Reopen this point' : 'Resolve — the thread stays readable'}
          className="mt-0.5 shrink-0 accent-hue-resolved"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={`shrink-0 px-1 py-0.5 rounded-sm font-mono text-[9px] uppercase tracking-[0.1em] ${AUTHOR_TONE}`}
            >
              {surface.author}
            </span>
            <span
              data-testid={`pill-${surface.id}`}
              className={`shrink-0 px-1.5 py-0.5 rounded-sm font-mono text-[9px] font-semibold uppercase tracking-[0.1em] ${PILL_TONE[status]}`}
            >
              {status}
            </span>
            <span
              className={`flex-1 truncate text-[13px] font-medium leading-snug text-ink-high ${resolved ? 'line-through text-ink-low' : ''}`}
            >
              {surface.headline ?? '(untitled point)'}
            </span>
            {/* Refresh (⟳) — re-run this point's author (U3). Hidden on a hidden row
                (nothing to look at) but present on every visible one. */}
            {!hidden && onRefresh && (
              <RefreshButton
                id={surface.id}
                refreshing={refreshing}
                onClick={() => onRefresh(surface)}
                className="shrink-0 text-[11px]"
              />
            )}
            {/* Hide (✕) / unhide — a per-browser view preference (R4), never a
                destructive delete; the point stays in the agent's file. */}
            {hidden ? (
              <button
                data-testid={`unhide-surface-${surface.id}`}
                onClick={() => onUnhide?.(surface.id)}
                title="Unhide this point"
                className="shrink-0 rounded-sm bg-surface-raised px-1 text-[9px] text-ink-low hover:text-ink-high"
              >
                unhide
              </button>
            ) : (
              <button
                data-testid={`hide-surface-${surface.id}`}
                onClick={() => onHide?.(surface.id)}
                title="Hide this point (view-only — the file stays intact)"
                className="shrink-0 rounded-sm px-1 text-[11px] leading-none text-ink-ctrl hover:text-ink-high"
              >
                ✕
              </button>
            )}
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
              // Each lit dot wears its OWN stage's hue; unlit dots are the faint rail.
              return (
                <span key={seg.key} className="flex items-center gap-0.5">
                  <span
                    data-active={on ? 'true' : undefined}
                    className={`h-1.5 w-1.5 rounded-full ${on ? TRACK_DOT_ON[i] : 'bg-primary/12'}`}
                  />
                  <span className={`font-mono text-[8px] ${on ? 'text-ink-mid' : 'text-ink-ctrl'}`}>
                    {seg.label}
                  </span>
                  {i < TRACK.length - 1 && <span className="text-[8px] text-ink-ctrl">›</span>}
                </span>
              )
            })}
          </div>

          {/* Interactive body (R13): rendered through the shared A2uiRenderer with
              a form so declared controls read/write host-owned state keyed per
              control-component id. A read-only body renders as static prose. */}
          {surface.body && (
            <div className="mt-2 text-[13px] text-ink-mid">
              <A2uiRenderer content={surface.body} form={interactive ? form : undefined} />
            </div>
          )}

          {/* Thread — collapsed by default; the reply input lives inside it. */}
          <button
            data-testid={`thread-toggle-${surface.id}`}
            onClick={() => setExpanded((o) => !o)}
            className="mt-2 flex items-center gap-1 font-mono text-[10px] text-ink-low hover:text-ink-mid"
          >
            <span>{expanded ? '▾' : '▸'}</span>
            <span>Thread</span>
            {threadCount > 0 && <span className="text-ink-ctrl">· {threadCount}</span>}
          </button>
          {expanded && (
            <div className="mt-1">
              <SurfaceThread runId={runId} pointId={surface.id} thread={surface.thread} />
            </div>
          )}

          {unreachable && (
            <div data-testid={`refresh-unreachable-${surface.id}`} className="mt-2 text-[11px] leading-snug text-ink-low">
              Sent — but that session isn’t reachable right now.
            </div>
          )}
          {error && <div className="mt-1 text-[11px] text-hue-error">{error}</div>}
          {/* Freshness: "updated Xm ago", ambering when the point has gone untended. */}
          <div className="mt-1 flex justify-end">
            <SurfaceAge amendedAt={surface.amendedAt} now={now} />
          </div>
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
          className="flex-1 rounded border border-hairline bg-surface-panel px-2 py-1 text-[12px] text-ink-high placeholder:text-ink-low focus:border-primary/60 focus:outline-none disabled:opacity-70"
        />
        <button
          data-testid="add-point-send"
          onClick={() => void add()}
          disabled={busy}
          className="rounded bg-surface-hover px-2 py-1 text-[12px] text-ink-mid hover:text-ink-high hover:bg-surface-raised disabled:opacity-50"
        >
          {busy ? '…' : 'Add'}
        </button>
      </div>
      {error && <div className="text-[11px] text-hue-error">{error}</div>}
    </div>
  )
}

interface Props {
  runId: string
  /** Every `kind === 'open-point'` surface on the run, already sorted. */
  points: SlateSurface[]
  /** Slate v2 U2/R4 — ids of hidden surfaces. Hidden points are excluded unless
   *  `showHidden` is set, in which case they render dimmed with an "unhide". */
  hiddenIds?: ReadonlySet<string>
  showHidden?: boolean
  onHide?: (id: string) => void
  onUnhide?: (id: string) => void
  /** Slate v2 U3 — refresh state owned by the parent SlatePanel. */
  refreshingIds?: ReadonlySet<string>
  unreachableIds?: ReadonlySet<string>
  onRefresh?: (surface: SlateSurface) => void
  /** Ticking clock from the panel — threaded to each row's freshness footer.
   *  Optional so tests/standalone callers render without wiring a clock. */
  now?: number
}

const EMPTY_HIDDEN: ReadonlySet<string> = new Set()

export function OpenPointsSurface({ runId, points, hiddenIds = EMPTY_HIDDEN, showHidden = false, onHide, onUnhide, refreshingIds = EMPTY_HIDDEN, unreachableIds = EMPTY_HIDDEN, onRefresh, now = Date.now() }: Props) {
  // Points sink once resolved/dismissed so the live ones stay at the top; hidden
  // ones are dropped unless the reveal toggle is on (R4 — the filter runs every
  // render so an SSE re-projection can't resurrect a hidden point).
  const ordered = useMemo(() => {
    const rank = (s: SlateSurface) => (s.status === 'resolved' || s.status === 'dismissed' ? 1 : 0)
    return [...points]
      .filter((s) => showHidden || !hiddenIds.has(s.id))
      .sort((a, b) => rank(a) - rank(b))
  }, [points, hiddenIds, showHidden])

  return (
    <div
      data-testid="open-points-surface"
      className="rounded border border-hairline bg-surface-raised p-[14px] space-y-2"
    >
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-low">Open points</div>
      {ordered.map((surface) => (
        <OpenPointRow
          key={surface.id}
          runId={runId}
          surface={surface}
          hidden={hiddenIds.has(surface.id)}
          onHide={onHide}
          onUnhide={onUnhide}
          refreshing={refreshingIds.has(surface.id)}
          unreachable={unreachableIds.has(surface.id)}
          onRefresh={onRefresh}
          now={now}
        />
      ))}
      <AddPoint runId={runId} />
    </div>
  )
}
