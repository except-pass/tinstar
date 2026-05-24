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
