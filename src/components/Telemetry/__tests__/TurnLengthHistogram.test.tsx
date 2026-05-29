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
    cells[2][5] = 3       // bucket 2
    cells[2][10] = 1      // same bucket — should still be one bar
    cells[7][29] = 1      // bucket 7
    cells[9][0] = 7       // bucket 9
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
    cells[0][0] = 10
    cells[1][1] = 5
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
})
