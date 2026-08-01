// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCanvasHotkeys, type CanvasHotkeyHandlers } from '../useCanvasHotkeys'

afterEach(cleanup)

function handlers(): CanvasHotkeyHandlers {
  return {
    onConstellationNavigate: vi.fn(),
    onConstellationAssign: vi.fn(),
    onConstellationRemove: vi.fn(),
    onArrangeGrid: vi.fn(),
    onArrangeReset: vi.fn(),
    onArrangeSwimlanes: vi.fn(),
    onToggleMinimap: vi.fn(),
    onToggleHud: vi.fn(),
    onConstellationZoomFit: vi.fn(),
    onConstellationTidy: vi.fn(),
    onConstellationLeave: vi.fn(),
    onConstellationDissolve: vi.fn(),
  }
}

describe('useCanvasHotkeys', () => {
  it('does not run canvas actions while disabled', () => {
    const h = handlers()
    renderHook(() => useCanvasHotkeys(h, false))

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyG',
      ctrlKey: true,
      cancelable: true,
    })))

    expect(h.onArrangeGrid).not.toHaveBeenCalled()
  })
})
