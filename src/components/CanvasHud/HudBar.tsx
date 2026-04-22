import './hud.css'

export type HudBarAccent = 'gold' | 'blue' | 'green' | 'purple'

interface Props {
  icon: string
  label: string
  /** The rendered value. Pass `--` (or similar) when data is missing. */
  value: string
  /** 0..1, or undefined/null to render an empty trough (no fill). */
  fill?: number | null
  accent: HudBarAccent
}

export function HudBar({ icon, label, value, fill, accent }: Props) {
  const pct = fill == null ? 0 : Math.max(0, Math.min(1, fill)) * 100
  return (
    <div className="hud-line">
      <div className="hud-ic">{icon}</div>
      <div className="hud-lblrow">
        <div className="hud-t">
          <span>{label}</span>
          <span className="hud-v">{value}</span>
        </div>
        <div className="hud-trough">
          {fill != null && <div className={`hud-fill ${accent}`} style={{ width: `${pct}%` }} />}
        </div>
      </div>
    </div>
  )
}
