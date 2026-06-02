import { describe, it, expect } from 'vitest'
import { centroidOf, boundingBoxOf, applyGroupDrag, fitToRect, computeBreakLinks, planLinkBreak, occupiedEdgesOf } from '../constellationCohesion'
import type { Rect, IdRect } from '../constellationCohesion'

const R = (x: number, y: number, w = 100, h = 100): Rect =>
  ({ x, y, width: w, height: h })

const IR = (id: string, x: number, y: number, w = 100, h = 100): IdRect =>
  ({ id, x, y, width: w, height: h })

describe('computeBreakLinks', () => {
  it('returns no links for a single widget', () => {
    expect(computeBreakLinks([IR('a', 0, 0)])).toEqual([])
  })

  it('places a link carrying the pair ids at the vertical seam of two flush widgets', () => {
    expect(computeBreakLinks([IR('a', 0, 0), IR('b', 100, 0)]))
      .toEqual([{ x: 100, y: 50, aId: 'a', bId: 'b' }])
  })

  it('places a link at the horizontal seam between two flush stacked widgets', () => {
    expect(computeBreakLinks([IR('a', 0, 0), IR('b', 0, 100)]))
      .toEqual([{ x: 50, y: 100, aId: 'a', bId: 'b' }])
  })

  it('finds a seam for each adjacent pair in a row of three', () => {
    const links = computeBreakLinks([IR('a', 0, 0), IR('b', 100, 0), IR('c', 200, 0)])
    expect(links).toEqual([
      { x: 100, y: 50, aId: 'a', bId: 'b' },
      { x: 200, y: 50, aId: 'b', bId: 'c' },
    ])
  })

  it('ignores widgets that are far apart (not stuck)', () => {
    expect(computeBreakLinks([IR('a', 0, 0), IR('b', 500, 0)])).toEqual([])
  })
})

describe('planLinkBreak', () => {
  it('frees both widgets when breaking the only link of a pair', () => {
    const plan = planLinkBreak([IR('a', 0, 0), IR('b', 100, 0)], 'a', 'b')
    expect(plan.removeFromSlot.sort()).toEqual(['a', 'b'])
    expect(plan.newGroup).toEqual([])
  })

  it('frees the lone widget and keeps the rest grouped in a 3-chain', () => {
    // a-b-c; break a-b → {a} freed, {b,c} keep the slot
    const plan = planLinkBreak([IR('a', 0, 0), IR('b', 100, 0), IR('c', 200, 0)], 'a', 'b')
    expect(plan.removeFromSlot).toEqual(['a'])
    expect(plan.newGroup).toEqual([])
  })

  it('splits a 4-chain into two grouped halves', () => {
    // a-b-c-d; break b-c → {a,b} keep slot, {c,d} move to a new group
    const plan = planLinkBreak(
      [IR('a', 0, 0), IR('b', 100, 0), IR('c', 200, 0), IR('d', 300, 0)], 'b', 'c',
    )
    expect(plan.removeFromSlot.sort()).toEqual(['c', 'd'])
    expect(plan.newGroup.sort()).toEqual(['c', 'd'])
  })

  it('does nothing when the cut leaves the widgets still connected via other seams', () => {
    // 2x2 grid: a(top-left) b(top-right) / c(bottom-left) d(bottom-right). Break a-b → still joined a-c-d-b.
    const plan = planLinkBreak([
      IR('a', 0, 0), IR('b', 100, 0), IR('c', 0, 100), IR('d', 100, 100),
    ], 'a', 'b')
    expect(plan.removeFromSlot).toEqual([])
    expect(plan.newGroup).toEqual([])
  })
})

