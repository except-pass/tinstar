import { useEffect, useRef, useState } from 'react'

interface Props {
  cells: number[][]                  // 10 rows × 30 cols, indexed [valueBucket][timeColumn]
  accent: string                     // RGB triplet, e.g. '255, 132, 100'
  bucketBounds: readonly number[]    // 10 boundaries (e.g. TURN_LENGTH_BUCKETS)
}

const NUM_BUCKETS = 10
const PAD_LEFT = 24
const PAD_TOP = 4
const PAD_BOTTOM = 14
const PLOT_H = 90
const GAP = 2
const MAX_BAR_W = 22
const MIN_BAR_W = 4

export function TurnLengthHistogram({ cells, accent, bucketBounds }: Props) {
  const counts = cells.map(row => row.reduce((a, b) => a + b, 0))
  const maxCount = Math.max(1, ...counts)

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerW, setContainerW] = useState(PAD_LEFT + NUM_BUCKETS * (MAX_BAR_W + GAP))

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const obs = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) setContainerW(w)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const availForBars = Math.max(0, containerW - PAD_LEFT - (NUM_BUCKETS - 1) * GAP)
  const barW = Math.max(MIN_BAR_W, Math.min(MAX_BAR_W, availForBars / NUM_BUCKETS))
  const width = PAD_LEFT + NUM_BUCKETS * barW + (NUM_BUCKETS - 1) * GAP
  const height = PAD_TOP + PLOT_H + PAD_BOTTOM

  return (
    <div ref={containerRef} style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
      <svg width={width} height={height} role="img" aria-label="turn length histogram"
           style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 8, display: 'block' }}>
        {/* Y-axis: 0 and max */}
        <text x={PAD_LEFT - 4} y={PAD_TOP + 6} fill="rgba(180,200,220,0.5)" textAnchor="end">
          {maxCount}
        </text>
        <text x={PAD_LEFT - 4} y={PAD_TOP + PLOT_H} fill="rgba(180,200,220,0.5)" textAnchor="end">
          0
        </text>
        {/* Baseline */}
        <line x1={PAD_LEFT} y1={PAD_TOP + PLOT_H} x2={width} y2={PAD_TOP + PLOT_H}
              stroke="rgba(180,200,220,0.2)" />
        {/* Bars */}
        {counts.map((count, b) => {
          const x = PAD_LEFT + b * (barW + GAP)
          const h = count === 0 ? 0 : Math.max(1, (count / maxCount) * PLOT_H)
          const y = PAD_TOP + PLOT_H - h
          return (
            <g key={`bar-${b}`}>
              {count > 0 && (
                <rect x={x} y={y} width={barW} height={h}
                      fill={`rgba(${accent}, 0.85)`}
                      data-bucket={b} data-count={count} />
              )}
              <text x={x + barW / 2} y={PAD_TOP + PLOT_H + 10}
                    fill="rgba(180,200,220,0.5)" textAnchor="middle">
                {fmtBucket(bucketBounds[b])}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function fmtBucket(seconds: number): string {
  if (seconds < 60)    return `${seconds}s`
  if (seconds < 3600)  return `${seconds / 60}m`
  return `${seconds / 3600}h`
}
