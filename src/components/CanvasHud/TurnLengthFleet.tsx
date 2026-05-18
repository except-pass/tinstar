import { useConfig } from '../../context/ConfigContext'
import { useTurnLengthObservations, TURN_LENGTH_BUCKETS } from '../../hooks/useTurnLengthObservations'
import { TurnLengthHeatmap } from '../Telemetry/TurnLengthHeatmap'

const TURN_LENGTH_ACCENT = '255, 132, 100'

export function TurnLengthFleet() {
  const config = useConfig()
  if (!config?.ui.telemetryPanels.turnLength) return null
  return <TurnLengthFleetInner />
}

function TurnLengthFleetInner() {
  const { cells, p50, p95, n } = useTurnLengthObservations(null, 3600)  // null = fleet

  return (
    <div data-testid="turn-length-fleet" style={{ padding: '4px 8px' }}>
      <div style={{
        fontSize: 8, letterSpacing: 2, opacity: 0.55,
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        TURN LENGTH · 60m
      </div>
      <TurnLengthHeatmap
        cells={cells}
        accent={TURN_LENGTH_ACCENT}
        windowSec={3600}
        bucketBounds={TURN_LENGTH_BUCKETS}
      />
      <div style={{ fontSize: 8, opacity: 0.65, fontFamily: 'JetBrains Mono, monospace' }}>
        {n === 0 ? '—' : `p50:${fmtSec(p50!)} p95:${fmtSec(p95!)} n:${n}`}
      </div>
    </div>
  )
}

function fmtSec(s: number): string {
  if (s < 60)   return `${s.toFixed(1)}s`
  if (s < 3600) return `${(s / 60).toFixed(1)}m`
  return `${(s / 3600).toFixed(1)}h`
}
