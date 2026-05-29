import type { SnapWidget } from './snapZoneResolver'

interface Props {
  /** The single widget the drag would snap against, or null when nothing is in range. */
  target: SnapWidget | null
  /** false → the snap would form a new constellation but all 9 slots are taken (render a warning tone). */
  canJoin: boolean
}

const HALO_PAD = 12

export function SnapZoneOverlay({ target, canJoin }: Props) {
  if (!target) return null
  const tone = canJoin
    ? 'border-primary/70 bg-primary/10'
    : 'border-red-400/70 bg-red-400/10'
  return (
    <div
      data-testid={`snap-halo-${target.id}`}
      className={`pointer-events-none absolute border-2 rounded-md ${tone}`}
      style={{
        left: target.x - HALO_PAD,
        top: target.y - HALO_PAD,
        width: target.width + HALO_PAD * 2,
        height: target.height + HALO_PAD * 2,
      }}
    />
  )
}
