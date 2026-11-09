import { type CSSProperties, type ReactNode } from 'react'
import { swipeTravel } from './gesture'
import type { SwipeState } from './useAskGesture'
import './swipeReveal.css'

/** The reveal and moving body share a clipping box; neither leaves the card. */
export function SwipeReveal({ state, children, labelSide }: { state: SwipeState | null; children: ReactNode; labelSide?: 'ask' | 'inspect' | 'none' }) {
  const returning = state?.phase === 'returning'
  const side = state && state.dx < 0 ? 'ask' : 'inspect'
  const armed = state?.phase === 'ask' || state?.phase === 'inspect'
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const travel = state ? swipeTravel(state.dx) : 0
  const clip = side === 'ask' ? `inset(0 0 0 clamp(20%, calc(100% + ${travel}px), 100%))` : `inset(0 clamp(20%, calc(100% - ${travel}px), 100%) 0 0)`
  return <div className={`swipe-reveal${state ? ' is-swiping' : ''}`}>
    {state && <div aria-hidden="true" className={`swipe-rail swipe-rail-${side}${still ? ' swipe-rail-still' : ''}`} data-phase={state.phase} style={{ '--swipe-clip': clip, clipPath: clip } as CSSProperties}>
      {armed && (!labelSide || labelSide === side) && <span className="swipe-action"><b>{side === 'ask' ? 'Ask' : 'Inspector'}</b><small>{side === 'ask' ? 'Release to compose' : 'Release to open Inspector'}</small></span>}
    </div>}
    <div className={`swipe-body${returning ? ' is-returning' : ''}`} style={{ '--swipe-travel': `${travel}px`, transform: state ? `translateX(clamp(-80%, ${travel}px, 80%))` : undefined } as CSSProperties}>{children}</div>
  </div>
}
