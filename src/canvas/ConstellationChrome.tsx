import { boundingBoxOf, computeBreakLinks, type IdRect } from './constellationCohesion'
import type { ConstellationSlot } from '../domain/constellationGraph'

interface Props {
  slot: ConstellationSlot
  members: IdRect[]
  active: boolean
  /** Break the seam between two stuck widgets — splits the constellation at that link only. */
  onBreak?: (aId: string, bId: string) => void
}

export function ConstellationChrome({ slot, members, active, onBreak }: Props) {
  if (members.length === 0) return null

  const box = boundingBoxOf(members)
  if (!box) return null

  // A link-break chip sits at each seam between two stuck widgets — only while the
  // constellation is active (revealed by clicking a member), to avoid canvas clutter.
  const links = active && onBreak && members.length >= 2 ? computeBreakLinks(members) : []

  return (
    <>
      {active && (
        <div
          data-testid={`constellation-outline-${slot}`}
          className="pointer-events-none absolute border-2 border-primary/80 rounded-md"
          style={{
            left: box.x - 8,
            top: box.y - 8,
            width: box.width + 16,
            height: box.height + 16,
          }}
        />
      )}
      {active && (
        <div
          data-testid={`constellation-badge-large-${slot}`}
          className="pointer-events-none absolute bg-primary text-white text-sm font-bold rounded px-2 py-0.5"
          style={{ left: box.x - 8, top: box.y - 28 }}
        >
          {slot}
        </div>
      )}
      {links.map((link, i) => (
        <button
          key={`break-${slot}-${link.aId}-${link.bId}`}
          data-testid={`constellation-break-${slot}-${i}`}
          className="pointer-events-auto absolute flex items-center justify-center w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface-panel border border-primary/70 text-primary shadow hover:bg-primary hover:text-white transition-colors"
          style={{ left: link.x, top: link.y }}
          title="Break this link — separate these widgets"
          aria-label="Break constellation link"
          onPointerDown={(e) => { e.stopPropagation() }}
          onClick={(e) => { e.stopPropagation(); onBreak?.(link.aId, link.bId) }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>link_off</span>
        </button>
      ))}
    </>
  )
}
