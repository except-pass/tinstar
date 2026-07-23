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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlateSurface, PointStatus } from '../../types'
import { A2uiRenderer } from '../../a2ui/A2uiRenderer'
import { isAnswerable } from '../../a2ui/controls'
import type { NoticeFormState } from '../../a2ui/controlComponents'
import { apiFetch } from '../../apiClient'
import { SurfaceThread } from './SurfaceThread'
import { RefreshButton } from './slateRefresh'
import { SurfaceAge } from './SurfaceAge'
import { FastPathBadge } from './FastPathBadge'
import { moveItem } from './reorderUtil'
import { usePointAnswerForm } from './usePointAnswerForm'
import { WorkbenchSurface, partitionWorkbenches } from './WorkbenchSurface'

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

/** The reorder affordance (S6 U2): a thumb-pad grip that reveals ▲/▼ to nudge the
 *  point one slot. NOT pointer-drag — native DnD is unreliable on the zoom/pan
 *  transformed canvas, and the chevrons reduce the interaction to pure index math
 *  (`moveItem`) that a unit test can drive directly. Ends of the list are disabled
 *  rather than hidden, so the row's shape doesn't jump as points move. */
function ReorderGrip({ id, canMoveUp, canMoveDown, onMove }: {
  id: string
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (id: string, delta: -1 | 1) => void
}) {
  return (
    <span data-testid={`reorder-grip-${id}`} className="flex shrink-0 items-center gap-0.5">
      {/* Thumb-pad glyph: the "you can move this" cue. Purely decorative — the
          chevrons do the work, so it isn't a focus target. */}
      <span aria-hidden className="select-none text-[11px] leading-none text-ink-ctrl">⠿</span>
      {/* aria-label, not just title: a button that already has text content takes
          its accessible name from that text, so without these a screen reader
          announces "black up-pointing triangle, button". */}
      <button
        data-testid={`reorder-up-${id}`}
        onClick={() => onMove(id, -1)}
        disabled={!canMoveUp}
        aria-label="Move this point up"
        title="Move this point up"
        className="rounded px-0.5 text-[9px] leading-none text-ink-ctrl hover:text-ink-high disabled:opacity-30 disabled:hover:text-ink-ctrl"
      >
        ▲
      </button>
      <button
        data-testid={`reorder-down-${id}`}
        onClick={() => onMove(id, 1)}
        disabled={!canMoveDown}
        aria-label="Move this point down"
        title="Move this point down"
        className="rounded px-0.5 text-[9px] leading-none text-ink-ctrl hover:text-ink-high disabled:opacity-30 disabled:hover:text-ink-ctrl"
      >
        ▼
      </button>
    </span>
  )
}

/** A single point row. Holds its own optimistic resolve + answer form state, keyed
 *  per control-component id, so multiple choice groups on one body stay independent. */
