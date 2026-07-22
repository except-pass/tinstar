// The Slate — a run-scoped column of small A2UI surfaces (plan U5/U6/U8, R1–R3,
// R13, R16, R17; Slate v2 U1/U2, R2/R4).
//
// The panel dispatches on each surface's `kind`:
//   · 'open-point' → the open-points hero surface (U6): all open-points share ONE
//     grouped list with status pills, a state track, threads, soft resolve, and an
//     add-a-point input. Rendered once, at the position of the first open-point.
//   · 'diagram'    → the diagram hero surface (U8): the A2UI picture plus a
//     per-surface thread anchored to the surface id.
//   · anything else → the generic U5 render: the file-owned A2UI `body` through the
//     SHARED `A2uiRenderer` (never a re-implemented walker), wrapped per-surface in
//     its own `A2uiErrorBoundary` so one malformed/hostile surface degrades ALONE.
//
// Slate v2:
//   · U1/R2 — the scroll body is a CSS grid that reflows 1→2 columns as the column
//     is drag-resized (see `RunWorkspaceWidget`); the open-points list always spans
//     the full width, diagram/generic surfaces flow into the grid.
//   · U2/R4 — each surface carries a ✕ hide affordance; hiding is a per-browser view
//     preference (uiPrefs `hiddenSlateSurfaces`, mirror of `hiddenRuns`), so it's
//     non-destructive and a file re-projection can't resurrect it (the filter reads
//     the persisted set on every render). A header toggle reveals hidden surfaces
//     (dimmed, each with an "unhide") with a count.
//
// This panel is purely additive: it renders NOTHING when the run has no Slate
// surfaces, so the run card keeps its existing three-panel layout unchanged.
import { useCallback, useMemo, useState } from 'react'
import type { SlateSurface } from '../../types'
import { A2uiRenderer, A2uiErrorBoundary } from '../../a2ui/A2uiRenderer'
import { OpenPointsSurface } from './OpenPointsSurface'
import { DiagramSurface } from './DiagramSurface'
import { getHiddenSlateSurfaces, addHiddenSlateSurface, removeHiddenSlateSurface } from '../../lib/uiPrefs'
import { useSlateRefresh, RefreshButton } from './slateRefresh'
import { SlateComposer } from './SlateComposer'
import { SlateExplainButton } from './SlateExplainButton'
import { SurfaceAge } from './SurfaceAge'
import { FastPathBadge } from './FastPathBadge'
import { useNow } from '../../hooks/useNow'

/** Column width (px) at/above which surfaces reflow into two columns (R2). Kept
 *  in step with the resize clamp in `RunWorkspaceWidget` (min 260, max 560). */
const SLATE_TWO_COL_MIN = 420

interface Props {
  /** The run id (= the run's `.id`) — Slate mutations are run-scoped. */
  runId: string
  /** The run's Slate projection. Undefined/empty renders nothing (additive) unless
   *  `open` forces a blank Slate to render. */
  surfaces?: SlateSurface[]
  /** Measured column width (px) driving the 1→2 column reflow (R2). When absent
   *  the grid stays single-column. */
  width?: number
  /** When true, render even with zero surfaces (a blank Slate the user opened on
   *  purpose) so Explain / + Add are reachable to fill it. */
  open?: boolean
  /** Collapse the (blank) Slate back to the strip. Only offered when there are no
   *  surfaces holding the column open. */
  onClose?: () => void
}

/** Sort by `order` (undefined sinks to the end) then `createdAt` tiebreak. */
function sortSurfaces(surfaces: SlateSurface[]): SlateSurface[] {
  return [...surfaces].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY
    const bo = b.order ?? Number.POSITIVE_INFINITY
    if (ao !== bo) return ao - bo
    return a.createdAt - b.createdAt
  })
}

/** A ✕ hide / "unhide" control shared by the diagram and generic surface cards.
 *  Inline (unpositioned) — it lives in the card's absolute control cluster next to
 *  the refresh button (see the card wrapper). */
function HideToggle({ id, hidden, onHide, onUnhide }: {
  id: string
  hidden: boolean
  onHide: (id: string) => void
  onUnhide: (id: string) => void
}) {
  if (hidden) {
    return (
      <button
        data-testid={`unhide-surface-${id}`}
        onClick={() => onUnhide(id)}
        title="Unhide this surface"
        className="rounded bg-surface-hover px-1 text-[9px] text-ink-low hover:text-ink-high"
      >
        unhide
      </button>
    )
  }
  return (
    <button
      data-testid={`hide-surface-${id}`}
      onClick={() => onHide(id)}
      title="Hide this surface (view-only — the file stays intact)"
      className="rounded px-1 text-[11px] leading-none text-ink-ctrl hover:text-ink-high"
    >
      ✕
    </button>
  )
}

