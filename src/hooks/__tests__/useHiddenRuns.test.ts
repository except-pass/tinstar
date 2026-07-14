import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useHiddenRuns, removeHiddenRunId } from '../useHiddenRuns'

const LS_KEY = 'tinstar-hidden-runs'

function stored(): string[] {
  const raw = localStorage.getItem(LS_KEY)
  return raw ? (JSON.parse(raw) as string[]) : []
}

describe('useHiddenRuns', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('toggleHidden adds then removes an id (unchanged behavior)', () => {
    const { result } = renderHook(() => useHiddenRuns())

    act(() => result.current.toggleHidden('dj'))
    expect(result.current.isHidden('dj')).toBe(true)
    expect(stored()).toContain('dj')

    act(() => result.current.toggleHidden('dj'))
    expect(result.current.isHidden('dj')).toBe(false)
    expect(stored()).not.toContain('dj')
  })

  it('removeHidden drops the id and updates hidden state', () => {
    const { result } = renderHook(() => useHiddenRuns())
    act(() => result.current.toggleHidden('dj'))
    expect(result.current.isHidden('dj')).toBe(true)

    act(() => result.current.removeHidden('dj'))
    expect(result.current.isHidden('dj')).toBe(false)
    expect(stored()).not.toContain('dj')
  })
})

describe('removeHiddenRunId (standalone)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('removes a stored id — a stale id must NOT survive a delete', () => {
    // Seed the ghost: a hidden-then-deleted run left "dj" behind.
    localStorage.setItem(LS_KEY, JSON.stringify(['dj', 'goose']))

    removeHiddenRunId('dj')

    // Guard: if the prune-on-remove logic is reverted, "dj" survives here and
    // a future same-named run would be born hidden — this assertion catches it.
    expect(stored()).not.toContain('dj')
    expect(stored()).toContain('goose')
  })

  it('is a no-op (no throw, no write) when the id is absent', () => {
    localStorage.setItem(LS_KEY, JSON.stringify(['goose']))
    expect(() => removeHiddenRunId('dj')).not.toThrow()
    expect(stored()).toEqual(['goose'])
  })

  it('a mounted hook picks up a same-tab removal via the change event', () => {
    localStorage.setItem(LS_KEY, JSON.stringify(['dj']))
    const { result } = renderHook(() => useHiddenRuns())
    expect(result.current.isHidden('dj')).toBe(true)

    // Simulate the SSE run-removed reducer pruning outside React.
    act(() => removeHiddenRunId('dj'))
    expect(result.current.isHidden('dj')).toBe(false)
  })
})

describe('useHiddenRuns — cross-tab storage sync', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('re-reads when another tab mutates the hidden-runs key (native storage event)', () => {
    const { result } = renderHook(() => useHiddenRuns())
    expect(result.current.isHidden('dj')).toBe(false)

    // Another tab hid "dj": storage is already updated; this tab only gets the
    // event (jsdom does not auto-fire `storage` for same-context writes).
    localStorage.setItem(LS_KEY, JSON.stringify(['dj']))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: LS_KEY }))
    })
    expect(result.current.isHidden('dj')).toBe(true)
  })

  it('ignores storage events for unrelated keys', () => {
    localStorage.setItem(LS_KEY, JSON.stringify(['dj']))
    const { result } = renderHook(() => useHiddenRuns())
    expect(result.current.isHidden('dj')).toBe(true)

    localStorage.setItem(LS_KEY, JSON.stringify([]))
    act(() => {
      // A different key changed — the hook must NOT re-read on this event.
      window.dispatchEvent(new StorageEvent('storage', { key: 'some-other-key' }))
    })
    expect(result.current.isHidden('dj')).toBe(true)
  })
})
