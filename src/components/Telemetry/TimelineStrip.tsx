import { useEffect, useRef } from 'react'
import { compositeColumns, runsFromColumns } from './timelinePaint'
import type { Band, BandKind, Mark } from '../../server/sessions/timeline/types'

/**
 * Band colours, carried over from the spike where they were checked against
 * both the light and dark rail. Red is always "you are the blocker".
 */
export const BAND_COLOR: Record<BandKind, string> = {
  approval: '#D95E52',
  question: '#E0A33A',
  idle: '#222932',
  subagent: '#7C6CBF',
  tool: '#35907C',
  think: '#5C6B80',
  compact: '#4A80C4',
}

export const MARK_COLOR = '#FF5E5E'

const STRIP_W = 26
const GUTTER_W = 7

interface Props {
  bands: Band[]
  marks: Mark[]
  t0: number
  t1: number
  heightPx: number
  label: string
  onHover?: (band: Band | null) => void
}

/**
 * One vertical strip of a run's timeline. Row 0 is the earliest moment, so the
 * past sits at the top and the present at the bottom (R9).
 */
export function TimelineStrip({ bands, marks, t0, t1, heightPx, label, onHover }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    const w = STRIP_W + GUTTER_W
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(heightPx * dpr)
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, heightPx)

    const cols = compositeColumns(bands, t0, t1, Math.max(1, Math.round(heightPx)))
    // One filled path per colour rather than one rect per band (R16).
    const runs = runsFromColumns(cols)
    const byKind = new Map<BandKind, { start: number; len: number }[]>()
    for (const r of runs) {
      const arr = byKind.get(r.kind)
      if (arr) arr.push(r)
      else byKind.set(r.kind, [r])
    }
    for (const [kind, rs] of byKind) {
      g.beginPath()
      for (const r of rs) g.rect(0, r.start, STRIP_W, r.len)
      g.fillStyle = BAND_COLOR[kind]
      g.fill()
    }

    // Failure markers in the gutter, clustered so overlaps become one tick.
    const span = Math.max(t1 - t0, 1e-9)
    const ys = marks
      .filter(m => m.at >= t0 && m.at <= t1)
      .map(m => ((m.at - t0) / span) * heightPx)
      .sort((a, b) => a - b)
    g.fillStyle = MARK_COLOR
    let lastY = -Infinity
    for (const y of ys) {
      if (y - lastY < 4) continue
      g.fillRect(STRIP_W + 2, Math.min(y, heightPx - 2), GUTTER_W - 3, 2)
      lastY = y
    }
  }, [bands, marks, t0, t1, heightPx])

  const hit = (clientY: number): void => {
    if (!onHover) return
    const cv = ref.current
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    const frac = (clientY - rect.top) / Math.max(rect.height, 1)
    const at = t0 + frac * (t1 - t0)
    onHover(bands.find(b => at >= b.start && at <= b.end) ?? null)
  }

  return (
    <canvas
      ref={ref}
      data-testid="timeline-strip"
      aria-label={label}
      style={{ width: STRIP_W + GUTTER_W, height: heightPx, cursor: 'crosshair' }}
      onMouseMove={e => hit(e.clientY)}
      onMouseLeave={() => onHover?.(null)}
    />
  )
}
