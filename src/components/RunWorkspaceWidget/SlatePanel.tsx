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
import { useCallback, useState } from 'react'
import type { SlateSurface } from '../../types'
import { A2uiRenderer, A2uiErrorBoundary } from '../../a2ui/A2uiRenderer'
import { OpenPointsSurface } from './OpenPointsSurface'
import { DiagramSurface } from './DiagramSurface'
import { getHiddenSlateSurfaces, addHiddenSlateSurface, removeHiddenSlateSurface } from '../../lib/uiPrefs'

/** Column width (px) at/above which surfaces reflow into two columns (R2). Kept
 *  in step with the resize clamp in `RunWorkspaceWidget` (min 260, max 560). */
const SLATE_TWO_COL_MIN = 420

interface Props {
  /** The run id (= the run's `.id`) — Slate mutations are run-scoped. */
  runId: string
  /** The run's Slate projection. Undefined/empty renders nothing (additive). */
  surfaces?: SlateSurface[]
  /** Measured column width (px) driving the 1→2 column reflow (R2). When absent
   *  the grid stays single-column. */
  width?: number
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

/** A ✕ hide / "unhide" control shared by the diagram and generic surface cards. */
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
        className="absolute top-1 right-1 z-10 rounded bg-surface-hover px-1 text-[9px] text-slate-400 hover:text-slate-200"
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
      className="absolute top-1 right-1 z-10 rounded px-1 text-[11px] leading-none text-slate-500 hover:text-slate-200"
    >
      ✕
    </button>
  )
}

export function SlatePanel({ runId, surfaces = [], width }: Props) {
  // Hidden surfaces are a per-browser view preference; seed from the persisted
  // set and keep a React copy so mutations re-render. The filter is applied on
  // every render against this set, so an SSE re-projection never resurrects a
  // hidden surface (R4).
  const [hidden, setHidden] = useState<Set<string>>(() => getHiddenSlateSurfaces())
  const [showHidden, setShowHidden] = useState(false)

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

  // Additive: no surfaces → render nothing, so the card layout is unchanged.
  if (surfaces.length === 0) return null

  const sorted = sortSurfaces(surfaces)
  const openPoints = sorted.filter((s) => s.kind === 'open-point')
  // The grouped open-points list renders once, at the first open-point's slot.
  const firstOpenPointIdx = sorted.findIndex((s) => s.kind === 'open-point')

  const hiddenCount = sorted.filter((s) => hidden.has(s.id)).length
  const columns = width && width >= SLATE_TWO_COL_MIN ? 2 : 1

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Summary bar — mirrors the other panels' header row */}
      <div className="px-3 py-1.5 border-b border-primary/10 bg-surface-base/50 flex items-center justify-between gap-2">
        <span className="text-2xs font-mono text-slate-500 uppercase tracking-wider">The Slate</span>
        <div className="flex items-center gap-2">
          {hiddenCount > 0 && (
            <button
              data-testid="slate-hidden-toggle"
              onClick={() => setShowHidden((v) => !v)}
              className="text-2xs font-mono text-slate-500 hover:text-slate-300"
            >
              {hiddenCount} hidden · {showHidden ? 'hide' : 'show'}
            </button>
          )}
          <span className="text-2xs font-mono text-slate-500">{sorted.length}</span>
        </div>
      </div>

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
                />
              </div>
            )
          }

          const isHidden = hidden.has(surface.id)
          // Hidden + not revealing → skip entirely; revealing → render dimmed.
          if (isHidden && !showHidden) return null

          if (surface.kind === 'diagram') {
            return (
              <div
                key={surface.id}
                data-testid={`slate-surface-${surface.id}`}
                className={`relative rounded border border-primary/10 bg-surface-base/40 p-2 min-w-0 ${isHidden ? 'opacity-50' : ''}`}
              >
                <HideToggle id={surface.id} hidden={isHidden} onHide={hide} onUnhide={unhide} />
                <DiagramSurface runId={runId} surface={surface} />
              </div>
            )
          }

          return (
            <div
              key={surface.id}
              data-testid={`slate-surface-${surface.id}`}
              className={`relative rounded border border-primary/10 bg-surface-base/40 p-2 min-w-0 ${isHidden ? 'opacity-50' : ''}`}
            >
              <HideToggle id={surface.id} hidden={isHidden} onHide={hide} onUnhide={unhide} />
              {/* Per-surface boundary: a throw or malformed body degrades THIS
                  surface alone; siblings are untouched (R2, per-surface budget). */}
              <A2uiErrorBoundary source={surface.body}>
                <A2uiRenderer content={surface.body} />
              </A2uiErrorBoundary>
            </div>
          )
        })}
      </div>
    </div>
  )
}