export function SlatePanel({ runId, surfaces = [], width, open = false, onClose }: Props) {
  // Hidden surfaces are a per-browser view preference; seed from the persisted
  // set and keep a React copy so mutations re-render. The filter is applied on
  // every render against this set, so an SSE re-projection never resurrects a
  // hidden surface (R4).
  const [hidden, setHidden] = useState<Set<string>>(() => getHiddenSlateSurfaces())
  const [showHidden, setShowHidden] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)

  // Sorted once, above the early return, so the refresh hook (which must run
  // unconditionally) can watch the same list the render uses.
  const sorted = useMemo(() => sortSurfaces(surfaces), [surfaces])
  const { refreshingIds, unreachableIds, bulkRefreshing, refresh, refreshAll } = useSlateRefresh(runId, sorted)
  // One ticking clock for the whole panel — every surface's "updated Xm ago" reads
  // from this so they agree and there's no timer-per-card.
  const now = useNow()

  const hide = useCallback((id: string) => {
    addHiddenSlateSurface(id)
    setHidden((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const unhide = useCallback((id: string) => {
    removeHiddenSlateSurface(id)
    setHidden((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // Additive: no surfaces → render nothing (card layout unchanged) UNLESS the user
  // opened the Slate blank on purpose (`open`), in which case we render the header so
  // Explain / + Add are reachable to fill it.
  if (surfaces.length === 0 && !open) return null

  const openPoints = sorted.filter((s) => s.kind === 'open-point')
  // The grouped open-points list renders once, at the first open-point's slot.
  const firstOpenPointIdx = sorted.findIndex((s) => s.kind === 'open-point')

  const hiddenCount = sorted.filter((s) => hidden.has(s.id)).length
  const columns = width && width >= SLATE_TWO_COL_MIN ? 2 : 1
  // "Refresh all" fans out over every VISIBLE surface (each open point is a surface
  // too) — a recipe is optional, so all of them are refreshable.
  const visibleSurfaces = sorted.filter((s) => showHidden || !hidden.has(s.id))

  return (
    <div className="relative flex flex-col h-full min-w-0">
      {/* Header strip — the only always-visible chrome (design: Panel chrome). Mono
          label left, quiet actions right. Cyan is spent on ONLY the two generative
          moves (✦ Explain, + Add) — the live/creative edge (P4); everything else
          (maintenance, counts, close) stays low-contrast ink. */}
      <div className="px-3 py-1.5 border-b border-hairline bg-surface-panel/60 flex items-center justify-between gap-2">
        <span className="text-[11px] font-mono text-ink-low uppercase tracking-[0.12em]">The Slate</span>
        <div className="flex items-center gap-2">
          {hiddenCount > 0 && (
            <button
              data-testid="slate-hidden-toggle"
              onClick={() => setShowHidden((v) => !v)}
              className="text-2xs font-mono text-ink-low hover:text-ink-mid"
            >
              {hiddenCount} hidden · {showHidden ? 'hide' : 'show'}
            </button>
          )}
          {/* Slate-level loading state while a refresh-all is still settling. */}
          {bulkRefreshing && (
            <span data-testid="slate-refreshing-all" className="text-2xs font-mono text-ink-low animate-pulse">
              refreshing…
            </span>
          )}
          {/* Refresh ALL visible surfaces (each open point counts). Maintenance, not
              generative — quiet control ink, never cyan. */}
          <button
            data-testid="slate-refresh-all"
            onClick={() => refreshAll(visibleSurfaces)}
            disabled={bulkRefreshing}
            title="Refresh every surface — re-run each one’s author"
            className="text-ink-ctrl hover:text-ink-high disabled:opacity-70 leading-none"
          >
            <span className={bulkRefreshing ? 'inline-block animate-spin' : 'inline-block'}>⟳</span>
          </button>
          {/* One-click: ask the agent to (re-)explain the session as surfaces. A
              generative move — carries the cyan. */}
          <SlateExplainButton runId={runId} />
          {/* Open the composer to author a new surface. The other generative move —
              cyan, like Explain. */}
          <button
            data-testid="slate-add-surface"
            // Open-only: the composer closes itself (outside-click / cancel / escape).
            // A toggle here fights its outside-pointerdown handler — that fires first and
            // closes it, then the toggle flips it back open, so it could never close.
            onClick={() => setComposerOpen(true)}
            title="Add a surface"
            className="text-2xs font-mono text-primary hover:text-primary/80"
          >
            + Add surface
          </button>
          <span className="text-2xs font-mono text-ink-low">{sorted.length}</span>
          {/* Close only when nothing holds the column open (a blank, user-opened Slate). */}
          {sorted.length === 0 && onClose && (
            <button
              data-testid="slate-close"
              onClick={onClose}
              title="Close the Slate"
              className="text-2xs text-ink-ctrl hover:text-ink-high leading-none"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* The composer popover — anchored under the header (R7/U4). */}
      {composerOpen && (
        <div className="absolute top-8 right-2 z-20 w-64 max-w-[calc(100%-1rem)]">
          <SlateComposer runId={runId} onClose={() => setComposerOpen(false)} />
        </div>
      )}

      {/* Scroll body — data-scrollable so the canvas wheel handler yields the
          wheel to this column instead of panning the canvas (useCanvasCamera).
          A CSS grid reflows 1→2 columns with the measured width (R2); the #126
          layout guards (overflow-x-hidden, overflow-wrap, per-cell min-w-0) still
          hold so `columnsOverlapPx === 0` / no horizontal overflow survive. */}
      <div
        data-scrollable
        data-columns={columns}
        className={`flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin p-2 grid gap-2 items-start [overflow-wrap:anywhere] ${columns === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}
      >
        {sorted.length === 0 && (
          <div data-testid="slate-empty-hint" className="col-span-full px-1 py-8 text-center font-sans text-[12px] text-ink-low leading-relaxed">
            Nothing on the Slate yet.<br />
            <span className="text-ink-mid">✦ Explain</span> the session, or <span className="text-ink-mid">+ Add a surface</span> to fill it.
          </div>
        )}
        {sorted.map((surface, i) => {
          // Open-points collapse into one grouped list at the first one's slot;
          // it always spans the full width (R2). Per-point hiding lives inside.
          if (surface.kind === 'open-point') {
            if (i !== firstOpenPointIdx) return null
            return (
              <div key="open-points" className="col-span-full min-w-0">
                <OpenPointsSurface
                  runId={runId}
                  points={openPoints}
                  hiddenIds={hidden}
                  showHidden={showHidden}
                  onHide={hide}
                  onUnhide={unhide}
                  refreshingIds={refreshingIds}
                  unreachableIds={unreachableIds}
                  onRefresh={refresh}
                  now={now}
                />
              </div>
            )
          }

          const isHidden = hidden.has(surface.id)
          // Hidden + not revealing → skip entirely; revealing → render dimmed.
          if (isHidden && !showHidden) return null

          const isRefreshing = refreshingIds.has(surface.id)
          const isUnreachable = unreachableIds.has(surface.id)
          // The card's control cluster: refresh (⟳) then hide (✕), top-right.
          const controls = (
            <div className="absolute top-1 right-1 z-10 flex items-center gap-1">
              {!isHidden && (
                <RefreshButton id={surface.id} refreshing={isRefreshing} onClick={() => refresh(surface)} />
              )}
              <HideToggle id={surface.id} hidden={isHidden} onHide={hide} onUnhide={unhide} />
            </div>
          )
          // Shown when a refresh reached nobody (delivered:false / unreachable run).
          // Framed as a quiet note, not an error (low ink) — the run being asleep isn't
          // a failure of the surface.
          const note = isUnreachable ? (
            <div data-testid={`refresh-unreachable-${surface.id}`} className="mt-2 font-sans text-[11px] leading-snug text-ink-low">
              Sent — but that session isn’t reachable right now.
            </div>
          ) : null
          // Freshness footer: "updated Xm ago", ambering when the surface hasn't been
          // tended in a while — the visible cue so a stale assertion gets a second look.
          // A ⚡ leads it when the surface self-refreshes from a recipe (fast path).
          const footer = (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              {surface.refresh && <FastPathBadge className="text-[10px]" />}
              <SurfaceAge amendedAt={surface.amendedAt} now={now} />
            </div>
          )

          // One shell for every non-list surface kind (P2, "one system, N surfaces"):
          // raised card, hairline border, 14px padding. State signals live at the
          // EDGES — a cyan glow marks an in-flight refresh (P4, the live edge), dimming
          // marks hidden — so the authored body never moves between states.
          const shellClass = [
            'relative rounded border p-[14px] min-w-0 transition-shadow',
            isRefreshing
              ? 'border-primary/40 bg-surface-raised shadow-[0_0_14px_rgba(0,240,255,0.10)]'
              : 'border-hairline bg-surface-raised',
            isHidden ? 'opacity-50' : '',
          ].join(' ')
          return (
            <div
              key={surface.id}
              data-testid={`slate-surface-${surface.id}`}
              data-refreshing={isRefreshing ? 'true' : undefined}
              className={shellClass}
            >
              {controls}
              {surface.kind === 'diagram' ? (
                <DiagramSurface runId={runId} surface={surface} />
              ) : (
                /* Per-surface boundary: a throw or malformed body degrades THIS
                   surface alone; siblings are untouched (R2, per-surface budget). */
                <A2uiErrorBoundary source={surface.body}>
                  <A2uiRenderer content={surface.body} />
                </A2uiErrorBoundary>
              )}
              {note}
              {footer}
            </div>
          )
        })}
      </div>
    </div>
  )
}
