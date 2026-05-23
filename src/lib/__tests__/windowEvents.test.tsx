// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useEffect } from 'react'
import { dispatchWindowEvent, useWindowEvent } from '../windowEvents'

describe('windowEvents', () => {
  it('dispatchWindowEvent + listener round-trip', () => {
    const seen: unknown[] = []
    const handler = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener('tinstar:nats_traffic', handler)
    dispatchWindowEvent('tinstar:nats_traffic', { hello: 'world' })
    window.removeEventListener('tinstar:nats_traffic', handler)
    expect(seen).toEqual([{ hello: 'world' }])
  })

  it('useWindowEvent subscribes for lifetime and unsubscribes on unmount', () => {
    const handler = vi.fn()
    function Sub() {
      useWindowEvent('tinstar:projects_changed', handler)
      return null
    }
    const { unmount } = render(<Sub />)

    dispatchWindowEvent('tinstar:projects_changed', { a: 1 })
    expect(handler).toHaveBeenCalledWith({ a: 1 })

    unmount()
    dispatchWindowEvent('tinstar:projects_changed', { a: 2 })
    // Still only one call — unmount removed the listener.
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('handler swap reattaches the listener', () => {
    const h1 = vi.fn()
    const h2 = vi.fn()
    function Sub({ which }: { which: 1 | 2 }) {
      useWindowEvent('tinstar:file_watch', which === 1 ? h1 : h2)
      return null
    }
    const { rerender } = render(<Sub which={1} />)
    dispatchWindowEvent('tinstar:file_watch', { v: 1 })
    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).not.toHaveBeenCalled()

    rerender(<Sub which={2} />)
    dispatchWindowEvent('tinstar:file_watch', { v: 2 })
    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledWith({ v: 2 })
  })

  it('payload-less event (commit-delta) round-trips', () => {
    const handler = vi.fn()
    function Sub() {
      useWindowEvent('tinstar:commit-delta', handler)
      return null
    }
    render(<Sub />)
    dispatchWindowEvent('tinstar:commit-delta', undefined)
    expect(handler).toHaveBeenCalledWith(undefined)
  })

  // Silence the unused-import warning when this file is type-checked standalone
  void useEffect
})
