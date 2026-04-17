import './hud.css'

interface Props {
  /** cli / user seconds. Null when data is unavailable. */
  ratio: number | null
  cliSeconds: number | null
  userSeconds: number | null
}

const SCALE_MAX = 30

export function AutonomyStat({ ratio, cliSeconds, userSeconds }: Props) {
  const hasData = ratio != null && ratio > 0
  const clamped = hasData ? Math.max(1, Math.min(SCALE_MAX, ratio!)) : 1
  const leftPct = (Math.log10(clamped) / Math.log10(SCALE_MAX)) * 100
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
        <div className="hud-dial-ends"><span>1:1</span><span>30:1</span></div>
      </div>
    </div>
  )
}
