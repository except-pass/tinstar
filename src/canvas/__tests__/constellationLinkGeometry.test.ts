import { describe, it, expect } from 'vitest'
import { linkEndpoints, facingAnchorPoints, buildConstellationLinks } from '../constellationLinkGeometry'
import { emptyGraph, addSnap } from '../../domain/constellationGraph'
import type { Rect } from '../constellationCohesion'

const A: Rect = { x: 0, y: 0, width: 100, height: 100 }
// B sits to the right of A with a 24px gutter.
const B: Rect = { x: 124, y: 0, width: 100, height: 100 }

describe('linkEndpoints', () => {
  it('uses the stored anchor pair when both names resolve', () => {
    // top-right of A = (100,0); top-left of B = (124,0)
    const { a, b } = linkEndpoints(A, B, ['top-right', 'top-left'])
    expect(a).toEqual({ x: 100, y: 0 })
    expect(b).toEqual({ x: 124, y: 0 })
  })

  it('falls back to facing-edge midpoints when no anchors are stored', () => {
    const { a, b } = linkEndpoints(A, B)
    // A is left of B → right-mid of A and left-mid of B.
    expect(a).toEqual({ x: 100, y: 50 })
    expect(b).toEqual({ x: 124, y: 50 })
  })
})

describe('facingAnchorPoints', () => {
  it('picks top/bottom mids for a stacked pair', () => {
    const top: Rect = { x: 0, y: 0, width: 100, height: 100 }
    const bottom: Rect = { x: 0, y: 124, width: 100, height: 100 }
    const { a, b } = facingAnchorPoints(top, bottom)
    expect(a).toEqual({ x: 50, y: 100 })
    expect(b).toEqual({ x: 50, y: 124 })
  })
})

describe('buildConstellationLinks', () => {
  it('emits one descriptor per snapped edge with both rects present', () => {
    const g = addSnap(emptyGraph('s'), 'a', 'b', ['top-right', 'top-left'])
    const rects = new Map<string, Rect>([['a', A], ['b', B]])
    const links = buildConstellationLinks(g, rects, () => false)
    expect(links).toHaveLength(1)
    expect(links[0]!.aId).toBe('a')
    expect(links[0]!.bId).toBe('b')
    expect(links[0]!.active).toBe(false)
  })

  it('skips edges whose widget has no live rect', () => {
    const g = addSnap(emptyGraph('s'), 'a', 'gone', ['top-right', 'top-left'])
    const links = buildConstellationLinks(g, new Map([['a', A]]), () => true)
    expect(links).toHaveLength(0)
  })

  it('marks active per the predicate', () => {
    const g = addSnap(emptyGraph('s'), 'a', 'b', ['top-right', 'top-left'])
    const rects = new Map<string, Rect>([['a', A], ['b', B]])
    const links = buildConstellationLinks(g, rects, (aId) => aId === 'a')
    expect(links[0]!.active).toBe(true)
  })
})
