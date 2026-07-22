// The diagram hero surface (plan U8, R17). A thin layer over the U5 rendering: the
// file-owned A2UI `body` is the picture (rendered read-only through the SHARED
// A2uiRenderer, which carries its own per-surface error boundary and node budget),
// with a per-surface THREAD anchored to the surface id beneath it. Commenting is
// scoped to THIS surface — the SurfaceThread posts to …/slate/points/:id/replies,
// the same store-backed thread the open-points rows use.
import type { SlateSurface } from '../../types'
import { A2uiRenderer } from '../../a2ui/A2uiRenderer'
import { SurfaceThread } from './SurfaceThread'

interface Props {
  runId: string
  surface: SlateSurface
}

export function DiagramSurface({ runId, surface }: Props) {
  return (
    <div data-testid={`diagram-${surface.id}`} className="flex flex-col gap-2">
      {surface.headline && (
        <div className="text-xs font-medium text-slate-200">{surface.headline}</div>
      )}
      {/* The picture. Read-only (no form) — a diagram is shown, not answered. The
          renderer degrades a malformed body to the readable fallback on its own. */}
      <A2uiRenderer content={surface.body} />
      {/* The per-surface thread, anchored to this surface id. */}
      <div className="border-t border-primary/10 pt-2">
        <SurfaceThread
          runId={runId}
          pointId={surface.id}
          thread={surface.thread}
          placeholder="Comment on this diagram…"
        />
      </div>
    </div>
  )
}
