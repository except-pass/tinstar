import { useCallback, useEffect, useRef } from 'react'
import {
  timelineLayout, percentLayout, lerpLayout, compositeLayout, runsFromColumns,
  type BandLayout,
} from './timelinePaint'
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

export type StripMode = 'timeline' | 'percent'

const TRANSITION_MS = 620
/** Ease-in-out cubic — settles rather than stopping dead. */
const ease = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)

interface Props {
  bands: Band[]
  marks: Mark[]
  t0: number
  t1: number
  heightPx: number
  label: string
  /** 'timeline' keeps time order; 'percent' regroups by kind. */
  mode?: StripMode
  onHover?: (band: Band | null) => void
}

/**
 * One vertical strip of a run's timeline. Row 0 is the earliest moment, so the
 * past sits at the top and the present at the bottom (R9).
 *
 * Switching mode rearranges the same bar in place — every band slides to join
 * its own kind, and back. Progress lives in a ref because it changes every frame
 * and must not re-render React sixty times a second.
 */
export function TimelineStrip({ bands, marks, t0, t1, heightPx, label, mode = 'timeline', onHover }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const progress = useRef(mode === 'percent' ? 1 : 0)
  const raf = useRef(0)
  /** The layout actually on screen, so hit-testing matches what you see. */
  const shown = useRef<BandLayout | null>(null)

  const paint = useCallback(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    const w = STRIP_W + GUTTER_W
    const wantW = Math.round(w * dpr)
    const wantH = Math.round(heightPx * dpr)
    if (cv.width !== wantW || cv.height !== wantH) { cv.width = wantW; cv.height = wantH }
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, heightPx)

    const px = Math.max(1, Math.round(heightPx))
    const p = progress.current
    const layout = p === 0
      ? timelineLayout(bands, t0, t1, px)
      : p === 1
        ? percentLayout(bands, px)
        : lerpLayout(timelineLayout(bands, t0, t1, px), percentLayout(bands, px), p)
    shown.current = layout

    // One filled path per colour rather than one rect per band (R16).
    const byKind = new Map<BandKind, { start: number; len: number }[]>()
    for (const r of runsFromColumns(compositeLayout(layout, px))) {
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

    // Markers belong to the time axis, so they fade out as it dissolves.
    const markAlpha = 1 - p
    if (markAlpha > 0.01) {
      // Overlapping marks MERGE rather than being dropped — silently discarding
      // them made a burst of failures read as a single one (R12).
      const span = Math.max(t1 - t0, 1e-9)
      const placed = marks
        .filter(m => m.at >= t0 && m.at <= t1)
        .map(m => ({ y: ((m.at - t0) / span) * heightPx, kind: m.kind }))
        .sort((a, b) => a.y - b.y)

      const clusters: { y: number; failed: number; interrupted: number }[] = []
      for (const q of placed) {
        const last = clusters[clusters.length - 1]
        if (last && q.y - last.y < 5) {
          if (q.kind === 'tool-failed') last.failed++
          else last.interrupted++
          continue
        }
        clusters.push({
          y: q.y,
          failed: q.kind === 'tool-failed' ? 1 : 0,
          interrupted: q.kind === 'tool-failed' ? 0 : 1,
        })
      }

      g.globalAlpha = markAlpha
      for (const c of clusters) {
        const y = Math.min(Math.max(c.y, 0), heightPx - 3)
        // Filled for a tool that exited non-zero, hollow for an interrupted
        // sub-agent — the two were previously indistinguishable.
        if (c.failed > 0) {
          g.fillStyle = MARK_COLOR
          g.fillRect(STRIP_W + 2, y, GUTTER_W - 3, c.failed + c.interrupted > 1 ? 3 : 2)
        } else {
          g.strokeStyle = MARK_COLOR
          g.lineWidth = 1
          g.strokeRect(STRIP_W + 2.5, y + 0.5, GUTTER_W - 4, 2)
        }
      }
      g.globalAlpha = 1
    }
  }, [bands, marks, t0, t1, heightPx])

  // Repaint whenever the data or geometry changes, at whatever progress we're at.
  useEffect(() => { paint() }, [paint])

  // Drive the transition when mode flips.
  useEffect(() => {
    const target = mode === 'percent' ? 1 : 0
    if (progress.current === target) return
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) { progress.current = target; paint(); return }

    const from = progress.current
    const delta = target - from
    const started = performance.now()
    cancelAnimationFrame(raf.current)
    const step = (now: number): void => {
      const u = Math.min(1, (now - started) / TRANSITION_MS)
      progress.current = from + delta * ease(u)
      paint()
      if (u < 1) raf.current = requestAnimationFrame(step)
      else { progress.current = target; paint() }
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
  }, [mode, paint])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  /** Hit-test against what is actually drawn, so hovering works in both modes. */
  const hit = (clientY: number): void => {
    if (!onHover) return
    const cv = ref.current
    const layout = shown.current
    if (!cv || !layout) return
    const rect = cv.getBoundingClientRect()
    const y = ((clientY - rect.top) / Math.max(rect.height, 1)) * heightPx
    for (let i = 0; i < layout.pos.length; i++) {
      if (y >= layout.pos[i]! && y <= layout.pos[i]! + layout.len[i]!) { onHover(bands[i] ?? null); return }
    }
    onHover(null)
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
