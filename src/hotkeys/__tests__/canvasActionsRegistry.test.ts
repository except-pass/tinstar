import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerCanvasActions,
  fitWidgetToViewport,
  _resetCanvasActionsRegistry,
} from '../canvasActionsRegistry'

describe('canvasActionsRegistry', () => {
  beforeEach(() => {
    _resetCanvasActionsRegistry()
  })

  it('fitWidgetToViewport is a no-op before any impl is registered', () => {
    // Should not throw
    expect(() => fitWidgetToViewport('widget-1')).not.toThrow()
  })

  it('dispatches fit to the registered impl', () => {
    const calls: string[] = []
    registerCanvasActions({ fit: (id) => calls.push(id) })

    fitWidgetToViewport('widget-1')
    fitWidgetToViewport('widget-2')

    expect(calls).toEqual(['widget-1', 'widget-2'])
  })

  it('deregister returned by registerCanvasActions clears the impl', () => {
    const calls: string[] = []
    const deregister = registerCanvasActions({ fit: (id) => calls.push(id) })

    fitWidgetToViewport('widget-1')
    deregister()
    fitWidgetToViewport('widget-2')

    expect(calls).toEqual(['widget-1'])
  })

  it('deregister only clears if the current impl matches (safe against late cleanup)', () => {
    const callsA: string[] = []
    const callsB: string[] = []
    const deregisterA = registerCanvasActions({ fit: (id) => callsA.push(id) })
    // Second register overwrites A's impl
    registerCanvasActions({ fit: (id) => callsB.push(id) })
    // A's cleanup runs late — should not wipe B
    deregisterA()

    fitWidgetToViewport('widget-1')

    expect(callsA).toEqual([])
    expect(callsB).toEqual(['widget-1'])
  })
})
