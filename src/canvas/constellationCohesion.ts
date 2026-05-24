export interface WidgetLayout {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export function centroidOf(widgets: WidgetLayout[]): Point | null {
  if (widgets.length === 0) return null
  let sx = 0, sy = 0
  for (const w of widgets) {
    sx += w.x + w.width / 2
    sy += w.y + w.height / 2
  }
  return { x: sx / widgets.length, y: sy / widgets.length }
}

export function boundingBoxOf(widgets: WidgetLayout[]): Rect | null {
  if (widgets.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const w of widgets) {
    if (w.x < minX) minX = w.x
    if (w.y < minY) minY = w.y
    if (w.x + w.width > maxX) maxX = w.x + w.width
    if (w.y + w.height > maxY) maxY = w.y + w.height
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
