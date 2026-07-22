// The Slate — a run-scoped column of small A2UI surfaces (plan U5/U6/U8, R1–R3,
// R13, R16, R17).
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
// This panel is purely additive: it renders NOTHING when the run has no Slate
// surfaces, so the run card keeps its existing three-panel layout unchanged.
import type { SlateSurface } from '../../types'
import { A2uiRenderer, A2uiErrorBoundary } from '../../a2ui/A2uiRenderer'
import { OpenPointsSurface } from './OpenPointsSurface'
import { DiagramSurface } from './DiagramSurface'

interface Props {
  /** The run id (= the run's `.id`) — Slate mutations are run-scoped. */
  runId: string
  /** The run's Slate projection. Undefined/empty renders nothing (additive). */
  surfaces?: SlateSurface[]
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

export function SlatePanel({ runId, surfaces = [] }: Props) {
  // Additive: no surfaces → render nothing, so the card layout is unchanged.
  if (surfaces.length === 0) return null

  const sorted = sortSurfaces(surfaces)
  const openPoints = sorted.filter((s) => s.kind === 'open-point')
  // The grouped open-points list renders once, at the first open-point's slot.
  const firstOpenPointIdx = sorted.findIndex((s) => s.kind === 'open-point')

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Summary bar — mirrors the other panels' header row */}
      <div className="px-3 py-1.5 border-b border-primary/10 bg-surface-base/50 flex items-center justify-between">
        <span className="text-2xs font-mono text-slate-500 uppercase tracking-wider">The Slate</span>
        <span className="text-2xs font-mono text-slate-500">{sorted.length}</span>
      </div>

      {/* Scroll body — data-scrollable so the canvas wheel handler yields the
          wheel to this column instead of panning the canvas (useCanvasCamera). */}
      <div data-scrollable className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin p-2 space-y-2 [overflow-wrap:anywhere]">
        {sorted.map((surface, i) => {
          // Open-points collapse into one grouped list at the first one's slot.
          if (surface.kind === 'open-point') {
            if (i !== firstOpenPointIdx) return null
            return <OpenPointsSurface key="open-points" runId={runId} points={openPoints} />
          }

          if (surface.kind === 'diagram') {
            return (
              <div
                key={surface.id}
                data-testid={`slate-surface-${surface.id}`}
                className="rounded border border-primary/10 bg-surface-base/40 p-2"
              >
                <DiagramSurface runId={runId} surface={surface} />
              </div>
            )
          }

          return (
            <div
              key={surface.id}
              data-testid={`slate-surface-${surface.id}`}
              className="rounded border border-primary/10 bg-surface-base/40 p-2"
            >
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
