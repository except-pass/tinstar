// The Slate — a run-scoped column of small A2UI surfaces (plan U5, R1–R3).
//
// Each surface's file-owned A2UI `body` is rendered through the SHARED
// `A2uiRenderer` (never a re-implemented walker), wrapped per-surface in its own
// `A2uiErrorBoundary` so one malformed/hostile surface degrades to the readable
// fallback ALONE — its siblings keep rendering. The renderer's per-surface node
// budget and URL-scheme allowlist come for free by reuse.
//
// This panel is purely additive: it renders NOTHING when the run has no Slate
// surfaces, so the run card keeps its existing three-panel layout unchanged.
import type { SlateSurface } from '../../types'
import { A2uiRenderer, A2uiErrorBoundary } from '../../a2ui/A2uiRenderer'

interface Props {
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

export function SlatePanel({ surfaces = [] }: Props) {
  // Additive: no surfaces → render nothing, so the card layout is unchanged.
  if (surfaces.length === 0) return null

  const sorted = sortSurfaces(surfaces)

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar — mirrors the other panels' header row */}
      <div className="px-3 py-1.5 border-b border-primary/10 bg-surface-base/50 flex items-center justify-between">
        <span className="text-2xs font-mono text-slate-500 uppercase tracking-wider">The Slate</span>
        <span className="text-2xs font-mono text-slate-500">{sorted.length}</span>
      </div>

      {/* Scroll body — data-scrollable so the canvas wheel handler yields the
          wheel to this column instead of panning the canvas (useCanvasCamera). */}
      <div data-scrollable className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-2">
        {sorted.map((surface) => (
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
        ))}
      </div>
    </div>
  )
}
