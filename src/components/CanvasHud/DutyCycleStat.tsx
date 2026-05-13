import './hud.css'

interface Props {
  /**
   * Fraction of wall-clock time the agent was busy over the trailing window.
   * Session mode: 0..1 (single CLI, capped at fully busy).
   * Fleet mode: 0..N — exceeds 1 when multiple hands burn concurrently.
   * Null when telemetry isn't reporting yet.
   */
  value: number | null
  windowMinutes: number
  mode: 'session' | 'fleet'
}

/** Top of the dial scale for fleet mode — beyond this we just peg the tick at the right edge. */
const FLEET_SCALE_MAX = 10

export function DutyCycleStat({ value, windowMinutes, mode }: Props) {
  const hasData = value != null
  const isFleet = mode === 'fleet'

  let display: string
  let leftPct: number
  let tooltip: string

  if (!hasData) {
    display = '--'
    leftPct = 0
    tooltip = 'no activity recorded yet'
  } else if (isFleet) {
    const v = Math.max(0, value!)
    display = `${v.toFixed(1)}×`
    leftPct = Math.min(100, (v / FLEET_SCALE_MAX) * 100)
    const busyMin = (v * windowMinutes).toFixed(1)
    tooltip = `${busyMin} agent-min busy in the last ${windowMinutes} min`
  } else {
    const v = Math.max(0, Math.min(1, value!))
    display = `${Math.round(v * 100)}%`
    leftPct = v * 100
    const busyMin = (v * windowMinutes).toFixed(1)
    tooltip = `busy ${busyMin} of the last ${windowMinutes} min`
  }

  const endLabels = isFleet
    ? { left: '0', right: `${FLEET_SCALE_MAX}×` }
    : { left: '0', right: '100%' }

  return (
    <div className="hud-line" title={tooltip}>
      <div className="hud-ic">⚙</div>
      <div className="hud-lblrow">
        <div className="hud-dial-top">
          <span className="hud-k">DUTY CYCLE</span>
          <span className="hud-v">{display}</span>
        </div>
        <div className="hud-dial-track">
          {hasData && <div className="hud-dial-tick" style={{ left: `${leftPct}%` }} />}
        </div>
        <div className="hud-dial-ends"><span>{endLabels.left}</span><span>{endLabels.right}</span></div>
      </div>
    </div>
  )
}
