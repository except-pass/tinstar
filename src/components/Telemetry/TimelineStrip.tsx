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

    // Failure markers in the gutter. Overlapping marks MERGE with a count
    // rather than being dropped — silently discarding them made a burst of
    // failures read as a single one (R12).
    const span = Math.max(t1 - t0, 1e-9)
    const placed = marks
      .filter(m => m.at >= t0 && m.at <= t1)
      .map(m => ({ y: ((m.at - t0) / span) * heightPx, kind: m.kind }))
      .sort((a, b) => a.y - b.y)

    const clusters: { y: number; failed: number; interrupted: number }[] = []
    for (const p of placed) {
      const last = clusters[clusters.length - 1]
      if (last && p.y - last.y < 5) {
        if (p.kind === 'tool-failed') last.failed++
        else last.interrupted++
        continue
      }
      clusters.push({
        y: p.y,
        failed: p.kind === 'tool-failed' ? 1 : 0,
        interrupted: p.kind === 'tool-failed' ? 0 : 1,
      })
    }

    for (const c of clusters) {
      const y = Math.min(Math.max(c.y, 0), heightPx - 3)
      const total = c.failed + c.interrupted
      // Filled for a tool that exited non-zero, hollow for an interrupted
      // sub-agent — the two were previously indistinguishable.
      if (c.failed > 0) {
        g.fillStyle = MARK_COLOR
        g.fillRect(STRIP_W + 2, y, GUTTER_W - 3, total > 1 ? 3 : 2)
      } else {
        g.strokeStyle = MARK_COLOR
        g.lineWidth = 1
        g.strokeRect(STRIP_W + 2.5, y + 0.5, GUTTER_W - 4, 2)
      }
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
