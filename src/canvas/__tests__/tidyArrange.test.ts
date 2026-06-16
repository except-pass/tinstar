import { describe, it, expect } from 'vitest'
import { tidyGrid, tidyGridClusters, mergeUnitsByConstellation, packBlocksRow } from '../tidyArrange'
import { emptyGraph, addSnap, addMember } from '../../domain/constellationGraph'

type Rect = { x: number; y: number; width: number; height: number }
const rectMap = (rs: Array<Rect & { id: string }>) =>
  new Map(rs.map(r => [r.id, { x: r.x, y: r.y, width: r.width, height: r.height }]))

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

describe('mergeUnitsByConstellation', () => {
  it('keeps each top-level subtree as one block and leaves unrelated units separate', () => {
    const rects = rectMap([
      { id: 'task', x: 0, y: 0, width: 400, height: 300 },
      { id: 'run1', x: 20, y: 40, width: 150, height: 200 },
      { id: 'run2', x: 200, y: 40, width: 150, height: 200 },
      { id: 'browser', x: 900, y: 0, width: 600, height: 400 },
    ])
    const blocks = mergeUnitsByConstellation(
      [['task', 'run1', 'run2'], ['browser']],
      rects,
      emptyGraph('s'),
    )
    expect(blocks).toHaveLength(2)
    expect(blocks.find(b => b.members.some(m => m.id === 'task'))!.members).toHaveLength(3)
  })

  it('fuses two subtrees joined by a snap edge into one block', () => {
    const rects = rectMap([
      { id: 'run', x: 0, y: 0, width: 200, height: 200 },
      { id: 'browser', x: 200, y: 0, width: 300, height: 200 },
    ])
    const g = addSnap(emptyGraph('s'), 'run', 'browser', ['top-right', 'top-left'])
    const blocks = mergeUnitsByConstellation([['run'], ['browser']], rects, g)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.members).toHaveLength(2)
  })

  it('fuses units sharing a constellation slot even without a snap edge', () => {
    const rects = rectMap([
      { id: 'ghscan', x: 0, y: 0, width: 200, height: 200 },
      { id: 'widget', x: 4000, y: 4000, width: 300, height: 200 },
      { id: 'other', x: 800, y: 0, width: 200, height: 200 },
    ])
    // ghscan + widget share slot '1' but are not physically snapped.
    let g = addMember(emptyGraph('s'), 'ghscan', '1')
    g = addMember(g, 'widget', '1')
    const blocks = mergeUnitsByConstellation([['ghscan'], ['widget'], ['other']], rects, g)
    expect(blocks).toHaveLength(2)
    const fused = blocks.find(b => b.members.some(m => m.id === 'ghscan'))!
    expect(fused.members.map(m => m.id).sort()).toEqual(['ghscan', 'widget'])
  })
})

describe('packBlocksRow', () => {
  it('packs blocks left-to-right without overlap and wraps at targetWidth', () => {
    const blocks = [
      { members: [{ id: 'a', x: 0, y: 0, width: 100, height: 100 }], bbox: { x: 0, y: 0, width: 100, height: 100 } },
      { members: [{ id: 'b', x: 0, y: 0, width: 100, height: 100 }], bbox: { x: 0, y: 0, width: 100, height: 100 } },
      { members: [{ id: 'c', x: 0, y: 0, width: 100, height: 100 }], bbox: { x: 0, y: 0, width: 100, height: 100 } },
    ]
    // targetWidth fits 2 per row (100 + 40 + 100 = 240 <= 250; third wraps)
    const out = packBlocksRow(blocks, { x: 0, y: 0 }, 250, 40)
    expect(out.get('a')).toEqual({ x: 0, y: 0 })
    expect(out.get('b')).toEqual({ x: 140, y: 0 })
    expect(out.get('c')).toEqual({ x: 0, y: 140 })
  })

  it('shifts every member of a rigid block by the same delta', () => {
    const blocks = [
      {
        members: [
          { id: 'run', x: 1000, y: 1000, width: 200, height: 200 },
          { id: 'browser', x: 1200, y: 1000, width: 300, height: 200 },
        ],
        bbox: { x: 1000, y: 1000, width: 500, height: 200 },
      },
    ]
    const out = packBlocksRow(blocks, { x: 0, y: 0 }, 2000, 40)
    // bbox top-left (1000,1000) -> (0,0): delta (-1000,-1000)
    expect(out.get('run')).toEqual({ x: 0, y: 0 })
    expect(out.get('browser')).toEqual({ x: 200, y: 0 })
  })
})
