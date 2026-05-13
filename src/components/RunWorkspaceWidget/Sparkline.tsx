import { useId } from 'react'

interface Props {
  /** Oldest → newest. `null` is a missing sample; rendered by interpolating across the gap. */
  data: (number | null)[]
  /** Hex accent color for stroke + glow + area gradient. */
  accent: string
  width?: number
  height?: number
}

/**
 * Pure SVG sparkline: area-gradient fill + drop-shadowed stroke + endpoint dot.
 * No state, no animation transitions — re-render is the animation.
 *
 * Width/height are an internal viewBox; the SVG is rendered with
 * preserveAspectRatio="none" so the parent's CSS sizing wins.
 */
export function Sparkline({ data, accent, width = 200, height = 42 }: Props) {
  const gid = useId().replace(/[:]/g, '_')

  // Drop null gaps for min/max + path. With null bridging, the line goes straight
  // through gaps — visually identical to "no break" for these short series.
  const real: number[] = data.filter((v): v is number => v !== null)
  if (real.length < 2) {
    return <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" />
  }

  const min = Math.min(...real)
  const max = Math.max(...real)
  const span = max - min || 1
  const pad = 3
  const dx = width / (data.length - 1)

  const pts: [number, number][] = []
  data.forEach((v, i) => {
    if (v === null) return
    const x = i * dx
    const y = height - pad - ((v - min) / span) * (height - pad * 2)
    pts.push([x, y])
  })
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `M${pts[0][0].toFixed(1)},${height} ` +
    pts.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') +
    ` L${pts[pts.length - 1][0].toFixed(1)},${height} Z`
  const tail = pts[pts.length - 1]

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ pointerEvents: 'none' }}
    >
      <defs>
        <linearGradient id={`spark-${gid}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={accent} stopOpacity="0.55" />
          <stop offset="1" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={accent}
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 4px ${accent})` }}
      />
      <circle
        cx={tail[0]}
        cy={tail[1]}
        r={2}
        fill={accent}
        style={{ filter: `drop-shadow(0 0 4px ${accent})` }}
      />
    </svg>
  )
}
