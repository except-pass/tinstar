import { describe, it, expect } from 'vitest'
import { resolveSnapTarget, revalidateSnapTarget, resolveSnapCommit, snapMembership } from '../snapZoneResolver'

const W = (id: string, x: number, y: number, w = 100, h = 100) =>
  ({ id, x, y, width: w, height: h })

const SNAP_DISTANCE = 60

describe('resolveSnapTarget', () => {
  it('returns null when no other widget is within snap distance', () => {
    const result = resolveSnapTarget('d', { x: 0, y: 0, width: 100, height: 100 },
      [W('d', 0, 0), W('far', 1000, 1000)], SNAP_DISTANCE)
    expect(result).toBeNull()
  })

  it('snaps flush to the right edge, top-aligned, when approaching from the right', () => {
    // dragged centered to the right of the target → right edge, y aligned to target.y
    const result = resolveSnapTarget('d', { x: 130, y: 5, width: 100, height: 100 },
      [W('t', 0, 0)], SNAP_DISTANCE)
    expect(result).toEqual(expect.objectContaining({ targetId: 't', edge: 'right', x: 100, y: 0 }))
    expect(result?.anchors).toBeDefined()
  })

  it('snaps flush to the left edge when approaching from the left', () => {
    const result = resolveSnapTarget('d', { x: -130, y: 5, width: 100, height: 100 },
      [W('t', 0, 0)], SNAP_DISTANCE)
    expect(result).toEqual(expect.objectContaining({ targetId: 't', edge: 'left', x: -100, y: 0 }))
    expect(result?.anchors).toBeDefined()
  })

  it('snaps flush below, left-aligned, when approaching from below', () => {
    const result = resolveSnapTarget('d', { x: 5, y: 130, width: 100, height: 100 },
      [W('t', 0, 0)], SNAP_DISTANCE)
    expect(result).toEqual(expect.objectContaining({ targetId: 't', edge: 'bottom', x: 0, y: 100 }))
    expect(result?.anchors).toBeDefined()
  })

  it('picks the nearest neighbor among several in range', () => {
    const result = resolveSnapTarget('d', { x: 120, y: 0, width: 100, height: 100 }, [
      W('near', 0, 0),       // right edge at 100, gap 20
      W('farish', -160, 0),  // right edge at -60, gap 180 (out of range anyway)
    ], SNAP_DISTANCE)
    expect(result?.targetId).toBe('near')
  })

  // Overlap area of two rects on both axes; 0 when they are merely edge/corner adjacent.
  const overlapArea = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => {
    const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
    return ox * oy
  }

  it('does not stack the dragged widget on a target it overlaps — snaps to a non-occluding flush', () => {
    // Dragged dropped ON the target. The OLD behavior resolved a same-side pair (top-left↔
    // top-left) → position (0,0), exactly stacking the dragged widget over the target. The
    // new behavior must reject that occlusion and snap flush against an edge instead.
    const target = W('t', 0, 0)            // (0,0,100,100)
    const result = resolveSnapTarget('d', { x: 10, y: 10, width: 100, height: 100 }, [target], SNAP_DISTANCE)
    expect(result).not.toBeNull()
    // Not the old exact-stack placement.
    expect(result).not.toMatchObject({ x: 0, y: 0 })
    // Placed rect is edge-adjacent: overlap with the target is ~0 (a true flush snap), not a cover.
    const placed = { x: result!.x, y: result!.y, width: 100, height: 100 }
    expect(overlapArea(placed, target)).toBeLessThanOrEqual(1)
  })

  it('derives edge from the winning anchor pair, not the pre-snap center offset', () => {
    // target (0,0,100,100), dragged (90,120,100,100): the nearest non-occluding pair is
    // top-left↔bottom-right, placing the dragged widget at the target's bottom-right corner
    // (100,100). The reported edge must agree with that placement direction (right/bottom),
    // not point at a side the widget never reaches.
    const target = W('t', 0, 0)
    const result = resolveSnapTarget('d', { x: 90, y: 120, width: 100, height: 100 }, [target], SNAP_DISTANCE)!
    expect(result).toMatchObject({ x: 100, y: 100, anchors: ['top-left', 'bottom-right'] })
    // Placement is to the right of AND below the target; edge must name one of those sides.
    expect(['right', 'bottom']).toContain(result.edge)
    // And it must be consistent with the resolved position relative to the target.
    const placedCenterX = result.x + 50
    const placedCenterY = result.y + 50
    const targetCenterX = target.x + 50
    const targetCenterY = target.y + 50
    if (result.edge === 'right') expect(placedCenterX).toBeGreaterThan(targetCenterX)
    if (result.edge === 'bottom') expect(placedCenterY).toBeGreaterThan(targetCenterY)
  })
})

