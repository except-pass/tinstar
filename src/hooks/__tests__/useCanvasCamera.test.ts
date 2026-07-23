// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { canConsumeWheel, findWheelYieldTarget, useCanvasCamera, type ScrollMetrics } from '../useCanvasCamera'

const M = (p: Partial<ScrollMetrics>): ScrollMetrics => ({
  scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  scrollLeft: 0, scrollWidth: 0, clientWidth: 0,
  ...p,
})

describe('canConsumeWheel', () => {
  it('is false when there is no overflow', () => {
    expect(canConsumeWheel(M({ scrollHeight: 100, clientHeight: 100 }), 0, 50)).toBe(false)
  })

  it('consumes a downward wheel when not yet at the bottom', () => {
    expect(canConsumeWheel(M({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }), 0, 50)).toBe(true)
  })

  it('does NOT consume a downward wheel when pinned at the bottom (boundary → canvas pans)', () => {
    expect(canConsumeWheel(M({ scrollTop: 200, scrollHeight: 400, clientHeight: 200 }), 0, 50)).toBe(false)
  })

  it('does NOT consume an upward wheel when pinned at the top', () => {
    expect(canConsumeWheel(M({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }), 0, -50)).toBe(false)
  })

  it('consumes an upward wheel when scrolled down', () => {
    expect(canConsumeWheel(M({ scrollTop: 120, scrollHeight: 400, clientHeight: 200 }), 0, -50)).toBe(true)
  })

  it('consumes horizontal overflow on a horizontal wheel', () => {
    expect(canConsumeWheel(M({ scrollLeft: 0, scrollWidth: 400, clientWidth: 200 }), 50, 0)).toBe(true)
  })

  it('does NOT consume horizontal at the right edge', () => {
    expect(canConsumeWheel(M({ scrollLeft: 200, scrollWidth: 400, clientWidth: 200 }), 50, 0)).toBe(false)
  })

  it('consumes when either axis can scroll (diagonal wheel into vertical overflow)', () => {
    // No horizontal overflow, but vertical can scroll → consumable.
    expect(canConsumeWheel(M({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }), 10, 50)).toBe(true)
  })
})

// jsdom reports every scroll metric as 0, so each element gets its own.
function metrics(el: HTMLElement, m: Partial<ScrollMetrics>) {
  for (const [k, v] of Object.entries({ ...M({}), ...m })) {
    Object.defineProperty(el, k, { value: v, configurable: true })
  }
  return el
}

describe('findWheelYieldTarget — nested data-scrollable chain', () => {
  /** The Slate shape: a vertical panel body containing a horizontal-only band. */
  function slate(outerM: Partial<ScrollMetrics>, bandM: Partial<ScrollMetrics>) {
    const outer = document.createElement('div')
    outer.setAttribute('data-scrollable', '')
    const band = document.createElement('div')
    band.setAttribute('data-scrollable', '')
    const column = document.createElement('div')
    band.appendChild(column)
    outer.appendChild(band)
    document.body.appendChild(outer)
    metrics(outer, outerM)
    metrics(band, bandM)
    return { outer, band, column }
  }

  const PANEL = { scrollTop: 100, scrollHeight: 800, clientHeight: 400 }
  // Horizontal-only: overflows sideways, exactly fits vertically.
  const BAND = { scrollWidth: 900, clientWidth: 300, scrollHeight: 120, clientHeight: 120 }

  it('a horizontal wheel over the band is taken BY the band', () => {
    const { band, column } = slate(PANEL, BAND)
    expect(findWheelYieldTarget(column, 40, 0)).toBe(band)
  })

  // The regression this guards: the band is the nearest [data-scrollable] but has no
  // vertical overflow, so stopping at it panned the canvas instead of scrolling the
  // Slate. BACK-OUT GUARD — stop walking after the nearest match and this returns null.
  it('a VERTICAL wheel over the band falls through to the panel, not the canvas', () => {
    const { outer, column } = slate(PANEL, BAND)
    expect(findWheelYieldTarget(column, 0, 50)).toBe(outer)
  })

  it('still pans the canvas when neither the band nor the panel can consume it', () => {
    // Panel pinned at the bottom, band already scrolled fully right.
    const { column } = slate(
      { scrollTop: 400, scrollHeight: 800, clientHeight: 400 },
      { ...BAND, scrollLeft: 600 },
    )
    expect(findWheelYieldTarget(column, 40, 50)).toBeNull()
  })

  it('returns null when nothing on the path is marked scrollable', () => {
    const plain = document.createElement('div')
    document.body.appendChild(plain)
    expect(findWheelYieldTarget(plain, 0, 50)).toBeNull()
  })

  it('a lone vertical panel behaves exactly as before (including a deltaY of 0)', () => {
    const el = document.createElement('div')
    el.setAttribute('data-scrollable', '')
    document.body.appendChild(el)
    metrics(el, PANEL)
    expect(findWheelYieldTarget(el, 0, 50)).toBe(el)
    expect(findWheelYieldTarget(el, 30, 0)).toBe(el) // unchanged no-op, not a canvas pan
  })
})

// The OPEN ITEM named in the `findWheelYieldTarget` docstring. It has to be pinned HERE,
// at the caller, because that is where the decision lives: `findWheelYieldTarget` is
// delta-only and never sees a modifier, so asserting against it can't distinguish a
// zoom gesture from a scroll and would stay green through the very flip it claims to
// guard. `handleWheel` computes `isZoomGesture`, already spends it on the Monaco bypass,
// and then deliberately does NOT spend it on the yield check.
describe('handleWheel — ctrl/⌘ over a scroller yields instead of zooming (OPEN ITEM)', () => {
  /** Dispatch a real wheel event so `currentTarget` is set the way the DOM sets it. */
  function wheelOver(el: HTMLElement, handler: (e: WheelEvent) => void, init: WheelEventInit) {
    const host = el.closest('[data-canvas-host]') as HTMLElement
    host.addEventListener('wheel', handler as EventListener)
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    // act() so the camera setState the zoom branch fires is flushed into `result.current`.
    act(() => { el.dispatchEvent(ev) })
    host.removeEventListener('wheel', handler as EventListener)
    return ev
  }

  function mount() {
    const host = document.createElement('div')
    host.setAttribute('data-canvas-host', '')
    const panel = document.createElement('div')
    panel.setAttribute('data-scrollable', '')
    const inner = document.createElement('div')
    panel.appendChild(inner)
    host.appendChild(panel)
    document.body.appendChild(host)
    metrics(panel, { scrollTop: 100, scrollHeight: 800, clientHeight: 400 })
    return { host, panel, inner }
  }

  it('does not preventDefault (so it never reaches the zoom branch)', () => {
    const { inner } = mount()
    const { result } = renderHook(() => useCanvasCamera())
    const before = result.current.camera

    const ev = wheelOver(inner, result.current.handleWheel, { ctrlKey: true, deltaY: -50 })

    // BACK-OUT GUARD: change the caller to `!isZoomGesture && findWheelYieldTarget(...)`
    // and this fails — the handler falls through, preventDefaults, and zooms the canvas.
    expect(ev.defaultPrevented).toBe(false)
    expect(result.current.camera).toEqual(before)
  })

  it('still zooms when the pointer is NOT over a scroller', () => {
    const { host } = mount()
    const bare = document.createElement('div')
    host.appendChild(bare)
    const { result } = renderHook(() => useCanvasCamera())

    const ev = wheelOver(bare, result.current.handleWheel, { ctrlKey: true, deltaY: -50 })

    expect(ev.defaultPrevented).toBe(true)
    expect(result.current.camera.zoom).toBeGreaterThan(1)
  })
})
