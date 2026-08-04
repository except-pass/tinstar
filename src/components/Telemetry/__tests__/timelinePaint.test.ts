import { describe, it, expect } from 'vitest'
import { compositeColumns, runsFromColumns, timelineLayout, percentLayout, lerpLayout } from '../timelinePaint'
import type { Band } from '../../../server/sessions/timeline/types'

const band = (start: number, end: number, kind: Band['kind']): Band =>
  ({ start, end, kind, name: 'x', detail: '' })

describe('compositeColumns', () => {
  it('gives a pixel to the kind that occupies most of it (R11)', () => {
    // 10s per pixel; pixel 0 is 9s idle + 1s tool
    const cols = compositeColumns([band(0, 9, 'idle'), band(9, 10, 'tool')], 0, 100, 10)
    expect(cols[0]).toBe('idle')
  })

  it('lets a sliver of approval win the pixel outright (R11, AE5)', () => {
    // one pixel spans 1200s; a 4s approval must still show
    const cols = compositeColumns(
      [band(0, 600, 'tool'), band(600, 604, 'approval'), band(604, 1200, 'tool')],
      0, 1200, 1,
    )
    expect(cols[0]).toBe('approval')
  })

  it('lets a sliver of question win the pixel outright', () => {
    const cols = compositeColumns(
      [band(0, 600, 'tool'), band(600, 604, 'question'), band(604, 1200, 'tool')],
      0, 1200, 1,
    )
    expect(cols[0]).toBe('question')
  })

  it('does not let tool outrank idle on occupancy alone (R11)', () => {
    // The bug that made a 73%-idle session read as busy: pure priority handed
    // every pixel containing any tool call to `tool`.
    const bands: Band[] = []
    for (let i = 0; i < 100; i++) {
      bands.push(band(i * 100, i * 100 + 99, 'idle'), band(i * 100 + 99, (i + 1) * 100, 'tool'))
    }
    const cols = compositeColumns(bands, 0, 10_000, 10)
    expect(cols.every(c => c === 'idle')).toBe(true)
  })

  it('prefers approval over question when both touch one pixel', () => {
    const cols = compositeColumns(
      [band(0, 5, 'question'), band(5, 10, 'approval'), band(10, 1200, 'tool')],
      0, 1200, 1,
    )
    expect(cols[0]).toBe('approval')
  })

  it('covers every column when bands tile the span', () => {
    const cols = compositeColumns([band(0, 50, 'tool'), band(50, 100, 'idle')], 0, 100, 20)
    expect(cols).toHaveLength(20)
    expect(cols.every(c => c !== null)).toBe(true)
  })

  it('leaves columns null where nothing is observed', () => {
    const cols = compositeColumns([band(0, 10, 'tool')], 0, 100, 10)
    expect(cols[0]).toBe('tool')
    expect(cols[9]).toBeNull()
  })
})

describe('runsFromColumns', () => {
  it('collapses equal neighbours into one run', () => {
    expect(runsFromColumns(['tool', 'tool', 'idle', 'idle', 'idle'])).toEqual([
      { kind: 'tool', start: 0, len: 2 },
      { kind: 'idle', start: 2, len: 3 },
    ])
  })

  it('skips null columns', () => {
    expect(runsFromColumns([null, 'tool', null])).toEqual([{ kind: 'tool', start: 1, len: 1 }])
  })

  it('returns nothing for an empty column set', () => {
    expect(runsFromColumns([])).toEqual([])
  })

  it('emits one run per colour change, not one per column (R16)', () => {
    // 1,000 alternating columns must not become 1,000 draw calls' worth of runs
    // when they are actually only two colours in two blocks.
    const cols = [...Array(500).fill('tool'), ...Array(500).fill('idle')] as ('tool' | 'idle')[]
    expect(runsFromColumns(cols)).toHaveLength(2)
  })
})

describe('percentLayout', () => {
  const b = (start: number, end: number, kind: Band['kind']): Band =>
    ({ start, end, kind, name: 'x', detail: '' })

  it('groups bands by kind and fills the strip exactly', () => {
    const bands = [b(0, 10, 'tool'), b(10, 30, 'idle'), b(30, 40, 'tool')]
    const l = percentLayout(bands, 100)
    const total = [...l.len].reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(100, 6)
  })

  it('places like with like — the two tool bands become adjacent', () => {
    // This is what makes the transition read as "slide together": every band
    // has exactly one destination, beside its own kind.
    const bands = [b(0, 10, 'tool'), b(10, 30, 'idle'), b(30, 40, 'tool')]
    const l = percentLayout(bands, 100)
    const end0 = l.pos[0]! + l.len[0]!
    expect(l.pos[2]).toBeCloseTo(end0, 6)   // tool, tool
    expect(l.pos[1]).toBeCloseTo(end0 + l.len[2]!, 6) // then idle
  })

  it('preserves each kind proportionally', () => {
    const bands = [b(0, 25, 'tool'), b(25, 100, 'idle')]
    const l = percentLayout(bands, 200)
    expect(l.len[0]).toBeCloseTo(50, 6)   // 25%
    expect(l.len[1]).toBeCloseTo(150, 6)  // 75%
  })

  it('orders kinds by BAND_KINDS, so approval leads', () => {
    const bands = [b(0, 10, 'tool'), b(10, 20, 'approval')]
    const l = percentLayout(bands, 100)
    expect(l.pos[1]).toBe(0)
  })
})

describe('lerpLayout', () => {
  const b = (start: number, end: number, kind: Band['kind']): Band =>
    ({ start, end, kind, name: 'x', detail: '' })

  it('returns the endpoints exactly at p=0 and p=1', () => {
    const bands = [b(0, 10, 'tool'), b(10, 30, 'idle')]
    const A = timelineLayout(bands, 0, 30, 90)
    const B = percentLayout(bands, 90)
    expect([...lerpLayout(A, B, 0).pos]).toEqual([...A.pos])
    expect([...lerpLayout(A, B, 1).pos]).toEqual([...B.pos])
  })

  it('keeps total length stable mid-transition, so the bar never gaps', () => {
    const bands = [b(0, 10, 'tool'), b(10, 30, 'idle'), b(30, 60, 'think')]
    const A = timelineLayout(bands, 0, 60, 120)
    const B = percentLayout(bands, 120)
    for (const p of [0.25, 0.5, 0.75]) {
      const total = [...lerpLayout(A, B, p).len].reduce((s, v) => s + v, 0)
      expect(total).toBeCloseTo(120, 4)
    }
  })
})
