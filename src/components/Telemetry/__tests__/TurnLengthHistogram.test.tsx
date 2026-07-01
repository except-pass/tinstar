import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TurnLengthHistogram } from '../TurnLengthHistogram'

const BUCKETS = [1, 3, 10, 30, 60, 120, 300, 600, 1800, 3600] as const

function emptyCells(): number[][] {
  return Array.from({ length: 10 }, () => Array(30).fill(0))
}

describe('TurnLengthHistogram', () => {
  it('renders no bar <rect> elements for an empty matrix', () => {
    const { container } = render(
      <TurnLengthHistogram cells={emptyCells()} accent="255, 132, 100" bucketBounds={BUCKETS} />
    )
    expect(container.querySelectorAll('rect')).toHaveLength(0)
  })

  it('renders one bar per non-empty bucket (collapsed across time)', () => {
    const cells = emptyCells()
    cells[2]![5] = 3       // bucket 2
    cells[2]![10] = 1      // same bucket — should still be one bar
    cells[7]![29] = 1      // bucket 7
    cells[9]![0] = 7       // bucket 9
    const { container } = render(
      <TurnLengthHistogram cells={cells} accent="255, 132, 100" bucketBounds={BUCKETS} />
    )
    const rects = container.querySelectorAll('rect')
    expect(rects).toHaveLength(3)
    const counts = Array.from(rects).map(r => Number(r.getAttribute('data-count')))
    expect(counts.sort((a, b) => a - b)).toEqual([1, 4, 7])
  })

  it('tallest bar corresponds to the bucket with the highest total', () => {
    const cells = emptyCells()
    cells[0]![0] = 10
    cells[1]![1] = 5
    const { container } = render(
      <TurnLengthHistogram cells={cells} accent="255, 132, 100" bucketBounds={BUCKETS} />
    )
    const rects = Array.from(container.querySelectorAll('rect'))
    const heights = rects.map(r => Number(r.getAttribute('height')))
    expect(Math.max(...heights)).toBe(90) // plotH for max bucket
  })

  it('renders all 10 X-axis bucket labels', () => {
    const { container } = render(
      <TurnLengthHistogram cells={emptyCells()} accent="255, 132, 100" bucketBounds={BUCKETS} />
    )
    const texts = container.querySelectorAll('text')
    // 10 X labels + 2 Y labels (0, max) = 12
    expect(texts.length).toBeGreaterThanOrEqual(10)
  })

  it('draws no whisker when toolStats is omitted', () => {
    const cells = emptyCells()
    cells[2]![5] = 3
    const { container } = render(
      <TurnLengthHistogram cells={cells} accent="255, 132, 100" bucketBounds={BUCKETS} />
    )
    expect(container.querySelectorAll('[data-tool-whisker]')).toHaveLength(0)
  })

  it('draws a whisker glyph only for buckets that have both turns and tool stats', () => {
    const cells = emptyCells()
    cells[2]![5] = 3   // bucket 2 has turns
    cells[7]![0] = 1   // bucket 7 has turns but no tool stats
    const toolStats = Array.from({ length: 10 }, () => null) as (
      | { p10: number; p50: number; p90: number; n: number }
      | null
    )[]
    toolStats[2] = { p10: 1, p50: 4, p90: 9, n: 3 }
    const { container } = render(
      <TurnLengthHistogram cells={cells} accent="255, 132, 100" bucketBounds={BUCKETS} toolStats={toolStats} />
    )
    const whiskers = container.querySelectorAll('[data-tool-whisker]')
    expect(whiskers).toHaveLength(1)
    const w = whiskers[0]!
    expect(w.getAttribute('data-tool-whisker')).toBe('2')
    expect(w.getAttribute('data-tool-p90')).toBe('9')
    // range line + 2 caps + p50 dot
    expect(w.querySelectorAll('line')).toHaveLength(3)
    expect(w.querySelectorAll('circle')).toHaveLength(1)
  })

  it('places a higher p90 whisker cap above a lower one (shared tool scale)', () => {
    const cells = emptyCells()
    cells[1]![0] = 2
    cells[5]![0] = 2
    const toolStats = Array.from({ length: 10 }, () => null) as (
      | { p10: number; p50: number; p90: number; n: number }
      | null
    )[]
    toolStats[1] = { p10: 0, p50: 1, p90: 2, n: 2 }    // few tools
    toolStats[5] = { p10: 4, p50: 8, p90: 10, n: 2 }   // many tools → whisker reaches top
    const { container } = render(
      <TurnLengthHistogram cells={cells} accent="255, 132, 100" bucketBounds={BUCKETS} toolStats={toolStats} />
    )
    const cap = (bucket: string) => {
      const g = container.querySelector(`[data-tool-whisker="${bucket}"]`)!
      // first <line> is the range line from p10 to p90; its y2 is the p90 cap height
      return Number(g.querySelector('line')!.getAttribute('y2'))
    }
    // Higher tool count → smaller y (SVG y grows downward). toolMax=10, so bucket 5's p90 sits at the top.
    expect(cap('5')).toBeLessThan(cap('1'))
  })
})
