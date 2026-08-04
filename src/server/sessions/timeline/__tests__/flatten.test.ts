import { describe, it, expect } from 'vitest'
import { flatten } from '../flatten'
import type { Interval } from '../types'

const iv = (start: number, end: number, kind: Interval['kind'], name = 'x'): Interval =>
  ({ start, end, kind, name, detail: '' })

describe('flatten', () => {
  it('tiles the whole span with no gaps and no overlaps', () => {
    const bands = flatten([iv(10, 20, 'tool')], 0, 30)
    expect(bands.map(b => [b.start, b.end, b.kind])).toEqual([
      [0, 10, 'think'], [10, 20, 'tool'], [20, 30, 'think'],
    ])
    const total = bands.reduce((s, b) => s + (b.end - b.start), 0)
    expect(total).toBe(30)
  })

  it('gives an overlap to the higher-priority kind', () => {
    // a script that shells out: an approval nested inside a tool span
    const bands = flatten([iv(0, 100, 'tool'), iv(40, 60, 'approval')], 0, 100)
    expect(bands.map(b => [b.start, b.end, b.kind])).toEqual([
      [0, 40, 'tool'], [40, 60, 'approval'], [60, 100, 'tool'],
    ])
  })

  it('never double-counts overlapping intervals', () => {
    const bands = flatten([iv(0, 60, 'tool'), iv(30, 90, 'subagent')], 0, 90)
    const total = bands.reduce((s, b) => s + (b.end - b.start), 0)
    expect(total).toBe(90)
  })

  it('returns a single think band when there are no intervals', () => {
    expect(flatten([], 5, 15)).toEqual([
      { start: 5, end: 15, kind: 'think', name: 'model thinking', detail: '' },
    ])
  })

  it('merges neighbours a boundary split apart', () => {
    // one tool call crossed by another interval's boundary must stay one band
    const bands = flatten([iv(0, 100, 'tool', 'exec'), iv(200, 300, 'tool', 'exec')], 0, 300)
    expect(bands.map(b => b.kind)).toEqual(['tool', 'think', 'tool'])
  })

  it('drops zero-length and inverted intervals', () => {
    const bands = flatten([iv(10, 10, 'tool'), iv(30, 20, 'approval')], 0, 40)
    expect(bands).toEqual([
      { start: 0, end: 40, kind: 'think', name: 'model thinking', detail: '' },
    ])
  })
})
