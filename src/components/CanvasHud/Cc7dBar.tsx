import type { UsageBucket } from '../../hooks/useCcQuota'

interface Props {
  bucket: UsageBucket | null
  nowMs?: number
}

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000
const BAR_X = 0, BAR_Y = 6, BAR_W = 128, BAR_H = 8

type State = 'ok' | 'warn' | 'bad'
function classify(usedRatio: number, timeRatio: number): State {
  const deficit = usedRatio - timeRatio
  if (usedRatio >= 1 && timeRatio < 1) return 'bad'
  if (deficit > 0.20) return 'bad'
  if (deficit > 0)    return 'warn'
  return 'ok'
}
const COLOR: Record<State, string> = { ok: '#f59e0b', warn: '#f97316', bad: '#ef4444' }

export function Cc7dBar({ bucket, nowMs }: Props) {
  const now = nowMs ?? Date.now()

  if (!bucket) {
    return (
      <svg viewBox={`0 0 ${BAR_W + 2} 20`} width={BAR_W + 2} height={20} aria-label="7D quota (no data)">
        <rect x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H} rx={2} fill="rgba(255,255,255,0.09)"/>
        <text x={BAR_W / 2} y={18} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,0.55)" fontFamily="JetBrains Mono, monospace">--</text>
      </svg>
    )
  }

  const resetMs = Date.parse(bucket.resets_at)
  const remainingMs = resetMs - now
  const timeRatio = Math.max(0, Math.min(1, 1 - remainingMs / CYCLE_MS))
  const usedRatio = Math.max(0, Math.min(1, bucket.utilization / 100))
  const remainingRatio = 1 - usedRatio
  const state = classify(usedRatio, timeRatio)

  const playheadX = BAR_X + BAR_W * timeRatio
  const fillLeftX = BAR_X + BAR_W * usedRatio           // fill spans [fillLeftX, BAR_X+BAR_W]
  const fillWidth = BAR_W * remainingRatio

  const deficitStart = Math.min(playheadX, fillLeftX)
  const deficitEnd   = Math.max(playheadX, fillLeftX)
  const hasDeficit   = state !== 'ok' && usedRatio < 1

  return (
    <svg viewBox={`0 0 ${BAR_W + 4} 20`} width={BAR_W + 4} height={20}
         aria-label={`7D quota ${Math.round(remainingRatio * 100)}% left`}>
      {/* trough */}
      <rect data-testid="bar-trough" x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H} rx={2} fill="rgba(255,255,255,0.09)"/>
      {/* quota fill: anchored to right */}
      {usedRatio < 1 && (
        <rect
          data-testid="bar-fill"
          data-state={state}
          x={fillLeftX}
          y={BAR_Y}
          width={fillWidth}
          height={BAR_H}
          rx={2}
          fill={COLOR[state]}
        />
      )}
      {/* day ticks (6 interior) */}
      {[1, 2, 3, 4, 5, 6].map((i) => {
        const x = BAR_X + (BAR_W * i) / 7
        return <line key={i} x1={x} y1={BAR_Y} x2={x} y2={BAR_Y + BAR_H} stroke="rgba(255,255,255,0.3)" strokeWidth={1}/>
      })}
      {/* reset marker */}
      <circle data-testid="bar-reset" cx={BAR_X + BAR_W} cy={BAR_Y + BAR_H / 2} r={2.4} fill="#0a0f18" stroke="#f1f5f9" strokeWidth={1.2}/>
      {/* deficit shading */}
      {hasDeficit && (
        <rect
          data-testid="bar-deficit"
          x={deficitStart}
          y={BAR_Y}
          width={deficitEnd - deficitStart}
          height={BAR_H}
          fill={`${COLOR[state]}33`}
        />
      )}
      {/* playhead (time's runner) */}
      <line data-testid="bar-playhead" x1={playheadX} y1={BAR_Y - 2} x2={playheadX} y2={BAR_Y + BAR_H + 2} stroke="#f1f5f9" strokeWidth={1.5}/>
      {/* trailing-edge dot (quota's runner) — hidden when full */}
      {remainingRatio < 0.9999 && usedRatio < 1 && (
        <circle cx={fillLeftX} cy={BAR_Y + BAR_H / 2} r={1.7} fill="#0a0f18" stroke={COLOR[state]} strokeWidth={1.2}/>
      )}
    </svg>
  )
}
