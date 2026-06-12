// Pure gesture math for pin placement/dragging. No DOM, no React — host-agnostic
// so the shell, browser, and tests share one click-vs-drag classifier.
export const DRAG_THRESHOLD = 5

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

export function localToNormalized(x: number, y: number, w: number, h: number): { nx: number; ny: number } {
  return { nx: w === 0 ? 0 : x / w, ny: h === 0 ? 0 : y / h }
}

export function classifyPointerUp(delta: { dx: number; dy: number }, threshold = DRAG_THRESHOLD): 'click' | 'drag' {
  return Math.hypot(delta.dx, delta.dy) >= threshold ? 'drag' : 'click'
}
