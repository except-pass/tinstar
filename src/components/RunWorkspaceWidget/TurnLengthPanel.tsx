import { useConfig } from '../../context/ConfigContext'
import { useTurnLengthObservations, TURN_LENGTH_BUCKETS, TURN_LENGTH_HELP } from '../../hooks/useTurnLengthObservations'
import { TurnLengthHistogram } from '../Telemetry/TurnLengthHistogram'

const TURN_LENGTH_ACCENT = '255, 132, 100'

export function TurnLengthPanel({ sessionId }: { sessionId: string }) {
  const config = useConfig()
  if (!config?.ui.telemetryPanels.turnLength) return null
  return <TurnLengthPanelInner sessionId={sessionId} />
}

function TurnLengthPanelInner({ sessionId }: { sessionId: string }) {
  const { cells, p50, p95, n, toolStats, toolP50, toolP90 } = useTurnLengthObservations(sessionId, 3600)
  return (
    <div data-testid="turn-length-panel" style={{ padding: '6px 0' }}>
      <div style={{
        fontSize: 9, letterSpacing: 2, opacity: 0.55,
        fontFamily: 'JetBrains Mono, monospace', marginBottom: 4,
      }}>
        TURN LENGTH · 60m
        <span title={TURN_LENGTH_HELP} style={{ marginLeft: 4, opacity: 0.7, cursor: 'help' }}>ⓘ</span>
      </div>
      <TurnLengthHistogram
        cells={cells}
        accent={TURN_LENGTH_ACCENT}
        bucketBounds={TURN_LENGTH_BUCKETS}
        toolStats={toolStats}
      />
      <div style={{
        fontSize: 9, opacity: 0.65, marginTop: 4,
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        {n === 0
          ? '— no turns —'
          : `p50: ${fmtSec(p50!)} · p95: ${fmtSec(p95!)} · n: ${n}` +
            (toolP50 !== undefined ? ` · tools p50/p90: ${toolP50}/${toolP90}` : '')}
      </div>
    </div>
  )
}

function fmtSec(seconds: number): string {
  if (seconds < 1)    return `${(seconds * 1000).toFixed(0)}ms`
  if (seconds < 60)   return `${seconds.toFixed(1)}s`
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}
