/** Direction is locked before interception. Touches in a scrollable horizontal
 * direction stay native; Ask is available at its edge and via the visible action.
 */
export const ASK_LOCK_PX = 12
export const ASK_RELEASE_PX = 48
export type Gesture = { x: number; y: number; dx: number; lock: 'pending' | 'text' | 'native'; scrollsLeft: boolean }
export const startAskGesture = (x: number, y: number, scrollsLeft = false): Gesture => ({ x, y, dx: 0, lock: 'pending', scrollsLeft })
export function moveAskGesture(state: Gesture, x: number, y: number): Gesture {
  const dx = x - state.x, dy = y - state.y
  if (state.lock !== 'pending') return { ...state, dx }
  if (Math.max(Math.abs(dx), Math.abs(dy)) < ASK_LOCK_PX) return { ...state, dx }
  return { ...state, dx, lock: dx < 0 && -dx >= Math.abs(dy) * 1.4 && !state.scrollsLeft ? 'text' : 'native' }
}
export const releaseAskGesture = (state: Gesture | null) => !!state && state.lock === 'text' && -state.dx >= ASK_RELEASE_PX
