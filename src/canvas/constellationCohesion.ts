export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export function centroidOf(rects: Rect[]): Point | null {
  if (rects.length === 0) return null
  let sx = 0, sy = 0
  for (const r of rects) {
    sx += r.x + r.width / 2
    sy += r.y + r.height / 2
  }
  return { x: sx / rects.length, y: sy / rects.length }
}

export function boundingBoxOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (r.x + r.width > maxX) maxX = r.x + r.width
    if (r.y + r.height > maxY) maxY = r.y + r.height
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export interface DragDelta { dx: number; dy: number }

// Member shape for group-drag operations: a Point plus an id to key the result Map.
export type DragMember = Point & { id: string }

export function applyGroupDrag(
  members: DragMember[],
  delta: DragDelta,
): Map<string, Point> {
  const result = new Map<string, Point>()
  for (const m of members) {
    result.set(m.id, { x: m.x + delta.dx, y: m.y + delta.dy })
  }
  return result
}

export interface IdRect extends Rect { id: string }
export interface BreakLink { x: number; y: number; aId: string; bId: string }

/**
 * Midpoint of the shared edge if a and b are flush/touching within `tolerance`, else null.
 * Side-by-side pairs yield a point on the vertical seam; stacked pairs on the horizontal seam.
 */
function seamPoint(a: Rect, b: Rect, tolerance: number): { x: number; y: number } | null {
  const ax2 = a.x + a.width, ay2 = a.y + a.height
  const bx2 = b.x + b.width, by2 = b.y + b.height
  const vOverlap = Math.min(ay2, by2) - Math.max(a.y, b.y)
  const hOverlap = Math.min(ax2, bx2) - Math.max(a.x, b.x)
  const hGap = Math.max(a.x - bx2, b.x - ax2)
  if (vOverlap > 0 && hGap >= -tolerance && hGap <= tolerance) {
    const x = a.x < b.x ? (ax2 + b.x) / 2 : (bx2 + a.x) / 2
    const y = (Math.max(a.y, b.y) + Math.min(ay2, by2)) / 2
    return { x, y }
  }
  const vGap = Math.max(a.y - by2, b.y - ay2)
  if (hOverlap > 0 && vGap >= -tolerance && vGap <= tolerance) {
    const y = a.y < b.y ? (ay2 + b.y) / 2 : (by2 + a.y) / 2
    const x = (Math.max(a.x, b.x) + Math.min(ax2, bx2)) / 2
    return { x, y }
  }
  return null
}

/**
 * Find the seams between adjacent (flush/touching) widgets in a constellation — where a
 * "break the lock" affordance should sit. Each link carries the pair of widget ids it joins
 * so breaking it can split exactly that seam.
 */
export function computeBreakLinks(items: IdRect[], tolerance = 20): BreakLink[] {
  const links: BreakLink[] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const p = seamPoint(items[i]!, items[j]!, tolerance)
      if (p) links.push({ x: p.x, y: p.y, aId: items[i]!.id, bId: items[j]!.id })
    }
  }
  return links
}

export type CohesionEdge = 'left' | 'right' | 'top' | 'bottom'

/**
 * Which edges of `target` have a flush/touching neighbor among `others` — i.e. the edges
 * that are NOT exposed. Uses the same adjacency test as the break-link seams, so callers
 * (e.g. the add-widget [+] affordance) can avoid the edges where a break-link chip already sits.
 * Side is the dominant axis of the center offset, matching resolveSnapTarget's placement.
 */
export function occupiedEdgesOf(target: IdRect, others: IdRect[], tolerance = 20): Set<CohesionEdge> {
  const edges = new Set<CohesionEdge>()
  const tcx = target.x + target.width / 2, tcy = target.y + target.height / 2
  for (const o of others) {
    if (o.id === target.id) continue
    if (!seamPoint(target, o, tolerance)) continue
    const dx = (o.x + o.width / 2) - tcx
    const dy = (o.y + o.height / 2) - tcy
    if (Math.abs(dx) >= Math.abs(dy)) edges.add(dx >= 0 ? 'right' : 'left')
    else edges.add(dy >= 0 ? 'bottom' : 'top')
  }
  return edges
}

export interface LinkBreakPlan {
  /** ids to remove from the original constellation slot (freed, or moved into newGroup) */
  removeFromSlot: string[]
  /** ids that should form a NEW constellation together; empty when the split-off side is a lone widget */
  newGroup: string[]
}

/**
 * Plan the result of breaking the seam between `aId` and `bId`. Flush-adjacency is a graph;
 * removing the a–b edge may split it. The larger component keeps the original slot; the smaller
 * leaves — forming its own constellation if it still has ≥2 widgets, otherwise freed. A lone
 * widget left behind on the keep side is freed too (no 1-member constellations). Returns empty
 * arrays when the cut doesn't disconnect anything (still joined via other seams).
 */
export function planLinkBreak(items: IdRect[], aId: string, bId: string, tolerance = 20): LinkBreakPlan {
  const adj = new Map<string, Set<string>>()
  for (const it of items) adj.set(it.id, new Set())
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!
      const broken = (a.id === aId && b.id === bId) || (a.id === bId && b.id === aId)
      if (broken) continue
      if (seamPoint(a, b, tolerance)) {
        adj.get(a.id)!.add(b.id)
        adj.get(b.id)!.add(a.id)
      }
    }
  }
  const compA = new Set<string>([aId])
  const queue = [aId]
  while (queue.length) {
    const cur = queue.shift()!
    for (const nb of adj.get(cur) ?? []) {
      if (!compA.has(nb)) { compA.add(nb); queue.push(nb) }
    }
  }
  if (compA.has(bId)) return { removeFromSlot: [], newGroup: [] } // still connected via other seams
  const sideA = items.filter(it => compA.has(it.id)).map(it => it.id)
  const sideB = items.filter(it => !compA.has(it.id)).map(it => it.id)
  const [keep, other] = sideA.length >= sideB.length ? [sideA, sideB] : [sideB, sideA]
  const removeFromSlot = [...other]
  if (keep.length < 2) removeFromSlot.push(...keep)
  const newGroup = other.length >= 2 ? [...other] : []
  return { removeFromSlot, newGroup }
}

export interface ViewportSize { width: number; height: number }
export interface Camera { x: number; y: number; zoom: number }

export function fitToRect(
  rect: Rect,
  viewport: ViewportSize,
  margin: number,
): Camera {
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0, zoom: 1 }
  }
  const availW = Math.max(1, viewport.width - margin * 2)
  const availH = Math.max(1, viewport.height - margin * 2)
  const zoom = Math.min(availW / rect.width, availH / rect.height)
  const rectCx = rect.x + rect.width / 2
  const rectCy = rect.y + rect.height / 2
  const vpCx = viewport.width / 2
  const vpCy = viewport.height / 2
  return { x: vpCx - rectCx * zoom, y: vpCy - rectCy * zoom, zoom }
}