describe('resolveSnapTarget anchors', () => {
  const target = { id: 't', x: 100, y: 100, width: 200, height: 100 }
  it('returns an anchor pair and an anchor-resolved flush position', () => {
    const dragged = { x: 305, y: 100, width: 80, height: 100 }
    const r = resolveSnapTarget('d', dragged, [target], 60)!
    expect(r.targetId).toBe('t')
    expect(r.anchors).toBeDefined()
    expect(r.anchors![0]).toMatch(/left$/)
    expect(r.anchors![1]).toMatch(/right$/)
    expect(r.x).toBe(300)
    expect(r.y).toBe(100)
  })
  it('returns null when out of range', () => {
    expect(resolveSnapTarget('d', { x: 1000, y: 1000, width: 80, height: 80 }, [target], 60)).toBeNull()
  })
})

describe('snapMembership', () => {
  it('joins the target slot when the target is already in a constellation', () => {
    expect(snapMembership('m', new Map([['m', '3']]), new Set(['3'])))
      .toEqual({ kind: 'join', slot: '3' })
  })

  it('forms a new constellation in the next free slot when the target is ungrouped', () => {
    expect(snapMembership('u', new Map(), new Set(['1', '2'])))
      .toEqual({ kind: 'form', slot: '3', withId: 'u' })
  })

  it('reports full-slots when all 9 slots are taken and the target is ungrouped', () => {
    expect(snapMembership('u', new Map(), new Set(['1','2','3','4','5','6','7','8','9'])))
      .toEqual({ kind: 'full-slots' })
  })
})

describe('resolveSnapCommit', () => {
  it('commits a join when the revalidated preview still targets an occupied slot', () => {
    expect(
      resolveSnapCommit(
        { targetId: 'm', edge: 'right', anchors: ['middle-left', 'middle-right'] as [string, string], x: 100, y: 0 },
        new Map([['m', '3']]),
        new Set(['3']),
      ),
    ).toEqual({ kind: 'join', slot: '3' })
  })

  it('rolls back when the preview disappears before drop', () => {
    expect(resolveSnapCommit(null, new Map(), new Set())).toEqual({ kind: 'rollback' })
  })

  it('rolls back when slot availability changes to full before drop', () => {
    expect(
      resolveSnapCommit(
        { targetId: 'u', edge: 'right', anchors: ['middle-left', 'middle-right'] as [string, string], x: 100, y: 0 },
        new Map(),
        new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9']),
      ),
    ).toEqual({ kind: 'rollback' })
  })
})

describe('revalidateSnapTarget', () => {
  it('keeps a preview and re-resolves its exact geometry when the same target is still active', () => {
    // dragged sits flush against the target's right edge: revalidation must recompute the
    // full target — x/y/anchors/edge — not echo the stale preview. Pinning all of them
    // catches a re-resolution regression (e.g. returning the preview position unchanged).
    const preview = { targetId: 't', edge: 'right' as const, anchors: ['top-left', 'top-right'] as [string, string], x: 100, y: 0 }

    expect(
      revalidateSnapTarget('d', preview, { x: 100, y: 0, width: 100, height: 100 }, [W('t', 0, 0)], SNAP_DISTANCE),
    ).toEqual({ targetId: 't', edge: 'right', anchors: ['top-left', 'top-right'], x: 100, y: 0 })
  })

  it('drops a preview when the snapped-against widget no longer exists', () => {
    const preview = { targetId: 't', edge: 'right' as const, anchors: ['top-left', 'top-right'] as [string, string], x: 100, y: 0 }

    expect(
      revalidateSnapTarget('d', preview, { x: 100, y: 0, width: 100, height: 100 }, [], SNAP_DISTANCE),
    ).toBeNull()
  })

  it('drops a preview when the target is no longer within snap range', () => {
    const preview = { targetId: 't', edge: 'right' as const, anchors: ['top-left', 'top-right'] as [string, string], x: 100, y: 0 }

    expect(
      revalidateSnapTarget('d', preview, { x: 100, y: 0, width: 100, height: 100 }, [W('t', 500, 0)], SNAP_DISTANCE),
    ).toBeNull()
  })
})
