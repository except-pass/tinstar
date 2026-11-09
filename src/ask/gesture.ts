/** Shared Ask / Inspector rail. Direction locks once; the armed action can
 * still disarm and cross over. Release uses the current phase.
 */
export const ASK_LOCK_PX = 12
export const ASK_ARM_PX = 72
export const ASK_DISARM_PX = 58
export const SWIPE_RAIL_WIDTH = 220
export const SWIPE_RAIL_HEIGHT = 64
export type GesturePhase = 'tracking' | 'native' | 'neutral' | 'ask' | 'inspect'
export type GesturePointer = 'mouse' | 'touch' | 'pen'
export type Gesture = {
  x: number
  y: number
  dx: number
  dy: number
  phase: GesturePhase
  scrollsLeft: boolean
  scrollsRight: boolean
  allowInspect: boolean
}
export const startAskGesture = (x: number, y: number, scrollsLeft = false, scrollsRight = false, allowInspect = false): Gesture =>
  ({ x, y, dx: 0, dy: 0, phase: 'tracking', scrollsLeft, scrollsRight, allowInspect })

function armed(phase: 'neutral' | 'ask' | 'inspect', dx: number, allowInspect: boolean): 'neutral' | 'ask' | 'inspect' {
  if (phase === 'ask' && dx <= -ASK_DISARM_PX) return 'ask'
  if (phase === 'inspect' && dx >= ASK_DISARM_PX) return 'inspect'
  if (dx <= -ASK_ARM_PX) return 'ask'
  if (allowInspect && dx >= ASK_ARM_PX) return 'inspect'
  return 'neutral'
}
export function moveAskGesture(state: Gesture, x: number, y: number): Gesture {
  const dx = x - state.x, dy = y - state.y
  if (state.phase === 'native') return { ...state, dx, dy }
  if (state.phase === 'tracking') {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < ASK_LOCK_PX) return { ...state, dx, dy }
    const horizontal = Math.abs(dx) >= Math.abs(dy) * 1.4
    const scrolling = dx < 0 ? state.scrollsLeft : state.scrollsRight
    if (!horizontal || scrolling || (dx > 0 && !state.allowInspect)) return { ...state, dx, dy, phase: 'native' }
    return { ...state, dx, dy, phase: armed('neutral', dx, state.allowInspect) }
  }
  return { ...state, dx, dy, phase: armed(state.phase, dx, state.allowInspect) }
}
export type GestureRelease = 'ask' | 'inspect' | null
export const releaseAskGesture = (state: Gesture | null): GestureRelease =>
  state?.phase === 'ask' || state?.phase === 'inspect' ? state.phase : null

/** Touch sits above the contact point. Mouse sits beside it and never covers the hotspot. */
export function placeSwipeRail(origin: { x: number; y: number }, pointer: GesturePointer, viewport: { width: number; height: number; left?: number; top?: number }) {
  const x = viewport.left ?? 0, y = viewport.top ?? 0
  const margin = 8, width = Math.max(0, Math.min(SWIPE_RAIL_WIDTH, viewport.width - margin * 2)), height = SWIPE_RAIL_HEIGHT, touch = pointer !== 'mouse'
  let left = touch ? origin.x - width / 2 : origin.x + 18
  let top = touch ? origin.y - height - 56 : origin.y + 20
  if (left + width > x + viewport.width - margin) left = origin.x - width - 18
  if (top + height > y + viewport.height - margin) top = origin.y - height - 20
  if (top < y + margin) top = touch ? origin.y + 56 : y + margin
  left = Math.max(x + margin, Math.min(left, Math.max(x + margin, x + viewport.width - width - margin)))
  top = Math.max(y + margin, Math.min(top, Math.max(y + margin, y + viewport.height - height - margin)))
  return { left, top, width }
}
