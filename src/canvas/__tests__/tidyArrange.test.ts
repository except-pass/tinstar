import { describe, it, expect } from 'vitest'
import { tidyGrid, tidyGridClusters } from '../tidyArrange'
import { emptyGraph, addSnap } from '../../domain/constellationGraph'

describe('tidyGrid', () => {
  it('arranges 4 widgets in a 2x2 grid centered on centroid', () => {
    const layouts = [
      { id: 'a', x: 0,   y: 0,   width: 100, height: 100 },
      { id: 'b', x: 500, y: 500, width: 100, height: 100 },
      { id: 'c', x: 0,   y: 500, width: 100, height: 100 },
      { id: 'd', x: 500, y: 0,   width: 100, height: 100 },
    ]
    // Widget centers: a=(50,50), b=(550,550), c=(50,550), d=(550,50)
    // Centroid = ((50+550+50+550)/4, (50+550+550+50)/4) = (300, 300)
    // Grid 2x2, gap=40, cellW=cellH=100
    // totalW = 2*100 + 1*40 = 240; totalH = 240
    // origin = (300 - 120, 300 - 120) = (180, 180)
    const out = tidyGrid(layouts, 40)
    expect(out.get('a')).toEqual({ x: 180, y: 180 })
    expect(out.get('b')).toEqual({ x: 180 + 140, y: 180 })
    expect(out.get('c')).toEqual({ x: 180, y: 180 + 140 })
    expect(out.get('d')).toEqual({ x: 180 + 140, y: 180 + 140 })
  })

  it('returns empty map for empty input', () => {
    expect(tidyGrid([], 40).size).toBe(0)
  })
})

describe('tidyGridClusters', () => {
  it('keeps a snapped pair flush (same relative offset) after arrange', () => {
    const g = addSnap(emptyGraph('s'), 'a', 'b', ['top-right', 'top-left'])
    const layouts = [
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', x: 100, y: 0, width: 100, height: 100 },
      { id: 'c', x: 500, y: 500, width: 100, height: 100 },
    ]
    const out = tidyGridClusters(layouts, g, 40)
    const a = out.get('a')!, b = out.get('b')!
    expect(b.x - a.x).toBe(100)
    expect(b.y - a.y).toBe(0)
  })
})