describe('occupiedEdgesOf', () => {
  const target = IR('T', 100, 100) // 100×100; right edge x=200, bottom y=200

  it('returns no edges when there are no neighbors', () => {
    expect([...occupiedEdgesOf(target, [])]).toEqual([])
  })

  it('detects a flush right neighbor', () => {
    expect([...occupiedEdgesOf(target, [IR('R', 200, 100)])]).toEqual(['right'])
  })

  it('detects flush left and bottom neighbors', () => {
    const edges = occupiedEdgesOf(target, [IR('L', 0, 100), IR('B', 100, 200)])
    expect([...edges].sort()).toEqual(['bottom', 'left'])
  })

  it('ignores gapped (non-adjacent) neighbors', () => {
    expect([...occupiedEdgesOf(target, [IR('G', 400, 100)])]).toEqual([])
  })

  it('skips itself', () => {
    expect([...occupiedEdgesOf(target, [target])]).toEqual([])
  })

  it('uses seam orientation, not center delta, for asymmetric widgets', () => {
    // A wide neighbor flush on the BOTTOM, offset to the right: its center is
    // farther in x than in y from the target center (|dx|=200 >= |dy|=100), so a
    // center-delta heuristic would wrongly call it a 'right' neighbor. The seam is
    // horizontal, so the occupied edge must be 'bottom'.
    const wideBottom = IR('WB', 150, 200, 400, 100) // flush at target bottom (y=200), spans x 150..550
    expect([...occupiedEdgesOf(target, [wideBottom])]).toEqual(['bottom'])

    // Symmetric check: a tall neighbor flush on the RIGHT, offset far down, where
    // |dy| >= |dx| — must still be classified 'right' from the vertical seam.
    const tallRight = IR('TR', 200, 150, 100, 400) // flush at target right (x=200), spans y 150..550
    expect([...occupiedEdgesOf(target, [tallRight])]).toEqual(['right'])
  })
})

describe('centroidOf', () => {
  it('returns null for empty input', () => {
    expect(centroidOf([])).toBeNull()
  })
  it('returns the center of a single widget', () => {
    expect(centroidOf([R(0, 0, 100, 100)])).toEqual({ x: 50, y: 50 })
  })
  it('averages the centers of multiple widgets', () => {
    expect(centroidOf([R(0, 0), R(200, 100)])).toEqual({ x: 150, y: 100 })
  })
})

describe('boundingBoxOf', () => {
  it('returns null for empty input', () => {
    expect(boundingBoxOf([])).toBeNull()
  })
  it('returns the rect of a single widget', () => {
    expect(boundingBoxOf([R(10, 20, 100, 50)])).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })
  it('returns the union rect of multiple widgets', () => {
    expect(boundingBoxOf([
      R(0, 0, 100, 100),
      R(200, 50, 100, 100),
    ])).toEqual({ x: 0, y: 0, width: 300, height: 150 })
  })
})

describe('applyGroupDrag', () => {
  it('returns a map of memberId → new position', () => {
    const result = applyGroupDrag(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 200, y: 100 },
      ],
      { dx: 10, dy: -5 },
    )
    expect(result.get('a')).toEqual({ x: 10, y: -5 })
    expect(result.get('b')).toEqual({ x: 210, y: 95 })
  })

  it('returns an empty map for no members', () => {
    expect(applyGroupDrag([], { dx: 10, dy: 10 }).size).toBe(0)
  })
})

describe('fitToRect', () => {
  it('computes camera transform that fits a rect inside the viewport with margin', () => {
    const camera = fitToRect(
      { x: 100, y: 100, width: 400, height: 200 },
      { width: 800, height: 600 },
      40,
    )
    // Effective viewport after margin: 720x520
    // Rect 400x200 → zoom = min(720/400=1.8, 520/200=2.6) = 1.8 (width-limited)
    expect(camera.zoom).toBeCloseTo(1.8, 1)
    // rect center (300, 200), viewport center (400, 300)
    expect(camera.x).toBeCloseTo(400 - 300 * 1.8, 1)
    expect(camera.y).toBeCloseTo(300 - 200 * 1.8, 1)
  })

  it('returns identity-ish camera for empty rect', () => {
    const camera = fitToRect({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 }, 40)
    expect(camera).toEqual({ x: 0, y: 0, zoom: 1 })
  })
})
