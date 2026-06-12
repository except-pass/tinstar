import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePinSet } from '../usePinSet'
import type { PinSet, Pin } from '../../domain/pinSet'

const h = vi.hoisted(() => ({
  serverState: { pinSets: [] as PinSet[] },
  puts: [] as PinSet[],
  nextResponse: () => Promise.resolve({ ok: true } as Response),
}))

vi.mock('../useServerEvents', () => ({
  useServerEvents: () => ({ state: h.serverState }),
}))

vi.mock('../../apiClient', () => ({
  apiFetch: (_path: string, init: RequestInit) => {
    h.puts.push(JSON.parse(init.body as string))
    return h.nextResponse()
  },
}))

function pin(id: string, nodeId = 'n1'): Pin {
  return { id, nodeId, nx: 0.5, ny: 0.5, comment: `c-${id}`, createdAt: 1 }
}

beforeEach(() => {
  h.serverState = { pinSets: [] }
  h.puts.length = 0
  h.nextResponse = () => Promise.resolve({ ok: true } as Response)
})

// A successful mutation issues exactly one PUT with a strictly increasing rev,
// and the optimistic `set` reflects the change immediately.
describe('usePinSet successful mutation', () => {
  it('issues one PUT to /api/pins/<space> with rev 1 and reflects the change immediately', () => {
    const { result } = renderHook(() => usePinSet('s'))
    act(() => { result.current.create(pin('p1')) })
    expect(result.current.set.pins.map(p => p.id)).toEqual(['p1'])
    expect(h.puts.length).toBe(1)
    expect(h.puts[0]!.spaceId).toBe('s')
    expect(h.puts[0]!.rev).toBe(1)
    expect(h.puts[0]!.pins.map(p => p.id)).toEqual(['p1'])
  })

  it('back-to-back creates compose and each carries a strictly increasing rev', () => {
    const { result } = renderHook(() => usePinSet('s'))
    act(() => {
      result.current.create(pin('p1'))
      result.current.create(pin('p2'))
    })
    expect(result.current.set.pins.map(p => p.id).sort()).toEqual(['p1', 'p2'])
    expect(h.puts.map(p => p.rev)).toEqual([1, 2])
    expect(h.puts.at(-1)!.pins.map(p => p.id).sort()).toEqual(['p1', 'p2'])
  })
})

// A rejected PUT must roll back the optimistic overlay so reads fall back to
// server state instead of compounding edits the backend refused.
describe('usePinSet failed persist (rollback)', () => {
  it('rolls back the overlay when the server responds non-OK (409/500)', async () => {
    h.serverState = {
      pinSets: [{ spaceId: 's', pins: [pin('a')], rev: 0 }],
    }
    h.nextResponse = () => Promise.resolve({ ok: false, status: 409, text: () => Promise.resolve('conflict') } as Response)
    const { result } = renderHook(() => usePinSet('s'))
    await act(async () => {
      result.current.create(pin('b'))
      await Promise.resolve()
    })
    // Overlay dropped → reads fall back to server state ({a}).
    expect(result.current.set.pins.map(p => p.id)).toEqual(['a'])
  })
})

// The overlay is dropped once the server's revision reaches/exceeds the
// optimistic write's revision (our echo landed).
describe('usePinSet overlay clears on echo', () => {
  it('clears the overlay when the server rev reaches the optimistic rev', async () => {
    let release!: () => void
    h.nextResponse = () => new Promise<Response>(resolve => { release = () => resolve({ ok: true } as Response) })
    const { result, rerender } = renderHook(() => usePinSet('s'))
    act(() => { result.current.create(pin('p1')) }) // optimistic rev 1
    expect(result.current.set.pins.map(p => p.id)).toEqual(['p1'])

    // The echo lands at rev 1 — overlay clears onto server state (identical here).
    await act(async () => {
      h.serverState = { pinSets: [{ spaceId: 's', pins: [pin('p1')], rev: 1 }] }
      rerender()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.set.pins.map(p => p.id)).toEqual(['p1'])

    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)) })
  })
})

