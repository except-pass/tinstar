import { useEffect, useRef, useState } from 'react'
import type { BucketToolStats } from '../../hooks/useTurnLengthObservations'

interface Props {
  cells: number[][]                  // 10 rows × 30 cols, indexed [valueBucket][timeColumn]
  accent: string                     // RGB triplet, e.g. '255, 132, 100'
  bucketBounds: readonly number[]    // 10 boundaries (e.g. TURN_LENGTH_BUCKETS)
  /** Per-bucket tool_use distribution; when present, a p10–p50–p90 whisker is
   *  overlaid on each bar. Omit to render bars only (backward compatible). */
  toolStats?: (BucketToolStats | null)[]
  toolAccent?: string                // RGB triplet for the whisker; defaults to a cyan
}

const NUM_BUCKETS = 10
const PAD_LEFT = 24
const PAD_TOP = 4
const PAD_BOTTOM = 14
const PLOT_H = 90
const GAP = 2
const MAX_BAR_W = 22
const MIN_BAR_W = 4
const DEFAULT_TOOL_ACCENT = '120, 220, 232'

export function TurnLengthHistogram({ cells, accent, bucketBounds, toolStats, toolAccent = DEFAULT_TOOL_ACCENT }: Props) {
  const counts = cells.map(row => row.reduce((a, b) => a + b, 0))
  const maxCount = Math.max(1, ...counts)

  // Whiskers share one tool-count scale so bars are comparable across buckets.
  const toolMax = toolStats
    ? Math.max(1, ...toolStats.map(s => s?.p90 ?? 0))
    : 0
  const toolY = (v: number) => PAD_TOP + PLOT_H - (v / toolMax) * PLOT_H

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
        {/* Tool-scale label (right axis) — whisker top corresponds to this count */}
        {toolStats && (
          <text x={width} y={PAD_TOP + 6} fill={`rgba(${toolAccent}, 0.7)`} textAnchor="end">
            {toolMax} tools
          </text>
        )}
        {/* Bars */}
        {counts.map((count, b) => {
          const x = PAD_LEFT + b * (barW + GAP)
          const h = count === 0 ? 0 : Math.max(1, (count / maxCount) * PLOT_H)
          const y = PAD_TOP + PLOT_H - h
          const cx = x + barW / 2
          const cap = Math.max(2, Math.min(5, barW / 2))
          const stats = toolStats?.[b]
          return (
            <g key={`bar-${b}`}>
              {count > 0 && (
                <rect x={x} y={y} width={barW} height={h}
                      fill={`rgba(${accent}, 0.85)`}
                      data-bucket={b} data-count={count} />
              )}
              {stats && count > 0 && (
                <g data-tool-whisker={b}
                   data-tool-p10={stats.p10} data-tool-p50={stats.p50} data-tool-p90={stats.p90}>
                  {/* p10–p90 range line */}
                  <line x1={cx} y1={toolY(stats.p10)} x2={cx} y2={toolY(stats.p90)}
                        stroke={`rgba(${toolAccent}, 0.9)`} strokeWidth={1} />
                  {/* p10 & p90 caps */}
                  <line x1={cx - cap} y1={toolY(stats.p90)} x2={cx + cap} y2={toolY(stats.p90)}
                        stroke={`rgba(${toolAccent}, 0.9)`} strokeWidth={1} />
                  <line x1={cx - cap} y1={toolY(stats.p10)} x2={cx + cap} y2={toolY(stats.p10)}
                        stroke={`rgba(${toolAccent}, 0.9)`} strokeWidth={1} />
                  {/* p50 marker */}
                  <circle cx={cx} cy={toolY(stats.p50)} r={1.6} fill={`rgba(${toolAccent}, 1)`} />
                </g>
              )}
              <text x={cx} y={PAD_TOP + PLOT_H + 10}
                    fill="rgba(180,200,220,0.5)" textAnchor="middle">
                {bucketBounds[b] !== undefined ? fmtBucket(bucketBounds[b]!) : ''}
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
