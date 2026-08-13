// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGlobalHotkeys, type GlobalHotkeyHandlers } from '../useGlobalHotkeys'

afterEach(cleanup)

function handlers(isFocusModeActive: () => boolean): GlobalHotkeyHandlers {
  return {
    isFocusModeActive,
    onCycleReadyNext: vi.fn(),
    onCycleReadyPrev: vi.fn(),
    onCycleAllNext: vi.fn(),
    onCycleAllPrev: vi.fn(),
    onSessionQuick: vi.fn(),
    onEntitySettings: vi.fn(),
    onCreateChild: vi.fn(),
    onToggleEmptyEntities: vi.fn(),
    onPaletteOpen: vi.fn(),
  }
}

function dispatchMouse(type: 'mousedown' | 'mouseup' | 'auxclick', button: number) {
  return window.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }))
}

function dispatchGesture(button: number) {
  return {
    downAllowed: dispatchMouse('mousedown', button),
    upAllowed: dispatchMouse('mouseup', button),
    auxClickAllowed: dispatchMouse('auxclick', button),
  }
}

describe('useGlobalHotkeys mouse session cycling', () => {
  it('consumes Back in Focus and cycles to the previous ready session once', () => {
    const h = handlers(() => true)
    renderHook(() => useGlobalHotkeys(h))

    let result: ReturnType<typeof dispatchGesture> | undefined
    act(() => { result = dispatchGesture(3) })

    expect(result).toEqual({ downAllowed: false, upAllowed: false, auxClickAllowed: false })
    expect(h.onCycleReadyPrev).toHaveBeenCalledTimes(1)
    expect(h.onCycleReadyNext).not.toHaveBeenCalled()
  })

  it('consumes Forward in Focus and cycles to the next ready session once', () => {
    const h = handlers(() => true)
    renderHook(() => useGlobalHotkeys(h))

    let result: ReturnType<typeof dispatchGesture> | undefined
    act(() => { result = dispatchGesture(4) })

    expect(result).toEqual({ downAllowed: false, upAllowed: false, auxClickAllowed: false })
    expect(h.onCycleReadyNext).toHaveBeenCalledTimes(1)
    expect(h.onCycleReadyPrev).not.toHaveBeenCalled()
  })

  it('leaves Back and Forward untouched outside Focus', () => {
    const h = handlers(() => false)
    renderHook(() => useGlobalHotkeys(h))

    let back: ReturnType<typeof dispatchGesture> | undefined
    let forward: ReturnType<typeof dispatchGesture> | undefined
    act(() => {
      back = dispatchGesture(3)
      forward = dispatchGesture(4)
    })

    expect(back).toEqual({ downAllowed: true, upAllowed: true, auxClickAllowed: true })
    expect(forward).toEqual({ downAllowed: true, upAllowed: true, auxClickAllowed: true })
    expect(h.onCycleReadyPrev).not.toHaveBeenCalled()
    expect(h.onCycleReadyNext).not.toHaveBeenCalled()
  })

  it('leaves unrelated mouse buttons untouched in Focus', () => {
    const h = handlers(() => true)
    renderHook(() => useGlobalHotkeys(h))

    const results: Array<ReturnType<typeof dispatchGesture>> = []
    act(() => {
      for (const button of [0, 1, 2, 5]) results.push(dispatchGesture(button))
    })

    expect(results).toEqual(Array.from({ length: 4 }, () => ({
      downAllowed: true,
      upAllowed: true,
      auxClickAllowed: true,
    })))
    expect(h.onCycleReadyPrev).not.toHaveBeenCalled()
    expect(h.onCycleReadyNext).not.toHaveBeenCalled()
  })

  it('reads the current Focus state without reinstalling listeners', () => {
    let focusActive = false
    const h = handlers(() => focusActive)
    renderHook(() => useGlobalHotkeys(h))

    let before: ReturnType<typeof dispatchGesture> | undefined
    let after: ReturnType<typeof dispatchGesture> | undefined
    act(() => { before = dispatchGesture(3) })
    focusActive = true
    act(() => { after = dispatchGesture(3) })

    expect(before?.upAllowed).toBe(true)
    expect(after?.upAllowed).toBe(false)
    expect(h.onCycleReadyPrev).toHaveBeenCalledTimes(1)
  })
})