// A higher EXTERNAL server rev (another writer) supersedes/clears the local
// overlay even while our own PUT is still in flight.
describe('usePinSet external higher revision supersedes', () => {
  it('drops the overlay when a higher-revision server set lands', async () => {
    let release!: () => void
    h.nextResponse = () => new Promise<Response>(resolve => { release = () => resolve({ ok: true } as Response) })
    const { result, rerender } = renderHook(() => usePinSet('s'))
    act(() => { result.current.create(pin('mine')) }) // optimistic rev 1
    expect(result.current.set.pins.map(p => p.id)).toEqual(['mine'])

    // Another writer pushes rev 2 carrying a different pin — it out-revises our
    // pending write, so our overlay yields to it.
    await act(async () => {
      h.serverState = { pinSets: [{ spaceId: 's', pins: [pin('theirs')], rev: 2 }] }
      rerender()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.set.pins.map(p => p.id)).toEqual(['theirs'])

    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)) })
  })
})

// The provider is reused across space switches, so a pending optimistic overlay
// from one space must not leak into another.
describe('usePinSet space switching', () => {
  it('drops the optimistic overlay synchronously when spaceId changes', () => {
    const { result, rerender } = renderHook(({ id }) => usePinSet(id), { initialProps: { id: 's' } })
    act(() => { result.current.create(pin('p1')) })
    expect(result.current.set.pins.map(p => p.id)).toEqual(['p1'])

    rerender({ id: 't' })
    expect(result.current.set.pins).toEqual([])

    // A mutation in the new space must not carry the old space's pin.
    act(() => { result.current.create(pin('p2')) })
    expect(h.puts.at(-1)!.pins.map(p => p.id)).toEqual(['p2'])
    expect(h.puts.at(-1)!.spaceId).toBe('t')
  })
})

// A mutation computing an unchanged set must issue NO PUT (no-op short-circuit).
describe('usePinSet no-op short-circuit', () => {
  it('issues no PUT when removing a pin that does not exist', () => {
    h.serverState = { pinSets: [{ spaceId: 's', pins: [pin('a')], rev: 0 }] }
    const { result } = renderHook(() => usePinSet('s'))
    act(() => { result.current.remove('does-not-exist') })
    expect(h.puts.length).toBe(0)
  })

  it('issues no PUT when an update leaves the pin unchanged', () => {
    h.serverState = { pinSets: [{ spaceId: 's', pins: [pin('a')], rev: 0 }] }
    const { result } = renderHook(() => usePinSet('s'))
    act(() => { result.current.update('a', p => p) }) // identity → unchanged
    expect(h.puts.length).toBe(0)
  })
})

// clearNode removes all pins for a node in a single apply (one PUT).
describe('usePinSet clearNode', () => {
  it('removes all pins for the given node with a single PUT', () => {
    h.serverState = {
      pinSets: [{
        spaceId: 's',
        pins: [pin('a', 'n1'), pin('b', 'n1'), pin('c', 'n2')],
        rev: 0,
      }],
    }
    const { result } = renderHook(() => usePinSet('s'))
    act(() => { result.current.clearNode('n1') })
    // Only 'c' (n2) should remain.
    expect(result.current.set.pins.map(p => p.id)).toEqual(['c'])
    // Exactly one PUT was fired.
    expect(h.puts.length).toBe(1)
    expect(h.puts[0]!.pins.map((p: { id: string }) => p.id)).toEqual(['c'])
  })

  it('issues no PUT when the node has no pins (no-op short-circuit)', () => {
    h.serverState = {
      pinSets: [{ spaceId: 's', pins: [pin('a', 'n2')], rev: 0 }],
    }
    const { result } = renderHook(() => usePinSet('s'))
    act(() => { result.current.clearNode('n1') })
    expect(h.puts.length).toBe(0)
  })
})

// Writes to two different spaceIds keep independent rev counters.
describe('usePinSet per-space rev monotonicity', () => {
  it('tracks revisions independently per space across switches', () => {
    const { result, rerender } = renderHook(({ id }) => usePinSet(id), { initialProps: { id: 's' } })
    act(() => { result.current.create(pin('a')) }) // 's': rev 1
    rerender({ id: 't' })
    act(() => { result.current.create(pin('b')) }) // 't': its own rev 1, not 's'+1

    const sPut = h.puts.find(p => p.spaceId === 's')!
    const tPut = h.puts.find(p => p.spaceId === 't')!
    expect(sPut.rev).toBe(1)
    expect(tPut.rev).toBe(1)
  })
})
