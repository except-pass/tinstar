import { describe, it, expect } from 'vitest'
import { deriveData, TURN_LENGTH_BUCKETS } from '../useTurnLengthObservations'

const now = Math.floor(Date.now() / 1000)

function ob(tsSec: number, sec: number, session = 's') {
  return { tsSec, sec, session, ccConvId: 'c' }
}

describe('deriveData', () => {
  it('returns empty cells and undefined percentiles for n=0', () => {
    const d = deriveData([], 3600)
    expect(d.n).toBe(0)
    expect(d.p50).toBeUndefined()
    expect(d.p95).toBeUndefined()
    expect(d.cells).toHaveLength(10)
    expect(d.cells[0]).toHaveLength(30)
    expect(d.cells.flat().every(v => v === 0)).toBe(true)
  })

  it('places observations into correct value bucket', () => {
    const obs = [
      ob(now, 0.5),    // <= 1 → bucket 0
      ob(now, 3),      // <= 3 → bucket 1
      ob(now, 10),     // <= 10 → bucket 2
      ob(now, 11),     // <= 30 → bucket 3
      ob(now, 4000),   // > 3600 → falls through to last bucket 9
    ]
    const d = deriveData(obs, 3600)
    const colCounts = d.cells.map(row => row.reduce((a, b) => a + b, 0))
    expect(colCounts[0]).toBe(1)  // <=1
    expect(colCounts[1]).toBe(1)  // <=3
    expect(colCounts[2]).toBe(1)  // <=10
    expect(colCounts[3]).toBe(1)  // <=30
    expect(colCounts[9]).toBe(1)  // overflow
  })

  it('places observations into correct time column', () => {
    // 60m window, 30 columns → 120s per column
    const windowSec = 3600
    const obs = [
      ob(now - 3500, 5),   // ~oldest, near col 0
      ob(now - 1800, 5),   // middle, near col 15
      ob(now - 30,   5),   // newest, col 29
    ]
    const d = deriveData(obs, windowSec)
    // Find which columns are non-empty in bucket 2 (<= 10)
    const cols = d.cells[2].map((v, i) => v > 0 ? i : -1).filter(i => i >= 0)
    expect(cols[0]).toBeLessThanOrEqual(2)
    expect(cols[1]).toBeGreaterThan(10)
    expect(cols[1]).toBeLessThan(20)
    expect(cols[2]).toBeGreaterThanOrEqual(28)
  })

  it('computes p50 and p95 from raw sec values', () => {
    const obs = Array.from({ length: 100 }, (_, i) => ob(now, i + 1))  // [1, 2, ..., 100]
    const d = deriveData(obs, 3600)
    expect(d.p50).toBe(51)  // floor(100*0.5)=50 → sorted[50] = 51
    expect(d.p95).toBe(96)  // floor(100*0.95)=95 → sorted[95] = 96
    expect(d.n).toBe(100)
  })

  it('p95 falls back to max when index would exceed length', () => {
    const obs = [ob(now, 5)]
    const d = deriveData(obs, 3600)
    expect(d.p50).toBe(5)
    expect(d.p95).toBe(5)
  })

  it('TURN_LENGTH_BUCKETS matches Prom histogram bucket boundaries', () => {
    expect(TURN_LENGTH_BUCKETS).toEqual([1, 3, 10, 30, 60, 120, 300, 600, 1800, 3600])
  })
})
