import type { JSX } from 'react'
import type { QuotaWindowReading } from '../server/quota/parse'

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const CELL_W = 22
const CELL_H = 12
const GAP = 3
const ROW_GAP = 3
const PAD_X = 1
const PAD_Y = 3
const LABEL_H = 11
const ROW_W = 7 * CELL_W + 6 * GAP
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

type Pace = 'ok' | 'warn' | 'bad'

function paceOf(usedRatio: number, timeRatio: number): Pace {
  const deficit = usedRatio - timeRatio
  if (usedRatio >= 1 && timeRatio < 1) return 'bad'
  if (deficit > 0.20) return 'bad'
  if (deficit > 0) return 'warn'
  return 'ok'
}

const COLOR: Record<Pace, string> = { ok: '#f59e0b', warn: '#f97316', bad: '#ef4444' }

function startOfLocalDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function startOfWeekSun(ms: number): number {
  const date = new Date(startOfLocalDay(ms))
  date.setDate(date.getDate() - date.getDay())
  return date.getTime()
}

function addDays(ms: number, days: number): number {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

interface Cell {
  x: number
  y: number
  dayStart: number
  dayEnd: number
  inWindow: boolean
}

/**
 * Seven-day calendar strip from the earlier quota card: Sunday weeks the
 * window touches, remaining quota anchored at the reset, and a now-line.
 */
export function WeeklyStrip({ window, now }: { window: QuotaWindowReading; now: number }) {
  const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
  const vbW = ROW_W + PAD_X * 2
  if (!Number.isFinite(resetMs)) {
    const vbH = PAD_Y * 2 + CELL_H + LABEL_H
    return (
      <svg className="cockpit-quota-strip" viewBox={`0 0 ${vbW} ${vbH}`} aria-hidden="true">
        {WEEKDAYS.map((label, column) => (
          <g key={label}>
            <rect x={PAD_X + column * (CELL_W + GAP)} y={PAD_Y} width={CELL_W} height={CELL_H} rx={2} fill="rgba(255,255,255,0.09)" />
            <text className="cockpit-quota-day" x={PAD_X + column * (CELL_W + GAP) + CELL_W / 2} y={PAD_Y + CELL_H + 9} textAnchor="middle">{label}</text>
          </g>
        ))}
      </svg>
    )
  }

  const startMs = resetMs - CYCLE_MS
  const week1 = startOfWeekSun(startMs)
  const week2 = startOfWeekSun(startOfLocalDay(resetMs - 1))
  const weekStarts = week1 === week2 ? [week1] : [week1, week2]
  const remainingRatio = window.remainingPercent == null ? null : Math.max(0, Math.min(1, window.remainingPercent / 100))
  const usedRatio = remainingRatio == null ? null : 1 - remainingRatio
  const timeRatio = Math.max(0, Math.min(1, 1 - (resetMs - now) / CYCLE_MS))
  const pace = usedRatio == null ? null : paceOf(usedRatio, timeRatio)
  const color = pace ? COLOR[pace] : '#f59e0b'
  const fillEdgeMs = usedRatio == null ? null : startMs + usedRatio * CYCLE_MS
  const hasDeficit = pace != null && pace !== 'ok' && usedRatio != null && usedRatio < 1 && fillEdgeMs != null
  const deficitLoMs = fillEdgeMs == null ? 0 : Math.min(fillEdgeMs, now)
  const deficitHiMs = fillEdgeMs == null ? 0 : Math.max(fillEdgeMs, now)

  const cells: Cell[] = []
  for (let row = 0; row < weekStarts.length; row++) {
    for (let column = 0; column < 7; column++) {
      const dayStart = addDays(weekStarts[row]!, column)
      cells.push({
        x: PAD_X + column * (CELL_W + GAP),
        y: PAD_Y + row * (CELL_H + ROW_GAP),
        dayStart,
        dayEnd: addDays(dayStart, 1),
        inWindow: dayStart < resetMs && addDays(dayStart, 1) > startMs,
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

  function xAt(cell: Cell, time: number): number {
    return cell.x + ((time - cell.dayStart) / DAY_MS) * CELL_W
  }

  const trough: JSX.Element[] = []
  const deficit: JSX.Element[] = []
  const fill: JSX.Element[] = []
  cells.forEach((cell, index) => {
    trough.push(<rect key={`bg-${index}`} x={cell.x} y={cell.y} width={CELL_W} height={CELL_H} rx={2} fill="rgba(255,255,255,0.04)" />)
    if (!cell.inWindow) return
    const windowSlice = slice(cell, startMs, resetMs)
    if (windowSlice) {
      trough.push(<rect key={`tw-${index}`} {...(index === cells.findIndex(item => item.inWindow) ? { 'data-testid': 'bar-trough' } : {})} x={windowSlice.x} y={cell.y} width={windowSlice.w} height={CELL_H} rx={2} fill="rgba(255,255,255,0.12)" />)
    }
    if (hasDeficit) {
      const band = slice(cell, deficitLoMs, deficitHiMs)
      if (band) deficit.push(<rect key={`d-${index}`} {...(deficit.length === 0 ? { 'data-testid': 'bar-deficit' } : {})} x={band.x} y={cell.y} width={band.w} height={CELL_H} fill={`${color}33`} />)
    }
    if (fillEdgeMs != null && usedRatio != null && usedRatio < 1) {
      const band = slice(cell, fillEdgeMs, resetMs)
      if (band) {
        fill.push(<rect key={`f-${index}`} {...(fill.length === 0 ? { 'data-testid': 'bar-fill' } : {})} data-state={pace ?? undefined} x={band.x} y={cell.y} width={band.w} height={CELL_H} rx={2} fill={color} />)
      }
    }
  })

  const playheadCell = cells.find(cell => cell.inWindow && now >= cell.dayStart && now < cell.dayEnd)
  const resetCell = cells.find(cell => cell.inWindow && resetMs > cell.dayStart && resetMs <= cell.dayEnd)
  const fillEdgeCell = fillEdgeMs != null && usedRatio != null && usedRatio > 0 && usedRatio < 1
    ? cells.find(cell => cell.inWindow && fillEdgeMs >= cell.dayStart && fillEdgeMs <= cell.dayEnd)
    : undefined
  const rows = weekStarts.length
  const labelY = PAD_Y + rows * CELL_H + (rows - 1) * ROW_GAP + 9
  const vbH = labelY + 2

  return (
    <svg className="cockpit-quota-strip" viewBox={`0 0 ${vbW} ${vbH}`} aria-hidden="true">
      {trough}
      {deficit}
      {fill}
      {resetCell && <circle data-testid="bar-reset" cx={xAt(resetCell, resetMs)} cy={resetCell.y + CELL_H / 2} r={2.2} fill="#0a0e12" stroke="#f1f5f9" strokeWidth={1.2} />}
      {playheadCell && <line data-testid="bar-playhead" x1={xAt(playheadCell, now)} y1={playheadCell.y - 2} x2={xAt(playheadCell, now)} y2={playheadCell.y + CELL_H + 2} stroke="#f1f5f9" strokeWidth={1.5} />}
      {fillEdgeCell && <circle cx={xAt(fillEdgeCell, fillEdgeMs!)} cy={fillEdgeCell.y + CELL_H / 2} r={1.6} fill="#0a0e12" stroke={color} strokeWidth={1.2} />}
      {WEEKDAYS.map((label, column) => (
        <text key={label} className="cockpit-quota-day" data-testid="weekday-label" x={PAD_X + column * (CELL_W + GAP) + CELL_W / 2} y={labelY} textAnchor="middle">{label}</text>
      ))}
    </svg>
  )
}
