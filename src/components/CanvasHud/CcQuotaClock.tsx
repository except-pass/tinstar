import type { UsageBucket } from '../../hooks/useCcQuota'

interface Props {
  bucket: UsageBucket | null
  /** Injected for tests; defaults to live time. */
  nowMs?: number
}

const CYCLE_MS = 5 * 60 * 60 * 1000

// Clock geometry: viewBox 40x40, center (20,20), radius 15.
const CX = 20, CY = 20, R = 15

/** SVG clockwise 0° = 12 o'clock. `pointAt(0)` → top. */
function pointAt(angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180
  return { x: CX + R * Math.sin(rad), y: CY - R * Math.cos(rad) }
}

/**
 * Build an SVG arc path clockwise from `from` to `to` (angles in degrees CW from 12).
 * Callers must pass angles where `(to - from) mod 360` is the sweep length.
 */
function arcPath(fromDeg: number, toDeg: number): string {
  const a = pointAt(fromDeg)
  const b = pointAt(toDeg)
  const sweep = ((toDeg - fromDeg) % 360 + 360) % 360
  const largeArc = sweep > 180 ? 1 : 0
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
}

/** Returns fractional 12-hour value using UTC clock (timezone-stable). */
function hourOfDay12UTC(ms: number): number {
  const d = new Date(ms)
  return (d.getUTCHours() % 12) + d.getUTCMinutes() / 60
}

type State = 'ok' | 'warn' | 'bad'

function classify(usedRatio: number, timeRatio: number): State {
  const deficit = usedRatio - timeRatio
  if (usedRatio >= 1 && timeRatio < 1) return 'bad'
  if (deficit > 0.20) return 'bad'
  if (deficit > 0) return 'warn'
  return 'ok'
}

const COLOR: Record<State, string> = {
  ok:   '#22d3ee',
  warn: '#f97316',
  bad:  '#ef4444',
}

export function CcQuotaClock({ bucket, nowMs }: Props) {
  const now = nowMs ?? Date.now()

  if (!bucket) {
    return (
      <svg viewBox="0 0 40 40" width="36" height="36" aria-label="5H quota (no data)">
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={3.5}/>
        <text x={CX} y={CY + 3} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.55)" fontFamily="JetBrains Mono, monospace">--</text>
      </svg>
    )
  }

  const resetMs = Date.parse(bucket.resets_at)
  const remainingMs = resetMs - now
  const timeRatio = Math.max(0, Math.min(1, 1 - remainingMs / CYCLE_MS))
  const usedRatio = Math.max(0, Math.min(1, bucket.utilization / 100))
  const state = classify(usedRatio, timeRatio)

  const resetHourAngle = hourOfDay12UTC(resetMs) * 30             // reset position on clock face (deg CW from 12)
  const cycleStartAngle = (resetHourAngle - 150 + 360) % 360      // 150° before reset
  const remainingRatio = 1 - usedRatio                             // of the 150° window
  const fillStartAngle = (resetHourAngle - 150 * remainingRatio + 360) % 360
  const hourAngle = hourOfDay12UTC(now) * 30

  const resetPt       = pointAt(resetHourAngle)
  const trailingEdge  = pointAt(fillStartAngle)

  const isFull = remainingRatio >= 0.9999

  return (
    <svg viewBox="0 0 40 40" width="36" height="36" aria-label={`5H quota ${Math.round(remainingRatio * 100)}% left`}>
      {/* outer trough (rest of the clock face, subtle) */}
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={3.5}/>
      {/* cycle trough (just the 150° window, dim) */}
      <path data-testid="cycle-trough" d={arcPath(cycleStartAngle, resetHourAngle)} fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth={3.5} strokeLinecap="butt"/>
      {/* quota fill (anchored to reset; retreats CW from cycle start) */}
      {usedRatio < 1 && (
        <path
          data-testid="quota-fill"
          data-state={state}
          d={arcPath(fillStartAngle, resetHourAngle)}
          fill="none"
          stroke={COLOR[state]}
          strokeWidth={3.5}
          strokeLinecap="butt"
        />
      )}
      {/* reset marker */}
      <circle data-testid="reset-marker" cx={resetPt.x} cy={resetPt.y} r={2} fill="#0a0f18" stroke="#f1f5f9" strokeWidth={1.1}/>
      {/* trailing-edge dot (quota's runner) — hidden when at cycle start or exhausted */}
      {!isFull && usedRatio < 1 && (
        <circle cx={trailingEdge.x} cy={trailingEdge.y} r={1.7} fill="#0a0f18" stroke={COLOR[state]} strokeWidth={1.2}/>
      )}
      {/* hour hand */}
      <g data-testid="hour-hand" transform={`rotate(${hourAngle} ${CX} ${CY})`}>
        <line x1={CX} y1={CY} x2={CX} y2={CY - (R - 3)} stroke="#f1f5f9" strokeWidth={1.5} strokeLinecap="round"/>
        <circle cx={CX} cy={CY} r={1.4} fill="#f1f5f9"/>
      </g>
    </svg>
  )
}
