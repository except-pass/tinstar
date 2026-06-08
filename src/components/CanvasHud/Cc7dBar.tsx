import type { JSX } from 'react'
import type { UsageBucket } from '../../hooks/useCcQuota'

interface Props {
  bucket: UsageBucket | null
  nowMs?: number
}

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const CELL_W = 16, CELL_H = 10, GAP = 2, ROW_GAP = 3
const PAD_X = 2, PAD_Y = 3
const ROW_W = 7 * CELL_W + 6 * GAP

type State = 'ok' | 'warn' | 'bad'
function classify(usedRatio: number, timeRatio: number): State {
  const deficit = usedRatio - timeRatio
  if (usedRatio >= 1 && timeRatio < 1) return 'bad'
  if (deficit > 0.20) return 'bad'
  if (deficit > 0)    return 'warn'
  return 'ok'
}
const COLOR: Record<State, string> = { ok: '#f59e0b', warn: '#f97316', bad: '#ef4444' }

function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function startOfWeekSun(ms: number): number {
  const d = new Date(startOfLocalDay(ms))
  d.setDate(d.getDate() - d.getDay())
  return d.getTime()
}
function addDays(ms: number, n: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

interface Cell {
  x: number; y: number
  dayStart: number; dayEnd: number
  inWindow: boolean
}

export function Cc7dBar({ bucket, nowMs }: Props) {
  const now = nowMs ?? Date.now()
  const vbW = ROW_W + PAD_X * 2

  if (!bucket) {
    const vbH = PAD_Y * 2 + CELL_H + 8
    return (
      <svg viewBox={`0 0 ${vbW} ${vbH}`} width={vbW} height={vbH} aria-label="7D quota (no data)">
        {[0,1,2,3,4,5,6].map(c => (
          <rect key={c} x={PAD_X + c * (CELL_W + GAP)} y={PAD_Y}
                width={CELL_W} height={CELL_H} rx={2}
                fill="rgba(255,255,255,0.09)"/>
        ))}
        <text x={vbW / 2} y={PAD_Y + CELL_H + 8} textAnchor="middle" fontSize="8"
              fill="rgba(255,255,255,0.55)" fontFamily="JetBrains Mono, monospace">--</text>
      </svg>
    )
  }

  const resetMs = Date.parse(bucket.resets_at)
  const startMs = resetMs - CYCLE_MS
  const week1 = startOfWeekSun(startMs)
  const week2 = startOfWeekSun(startOfLocalDay(resetMs - 1))
  const weekStarts = week1 === week2 ? [week1] : [week1, week2]

  const timeRatio = Math.max(0, Math.min(1, 1 - (resetMs - now) / CYCLE_MS))
  const usedRatio = Math.max(0, Math.min(1, bucket.utilization / 100))
  const remainingRatio = 1 - usedRatio
  const state = classify(usedRatio, timeRatio)
  const color = COLOR[state]

  const fillEdgeMs = startMs + usedRatio * CYCLE_MS
  const deficitLoMs = Math.min(fillEdgeMs, now)
  const deficitHiMs = Math.max(fillEdgeMs, now)
  const hasDeficit = state !== 'ok' && usedRatio < 1

  const cells: Cell[] = []
  for (let r = 0; r < weekStarts.length; r++) {
    for (let c = 0; c < 7; c++) {
      const dayStart = addDays(weekStarts[r]!, c)   // r < weekStarts.length
      const dayEnd = addDays(dayStart, 1)
      cells.push({
        x: PAD_X + c * (CELL_W + GAP),
        y: PAD_Y + r * (CELL_H + ROW_GAP),
        dayStart,
        dayEnd,
        inWindow: dayStart < resetMs && dayEnd > startMs,
      })
    }
  }

  function slice(cell: Cell, loMs: number, hiMs: number): { x: number; w: number } | null {
    const lo = Math.max(cell.dayStart, loMs)
    const hi = Math.min(cell.dayEnd, hiMs)
    if (hi <= lo) return null
    const xL = cell.x + ((lo - cell.dayStart) / DAY_MS) * CELL_W
    const xR = cell.x + ((hi - cell.dayStart) / DAY_MS) * CELL_W
    return { x: xL, w: xR - xL }
  }
  function xAt(cell: Cell, t: number): number {
    return cell.x + ((t - cell.dayStart) / DAY_MS) * CELL_W
  }

  const troughEls: JSX.Element[] = []
  const fillEls: JSX.Element[] = []
  const deficitEls: JSX.Element[] = []

  cells.forEach((cell, i) => {
    troughEls.push(
      <rect key={`bg-${i}`} {...(i === 0 ? { 'data-testid': 'bar-trough' } : {})}
            x={cell.x} y={cell.y} width={CELL_W} height={CELL_H} rx={2}
            fill="rgba(255,255,255,0.04)"/>
    )
    if (!cell.inWindow) return
    const windowSlice = slice(cell, startMs, resetMs)
    if (windowSlice) {
      troughEls.push(
        <rect key={`tw-${i}`}
              x={windowSlice.x} y={cell.y} width={windowSlice.w} height={CELL_H} rx={2}
              fill="rgba(255,255,255,0.12)"/>
      )
    }
    if (hasDeficit) {
      const s = slice(cell, deficitLoMs, deficitHiMs)
      if (s) {
        deficitEls.push(
          <rect key={`d-${i}`} {...(deficitEls.length === 0 ? { 'data-testid': 'bar-deficit' } : {})}
                x={s.x} y={cell.y} width={s.w} height={CELL_H}
                fill={`${color}33`}/>
        )
      }
    }
    if (usedRatio < 1) {
      const s = slice(cell, fillEdgeMs, resetMs)
      if (s) {
        fillEls.push(
          <rect key={`f-${i}`} {...(fillEls.length === 0 ? { 'data-testid': 'bar-fill' } : {})}
                data-state={state}
                x={s.x} y={cell.y} width={s.w} height={CELL_H} rx={2}
                fill={color}/>
        )
      }
    }
  })

  const playheadCell = cells.find(c => c.inWindow && now >= c.dayStart && now < c.dayEnd)
  const resetCell = cells.find(c => c.inWindow && resetMs > c.dayStart && resetMs <= c.dayEnd)
  const fillEdgeCell = usedRatio < 1 && remainingRatio < 0.9999
    ? cells.find(c => c.inWindow && fillEdgeMs >= c.dayStart && fillEdgeMs <= c.dayEnd)
    : undefined

  const vbH = PAD_Y * 2 + weekStarts.length * CELL_H + (weekStarts.length - 1) * ROW_GAP

  return (
    <svg viewBox={`0 0 ${vbW} ${vbH}`} width={vbW} height={vbH}
         aria-label={`7D quota ${Math.round(remainingRatio * 100)}% left`}>
      {troughEls}
      {deficitEls}
      {fillEls}
      {resetCell && (
        <circle data-testid="bar-reset"
                cx={xAt(resetCell, resetMs)} cy={resetCell.y + CELL_H / 2}
                r={2.4} fill="#0a0f18" stroke="#f1f5f9" strokeWidth={1.2}/>
      )}
      {playheadCell && (
        <line data-testid="bar-playhead"
              x1={xAt(playheadCell, now)} y1={playheadCell.y - 2}
              x2={xAt(playheadCell, now)} y2={playheadCell.y + CELL_H + 2}
              stroke="#f1f5f9" strokeWidth={1.5}/>
      )}
      {fillEdgeCell && (
        <circle cx={xAt(fillEdgeCell, fillEdgeMs)} cy={fillEdgeCell.y + CELL_H / 2}
                r={1.7} fill="#0a0f18" stroke={color} strokeWidth={1.2}/>
      )}
    </svg>
  )
}