function OpenPointRow({ runId, surface, hidden = false, onHide, onUnhide, refreshing = false, unreachable = false, onRefresh, now, reorder, focused = false }: {
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
  /** S6 U2 — reorder controls. Absent on rows that don't participate (a resolved or
   *  dismissed point sinks by rank, so nudging it would be a lie). */
  reorder?: { canMoveUp: boolean; canMoveDown: boolean; onMove: (id: string, delta: -1 | 1) => void }
  /** S6 U1 — this row holds the Slate's keyboard focus (j/k), so it wears the cyan
   *  focus ring: keyboard focus is a live, moving thing (design language P4). */
  focused?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  // Optimistic status override (null = trust the server value). Cleared only once
  // the reconciled surface actually carries the new status — NOT by watching
  // surface.status directly, which an SSE delta racing the response can echo back
  // unchanged, leaving the row stuck optimistic.
  const [optimisticStatus, setOptimisticStatus] = useState<PointStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Answer form (only wired when the body declares controls). Lives in the shared
  // hook (S4 U2) so this row and a workbench column answer through ONE code path —
  // same POST target, same optimistic answered-lock, same validation guard.
  const answer = usePointAnswerForm(runId, surface.id)
  // Destructured because it goes in a dep array: it is the hook's raw `useState`
  // setter, so its identity is stable even though `answer` itself is rebuilt each
  // render.
  const { setError: setAnswerError } = answer

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
      // The row shows ONE error line, and before the S4 U2 extraction one `error`
      // slot held both failures, so the LAST action always won. Clearing the answer
      // slot here restores that: without it a stale "Pick an option…" would outrank
      // — and completely hide — a real "Could not resolve this point.", making the
      // failed resolve look like a click that never happened.
      setAnswerError(null)
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
        // Clear the answer slot HERE too, not only at the start: only the resolve
        // checkbox is gated on `busy` — the A2UI Submit is not — so a Submit fired
        // while this request is still in flight can populate the answer slot in
        // between, and it would outrank the failure we are about to report.
        setAnswerError(null)
        setError(`Could not ${action} this point.`)
      } finally {
        setBusy(false)
      }
    },
    [busy, runId, surface.id, optimisticStatus, setAnswerError],
  )

  const toggleResolve = useCallback(() => {
    void lifecycle(resolved ? 'reopen' : 'resolve', resolved ? null : 'resolved')
  }, [resolved, lifecycle])

  // Submitting an answer also clears any lingering lifecycle (resolve/reopen) error,
  // exactly as the pre-extraction `submitAnswer` did when the two shared one `error`.
  const form: NoticeFormState = useMemo(
    () => ({
      ...answer.form,
      submit: () => {
        setError(null)
        answer.form.submit()
      },
    }),
    [answer.form],
  )

  // The row shows ONE error line, and the two slots clear EACH OTHER — the wrapped
  // submit clears the lifecycle slot, and `lifecycle` clears the answer slot both at
  // its start AND in its catch (a Submit is not gated on `busy`, so one can land
  // mid-flight). Net effect: the LAST failure is the one shown, exactly the
  // single-slot behavior this row had before the S4 U2 extraction. The `??` orders
  // the residual case, where a submit's validation lands after a lifecycle failure —
  // there the answer message IS the newer one, so it correctly wins.
  const shownError = answer.error ?? error

  const threadCount = surface.thread?.length ?? 0

  // A refreshing row wears the same slow cyan breathe as a refreshing surface card
  // (S6 U4) so the two states read identically; the class + keyframes live in
  // src/index.css and honor prefers-reduced-motion. `transition-shadow` matches the
  // card's, so the row eases into and out of the cue the same way rather than
  // snapping. (Kept out of the JSX attribute list: a `//` comment between attributes
  // swallows the rest of its line if the file is ever reflowed.)
  return (
    <div
      data-testid={`point-${surface.id}`}
      data-status={status}
      data-refreshing={refreshing ? 'true' : undefined}
      data-focused={focused ? 'true' : undefined}
      className={`rounded border bg-surface-hover p-2.5 transition-shadow ${
        refreshing ? 'border-primary/40 slate-surface-refreshing' : 'border-hairline'
      } ${focused ? 'ring-1 ring-primary/70' : ''} ${
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
            {/* ⚡ — this point self-refreshes from a recipe (fast path, off the main
                agent). */}
            {surface.refresh && <FastPathBadge className="text-[10px]" />}
            <span
              className={`flex-1 truncate font-sans text-[13px] font-medium leading-snug text-ink-high ${resolved ? 'line-through text-ink-low' : ''}`}
            >
              {surface.headline ?? '(untitled point)'}
            </span>
            {/* Reorder (⠿ ▲▼) — nudge this point one slot (S6 U2). */}
            {!hidden && reorder && (
              <ReorderGrip
                id={surface.id}
                canMoveUp={reorder.canMoveUp}
                canMoveDown={reorder.canMoveDown}
                onMove={reorder.onMove}
              />
            )}
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
            <div data-testid={`refresh-unreachable-${surface.id}`} className="mt-2 font-sans text-[11px] leading-snug text-ink-low">
              Sent — but that session isn’t reachable right now.
            </div>
          )}
          {shownError && <div className="mt-1 text-[11px] text-hue-error">{shownError}</div>}
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
  /** S6 U1 — the id currently holding the Slate's keyboard focus, if it's a point. */
  focusedId?: string | null
}

const EMPTY_HIDDEN: ReadonlySet<string> = new Set()

/** A point that still participates in the ordering. Resolved/dismissed points sink
 *  to the bottom by rank, so a reorder chevron on one would be a lie. */
function isLive(s: SlateSurface): boolean {
  return s.status !== 'resolved' && s.status !== 'dismissed'
}

/**
 * The visible open points in the order this component renders them: hidden ones
 * dropped (unless revealed), resolved/dismissed ones sunk to the bottom, creation/
 * `order` sequence otherwise (the caller passes them pre-sorted, and `sort` is
 * stable).
 *
 * Exported so SlatePanel's j/k focus traversal (S6 U1) walks the same rule this
 * component renders from instead of re-deriving it and drifting out of step.
 *
 * CAVEAT: this is the BASE order. While a chevron reorder is in flight, the rendered
 * list is this sequence re-sorted by the component's optimistic override, so for
 * those few frames the panel's traversal order can differ from the DOM order by the
 * one row that moved. The override is short-lived by construction (it clears on the
 * reconciling `run` delta, and drops itself if its ids stop matching the server's),
 * so this is a transient off-by-one in `j`/`k`, never a stuck divergence.
 */
export function orderOpenPoints(
  points: SlateSurface[],
  hiddenIds: ReadonlySet<string>,
  showHidden: boolean,
): SlateSurface[] {
  const rank = (s: SlateSurface) => (isLive(s) ? 0 : 1)
  return [...points]
    .filter((s) => showHidden || !hiddenIds.has(s.id))
    .sort((a, b) => rank(a) - rank(b))
}

export function OpenPointsSurface({ runId, points, hiddenIds = EMPTY_HIDDEN, showHidden = false, onHide, onUnhide, refreshingIds = EMPTY_HIDDEN, unreachableIds = EMPTY_HIDDEN, onRefresh, now = Date.now(), focusedId = null }: Props) {
  // Optimistic reorder (S6 U2): the id sequence the user just asked for, held until
  // the server's own sequence arrives on the SSE `run` delta and matches. `points`
  // arrives from the panel already sorted by surface `order`, so "matches" is a
  // straight comparison against the incoming order — the same reconcile-on-the-delta
  // discipline the resolve/refresh paths use, rather than watching a raw field.
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null)
  const [reorderError, setReorderError] = useState<string | null>(null)

  // Points sink once resolved/dismissed so the live ones stay at the top; hidden
  // ones are dropped unless the reveal toggle is on (R4 — the filter runs every
  // render so an SSE re-projection can't resurrect a hidden point).
  const ordered = useMemo(() => {
    const base = orderOpenPoints(points, hiddenIds, showHidden)
    if (!optimisticOrder) return base
    // An id absent from the optimistic list (e.g. a point that arrived mid-flight)
    // sinks below the ones being moved rather than jumping to the top.
    const rank = (s: SlateSurface) => (isLive(s) ? 0 : 1)
    const at = new Map(optimisticOrder.map((id, i) => [id, i]))
    const slot = (s: SlateSurface) => at.get(s.id) ?? Number.POSITIVE_INFINITY
    return base.sort((a, b) => rank(a) - rank(b) || slot(a) - slot(b))
  }, [points, hiddenIds, showHidden, optimisticOrder])

  // S4 — pull grouped question sets out of the vertical list and into workbench bands.
  // A grouped point renders in EXACTLY one place (its column), never both, or the user
  // would face two live answer affordances for the same question. HIDDEN points are
  // excluded from the bands: a column carries no unhide button, so a revealed-but-hidden
  // point promoted into one would be stranded with no way back.
  const { groups, ungrouped } = useMemo(
    () => partitionWorkbenches(ordered, hiddenIds),
    [ordered, hiddenIds],
  )

  // The ids the chevrons actually permute: the live ROWS, in rendered order. Derived
  // from `ungrouped`, not `ordered` — a chevron that stepped over an invisible
  // workbenched point would look like a dead click.
  const liveIds = useMemo(() => ungrouped.filter(isLive).map((s) => s.id), [ungrouped])

  // Reconcile: drop the optimistic override once the server agrees — or once it can
  // no longer be checked. Both exits matter, because an override that never clears
  // masks the server's real sequence for as long as the panel lives:
  //   · the server's sequence for these ids equals what we asked for → settled, or
  //   · one of the ids is GONE from the projection (a file re-projection retracted
  //     it), so the exact-sequence test could never pass again.
  useEffect(() => {
    if (!optimisticOrder) return
    const present = new Set(points.map((s) => s.id))
    if (!optimisticOrder.every((id) => present.has(id))) {
      setOptimisticOrder(null)
      setReorderError(null)
      return
    }
    const wanted = new Set(optimisticOrder)
    const serverIds = points.filter((s) => wanted.has(s.id)).map((s) => s.id)
    if (
      serverIds.length === optimisticOrder.length &&
      serverIds.every((id, i) => id === optimisticOrder[i])
    ) {
      setOptimisticOrder(null)
      // Back in sync — any earlier "could not save" line is stale by definition.
      setReorderError(null)
    }
  }, [points, optimisticOrder])

  // Reorder writes are SERIALIZED. Nudging a point three slots is three clicks in
  // quick succession, and three concurrent PUTs have no ordering guarantee — if the
  // last one is applied first the server settles on an intermediate sequence while
  // the client holds the final one, and the exact-match reconcile above never fires.
  // `chainRef` queues each PUT behind the previous; `seqRef` makes sure only the
  // LATEST click's failure can roll the list back (a stale failure must not discard
  // a newer, successful move).
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const seqRef = useRef(0)

  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      const from = liveIds.indexOf(id)
      if (from < 0) return
      const next = moveItem(liveIds, from, from + delta)
      if (next.every((v, i) => v === liveIds[i])) return // at an end — quiet no-op
      const prev = optimisticOrder
      const mySeq = ++seqRef.current
      setReorderError(null)
      setOptimisticOrder(next)
      chainRef.current = chainRef.current.then(async () => {
        try {
          const res = await apiFetch(`/api/runs/${runId}/slate/points/order`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: next }),
          })
          const body = (await res.json().catch(() => null)) as
            | { ok?: boolean; error?: { message?: string } }
            | null
          if (!res.ok || !body?.ok) throw new Error(body?.error?.message || `reorder failed (${res.status})`)
          // Success: hold the optimistic order until the run delta carries it.
        } catch {
          if (seqRef.current !== mySeq) return // a newer move already superseded this
          setOptimisticOrder(prev) // put the list back exactly where it was
          setReorderError('Could not save the new order.')
        }
      })
    },
    [liveIds, optimisticOrder, runId],
  )

  return (
    <div
      data-testid="open-points-surface"
      className="rounded border border-hairline bg-surface-raised p-[14px] space-y-2"
    >
      <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-low">Open points</div>
      {/* Workbenches first (S4): a question SERIES is the thing the user is being asked
          to work through, so it sits above the standing rows rather than buried in
          them. Each band owns its own horizontal scroll. */}
      {groups.map(({ group, points: members }) => (
        <WorkbenchSurface key={group} runId={runId} group={group} points={members} />
      ))}
      {ungrouped.map((surface) => {
        const liveIdx = liveIds.indexOf(surface.id)
        // Only live rows get a grip, and only when there's more than one of them.
        const reorder = liveIdx >= 0 && liveIds.length > 1
          ? { canMoveUp: liveIdx > 0, canMoveDown: liveIdx < liveIds.length - 1, onMove: move }
          : undefined
        return (
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
            reorder={reorder}
            focused={focusedId === surface.id}
          />
        )
      })}
      {reorderError && <div className="text-[11px] text-hue-error">{reorderError}</div>}
      <AddPoint runId={runId} />
    </div>
  )
}
