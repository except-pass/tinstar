/** Shared Ask / Inspector rail. Direction locks once; the armed action can
 * still disarm and cross over. Release uses the current phase.
 */
export const ASK_LOCK_PX = 12
export const ASK_ARM_PX = 72
export const ASK_DISARM_PX = 58
export type GesturePhase = 'tracking' | 'native' | 'neutral' | 'ask' | 'inspect'
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

/** Follow the pointer up to arming, then resist further travel. The card
 * retains some of its body via the presentation’s percentage clamp. */
export function swipeTravel(dx: number) {
  const distance = Math.abs(dx)
  const resisted = distance <= ASK_ARM_PX ? distance : ASK_ARM_PX + 32 * (1 - Math.exp(-(distance - ASK_ARM_PX) / 100))
  return Math.sign(dx) * resisted
}
