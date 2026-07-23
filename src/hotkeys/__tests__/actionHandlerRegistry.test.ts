import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerActionHandler, deregisterActionHandler, dispatchAction } from '../actionHandlerRegistry'

// `dispatchAction`'s BOOLEAN return is the contract the context router leans on: a
// widget that declines an action (because its current state makes the binding
// meaningless) must not have its keystroke swallowed, and must not fire the sidebar
// confirmation flash — the flash means "the key did the thing".

afterEach(() => deregisterActionHandler('w1'))

describe('dispatchAction handled reporting', () => {
  it('reports handled for a handler that returns nothing (the common case)', () => {
    const fn = vi.fn(() => {})
    registerActionHandler('w1', fn)
    expect(dispatchAction('w1', 'anything')).toBe(true)
    expect(fn).toHaveBeenCalledWith('anything')
  })

  it('reports UNhandled only when the handler explicitly returns false', () => {
    registerActionHandler('w1', (a: string) => (a === 'declined' ? false : undefined))
    expect(dispatchAction('w1', 'declined')).toBe(false)
    expect(dispatchAction('w1', 'accepted')).toBe(true)
  })

  it('reports handled when no widget has registered (unchanged behavior)', () => {
    expect(dispatchAction('nobody-home', 'x')).toBe(true)
  })
})
