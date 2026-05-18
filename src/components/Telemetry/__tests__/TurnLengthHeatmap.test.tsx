import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TurnLengthHeatmap } from '../TurnLengthHeatmap'

const BUCKETS = [1, 3, 10, 30, 60, 120, 300, 600, 1800, 3600] as const

function emptyCells(): number[][] {
  return Array.from({ length: 10 }, () => Array(30).fill(0))
}

describe('TurnLengthHeatmap', () => {
  it('renders no <rect> elements for an empty matrix', () => {
    const { container } = render(
      <TurnLengthHeatmap cells={emptyCells()} accent="255, 132, 100" windowSec={3600} bucketBounds={BUCKETS} />
    )
    expect(container.querySelectorAll('rect')).toHaveLength(0)
  })

  it('renders one <rect> per non-zero cell', () => {
    const cells = emptyCells()
    cells[2][5] = 3
    cells[7][29] = 1
    cells[9][0] = 7
    const { container } = render(
      <TurnLengthHeatmap cells={cells} accent="255, 132, 100" windowSec={3600} bucketBounds={BUCKETS} />
    )
    const rects = container.querySelectorAll('rect')
    expect(rects).toHaveLength(3)
  })

  it('opacity scales with count / maxCount', () => {
    const cells = emptyCells()
    cells[0][0] = 10  // max
    cells[1][1] = 5
    const { container } = render(
      <TurnLengthHeatmap cells={cells} accent="255, 132, 100" windowSec={3600} bucketBounds={BUCKETS} />
    )
    const rects = Array.from(container.querySelectorAll('rect'))
    const fills = rects.map(r => r.getAttribute('fill'))
    expect(fills.some(f => f?.endsWith('1.00)'))).toBe(true)
    expect(fills.some(f => f?.endsWith('0.50)'))).toBe(true)
  })

  it('renders all 10 Y-axis bucket labels', () => {
    const { container } = render(
      <TurnLengthHeatmap cells={emptyCells()} accent="255, 132, 100" windowSec={3600} bucketBounds={BUCKETS} />
    )
    const texts = container.querySelectorAll('text')
    // 10 Y labels + 2 X labels (-60m, now) = 12 total
    expect(texts.length).toBeGreaterThanOrEqual(10)
  })
})
