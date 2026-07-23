// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { canConsumeWheel, findWheelYieldTarget, type ScrollMetrics } from '../useCanvasCamera'

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

  // OPEN ITEM pin (see the findWheelYieldTarget docstring). This function is delta-only
  // — it cannot see ctrl/⌘ — and the caller consults it BEFORE its zoom branch, so a
  // yield here means a zoom gesture over a scroller reaches the browser instead of the
  // canvas. True of every [data-scrollable] panel, and now of the workbench band too.
  // Pinned so that changing it is a deliberate flip, not a silent one.
  it('a zoom gesture over a scroller still yields — the ctrl/⌘ case is the caller’s', () => {
    const { outer, band, column } = slate(PANEL, BAND)
    // Whatever the modifier, these are the same deltas, so the same target comes back.
    expect(findWheelYieldTarget(column, 0, 50)).toBe(outer)
    expect(findWheelYieldTarget(column, 40, 0)).toBe(band)
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
