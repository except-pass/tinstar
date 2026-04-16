import './hud.css'

interface Props {
  /** cli / user seconds. Null when data is unavailable. */
  ratio: number | null
  cliSeconds: number | null
  userSeconds: number | null
}

export function AutonomyStat({ ratio, cliSeconds, userSeconds }: Props) {
  const hasData = ratio != null && ratio > 0
  // Position tick on 1:1..10:1 log scale. When no data, center the tick mid-track.
  const clamped = hasData ? Math.max(1, Math.min(10, ratio!)) : 1
  const leftPct = Math.log10(clamped) * 100
  const display = hasData ? `${ratio!.toFixed(1)}×` : '--'
  const tooltip = hasData
    ? `${cliSeconds ?? '--'}s agent / ${userSeconds ?? '--'}s human`
    : 'no activity recorded yet'
  return (
    <div className="hud-line" title={tooltip}>
      <div className="hud-ic">⚙</div>
      <div className="hud-lblrow">
        <div className="hud-dial-top">
          <span className="hud-k">AUTONOMY</span>
          <span className="hud-v">{display}</span>
        </div>
        <div className="hud-dial-track">
          {hasData && <div className="hud-dial-tick" style={{ left: `${leftPct}%` }} />}
        </div>
        <div className="hud-dial-ends"><span>1:1</span><span>10:1</span></div>
      </div>
    </div>
  )
}
