interface Props {
  cells: number[][]                  // 10 rows × 30 cols, indexed [valueBucket][timeColumn]
  accent: string                     // RGB triplet, e.g. '255, 132, 100'
  windowSec: number                  // for X-axis label
  bucketBounds: readonly number[]    // 10 boundaries (e.g. TURN_LENGTH_BUCKETS)
}

const NUM_ROWS = 10
const NUM_COLS = 30

export function TurnLengthHeatmap({ cells, accent, windowSec, bucketBounds }: Props) {
  const maxCount = Math.max(1, ...cells.flat())
  const cellW = 8
  const cellH = 10
  const padLeft = 32  // for Y-axis labels
  const padBottom = 14  // for X-axis labels
  const width = padLeft + NUM_COLS * cellW
  const height = NUM_ROWS * cellH + padBottom

  return (
    <svg width={width} height={height} role="img" aria-label="turn length heatmap"
         style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 8 }}>
      {cells.map((row, r) =>
        row.map((count, c) => {
          if (count === 0) return null
          const alpha = (count / maxCount).toFixed(2)
          return (
            <rect key={`${r}-${c}`}
                  x={padLeft + c * cellW}
                  y={r * cellH}
                  width={cellW - 1}
                  height={cellH - 1}
                  fill={`rgba(${accent}, ${alpha})`}
                  data-row={r} data-col={c} data-count={count}
            />
          )
        })
      )}
      {/* Y-axis bucket labels */}
      {bucketBounds.map((b, r) => (
        <text key={`y-${r}`}
              x={padLeft - 4}
              y={r * cellH + cellH * 0.75}
              fill="rgba(180,200,220,0.5)"
              textAnchor="end">
          {fmtBucket(b)}
        </text>
      ))}
      {/* X-axis ends */}
      <text x={padLeft} y={NUM_ROWS * cellH + 10} fill="rgba(180,200,220,0.5)">
        −{fmtWindow(windowSec)}
      </text>
      <text x={width - 4} y={NUM_ROWS * cellH + 10} fill="rgba(180,200,220,0.5)" textAnchor="end">
        now
      </text>
    </svg>
  )
}

function fmtBucket(seconds: number): string {
  if (seconds < 60)    return `${seconds}s`
  if (seconds < 3600)  return `${seconds / 60}m`
  return `${seconds / 3600}h`
}

function fmtWindow(seconds: number): string {
  if (seconds < 3600) return `${seconds / 60}m`
  return `${seconds / 3600}h`
}
