import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { nextFreeSlot, applyAssign, applyRemove, useConstellationGraph } from '../useConstellationGraph'
import {
  emptyGraph, slotsForNode, nodesInSlot, planBreak,
  removeSnap, removeMember, addMember, type ConstellationGraph,
} from '../../domain/constellationGraph'

const h = vi.hoisted(() => ({
  serverState: { constellationGraphs: [] as ConstellationGraph[] },
  puts: [] as ConstellationGraph[],
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

describe('useConstellationGraph reducers', () => {
  it('nextFreeSlot returns the lowest unoccupied slot', () => {
    let g = emptyGraph('s')
    g = applyAssign(g, '1', 'a')
    expect(nextFreeSlot(g)).toBe('2')
  })
  it('nextFreeSlot returns null when all nine slots are occupied', () => {
    let g = emptyGraph('s')
    for (const s of ['1','2','3','4','5','6','7','8','9'] as const) g = applyAssign(g, s, `w-${s}`)
    expect(nextFreeSlot(g)).toBeNull()
  })
  it('applyAssign adds a member edge', () => {
    const g = applyAssign(emptyGraph('s'), '3', 'pw-x')
    expect(slotsForNode(g, 'pw-x')).toEqual(['3'])
  })
  it('applyRemove drops the member edge and prunes a now-singleton slot', () => {
    let g = emptyGraph('s')
    g = applyAssign(g, '1', 'a'); g = applyAssign(g, '1', 'b')
    g = applyRemove(g, '1', 'a')
    expect(nodesInSlot(g, '1')).toEqual([]) // 'b' alone → slot pruned
  })
})

// Regression: back-to-back mutations against the same render snapshot must
// compose, not clobber. Each mutator builds on the prior optimistic value and
// the final PUT carries the merged graph (no lost updates).
describe('useConstellationGraph composition', () => {
  beforeEach(() => {
    h.serverState = { constellationGraphs: [] }
    h.puts.length = 0
    h.nextResponse = () => Promise.resolve({ ok: true } as Response)
  })

  it('double-assign (form flow) persists both members, not just the last', () => {
    const { result } = renderHook(() => useConstellationGraph('s'))
    act(() => {
      result.current.assign('1', 'a')
      result.current.assign('1', 'b')
    })
    expect(result.current.nodesInSlot('1').sort()).toEqual(['a', 'b'])
    expect(h.puts.at(-1)!.members.map(m => m.widget).sort()).toEqual(['a', 'b'])
  })

  it('dissolve loop removes every member, leaving the slot empty', () => {
    h.serverState = {
      constellationGraphs: [{ spaceId: 's', snapped: [], members: [
        { widget: 'a', slot: '1' }, { widget: 'b', slot: '1' }, { widget: 'c', slot: '1' },
      ] }],
    }
    const { result } = renderHook(() => useConstellationGraph('s'))
    const ids = result.current.nodesInSlot('1').slice()
    act(() => {
      for (const id of ids) result.current.remove('1', id)
    })
    expect(result.current.nodesInSlot('1')).toEqual([])
    expect(h.puts.at(-1)!.members).toEqual([])
  })

  it('break flow splits along a seam and composes a following mutation', () => {
    // a-b-c-d chained in slot 1; break the b-c seam → {a,b} keep, {c,d} regroup.
    h.serverState = {
      constellationGraphs: [{
        spaceId: 's',
        snapped: [['a', 'b'], ['b', 'c'], ['c', 'd']],
        members: ['a', 'b', 'c', 'd'].map(w => ({ widget: w, slot: '1' as const })),
      }],
    }
    const { result } = renderHook(() => useConstellationGraph('s'))
    act(() => {
      const g = result.current.graph
      const plan = planBreak(g, 'b', 'c', '1')
      let next = removeSnap(g, 'b', 'c')
      for (const id of plan.removeFromSlot) next = removeMember(next, id, '1')
      const free = nextFreeSlot(next)
      if (plan.newGroup.length > 0 && free) for (const id of plan.newGroup) next = addMember(next, id, free)
      result.current.applyGraph(next)
    })
    expect(result.current.nodesInSlot('1').sort()).toEqual(['a', 'b'])
    expect(result.current.nodesInSlot('2').sort()).toEqual(['c', 'd'])
    // A mutation right after the break composes off the broken graph, not the
    // stale server snapshot.
    act(() => { result.current.remove('1', 'a') })
    expect(result.current.nodesInSlot('1')).toEqual([])
    expect(h.puts.at(-1)!.members.map(m => m.widget).sort()).toEqual(['c', 'd'])
  })
})

// Regression: a rejected PUT must roll back the optimistic overlay so the UI
// falls back to server state instead of compounding edits the backend refused.
describe('useConstellationGraph failed persist', () => {
  beforeEach(() => {
    h.serverState = { constellationGraphs: [] }
    h.puts.length = 0
    h.nextResponse = () => Promise.resolve({ ok: true } as Response)
  })

  it('rolls back the overlay when the server responds non-OK', async () => {
    h.nextResponse = () => Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve('bad') } as Response)
    const { result } = renderHook(() => useConstellationGraph('s'))
    await act(async () => {
      result.current.assign('1', 'a')
      await Promise.resolve()
    })
    expect(result.current.nodesInSlot('1')).toEqual([])
  })
})

// Regression: an edit followed by an immediate revert (back to the last server
// state) before the first PUT's echo lands must still send a compensating PUT,
// or the in-flight earlier write persists and the revert is silently lost.
describe('useConstellationGraph revert before echo', () => {
  beforeEach(() => {
    h.serverState = { constellationGraphs: [] }
    h.puts.length = 0
    h.nextResponse = () => Promise.resolve({ ok: true } as Response)
  })

  it('sends a compensating PUT when a revert races an in-flight write', async () => {
    // Server already has 'a' in slot 1 — this is the state to revert back to.
    h.serverState = {
      constellationGraphs: [{ spaceId: 's', snapped: [], members: [{ widget: 'a', slot: '1' }] }],
    }
    // Hold the first PUT open so its echo hasn't landed when the revert fires.
    let release!: () => void
    h.nextResponse = () => new Promise<Response>(resolve => {
      release = () => resolve({ ok: true } as Response)
    })
    const { result } = renderHook(() => useConstellationGraph('s'))

    // Edit A (add 'b'), PUT in flight. Then revert B (remove 'b') back to the
    // server's current state before A's echo lands.
    act(() => { result.current.assign('2', 'b') })
    expect(h.puts.length).toBe(1)
    act(() => { result.current.remove('2', 'b') })

    // The revert must be persisted as its own PUT, not dropped as a no-op.
    expect(h.puts.length).toBe(2)
    expect(h.puts.at(-1)!.members.map(m => m.widget)).toEqual(['a'])

    await act(async () => {
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  })
})

// Regression: the provider is reused across space switches, so a pending
// optimistic overlay from one space must not leak into another.
describe('useConstellationGraph space switching', () => {
  beforeEach(() => {
    h.serverState = { constellationGraphs: [] }
    h.puts.length = 0
    h.nextResponse = () => Promise.resolve({ ok: true } as Response)
  })

  it('drops the optimistic overlay when spaceId changes mid-flight', () => {
    const { result, rerender } = renderHook(({ id }) => useConstellationGraph(id), {
      initialProps: { id: 's' },
    })
    act(() => { result.current.assign('1', 'a') })
    expect(result.current.nodesInSlot('1')).toEqual(['a'])

    rerender({ id: 't' })
    expect(result.current.nodesInSlot('1')).toEqual([])

    // A mutation in the new space must not carry the old space's member.
    act(() => { result.current.assign('2', 'b') })
    expect(h.puts.at(-1)!.members.map(m => m.widget)).toEqual(['b'])
    expect(h.puts.at(-1)!.spaceId).toBe('t')
  })
})

// The overlay is dropped strictly by revision: the server reaching our latest
// write's revision (our echo, or a newer write that out-revised us) clears it; a
// lower server revision means our echo is still in flight and must be held.
describe('useConstellationGraph revision-gated overlay', () => {
  beforeEach(() => {
    h.serverState = { constellationGraphs: [] }
    h.puts.length = 0
    h.nextResponse = () => Promise.resolve({ ok: true } as Response)
  })

  it('drops the overlay when a higher-revision server graph supersedes it', async () => {
    // Hold the PUT so the overlay is still active when the newer revision lands.
    let release!: () => void
    h.nextResponse = () => new Promise<Response>(resolve => {
      release = () => resolve({ ok: true } as Response)
    })
    const { result, rerender } = renderHook(() => useConstellationGraph('s'))
    act(() => { result.current.assign('1', 'a') }) // our optimistic write: rev 1
    expect(result.current.nodesInSlot('1')).toEqual(['a'])

    // A newer revision lands (another tab, or a server-side prune) — it out-revises
    // our pending write, so it supersedes our intent and the overlay yields.
    await act(async () => {
      h.serverState = {
        constellationGraphs: [{ spaceId: 's', snapped: [], members: [{ widget: 'z', slot: '3' }], rev: 2 }],
      }
      rerender()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.nodesInSlot('1')).toEqual([])
    expect(result.current.nodesInSlot('3')).toEqual(['z'])

    await act(async () => {
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  })

  it('holds the overlay while the server revision is behind ours (echo still in flight)', async () => {
    h.serverState = {
      constellationGraphs: [{ spaceId: 's', snapped: [], members: [{ widget: 'a', slot: '1' }], rev: 0 }],
    }
    const { result, rerender } = renderHook(() => useConstellationGraph('s'))
    act(() => { result.current.assign('2', 'b') }) // our optimistic write: rev 1
    expect(result.current.nodesInSlot('2')).toEqual(['b'])

    // A reconnect/snapshot re-pushes the pre-edit baseline as a fresh object at the
    // same (lower) revision — our echo hasn't landed yet, so the overlay survives.
    await act(async () => {
      h.serverState = {
        constellationGraphs: [{ spaceId: 's', snapped: [], members: [{ widget: 'a', slot: '1' }], rev: 0 }],
      }
      rerender()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.nodesInSlot('2')).toEqual(['b'])
    expect(result.current.nodesInSlot('1')).toEqual(['a'])
  })

  // Regression (race #1): an edit then an immediate revert leaves the overlay at
  // the revert's revision. The earlier edit's echo (a LOWER revision carrying the
  // intermediate graph) may land first; it must NOT flicker the reverted edit back
  // in. Only the revert's own echo (matching revision) clears the overlay.
  it('holds the overlay through an earlier pipelined echo until the latest revision lands', async () => {
    h.serverState = {
      constellationGraphs: [{ spaceId: 's', snapped: [], members: [{ widget: 'a', slot: '1' }], rev: 0 }],
    }
    let release!: () => void
    h.nextResponse = () => new Promise<Response>(resolve => {
      release = () => resolve({ ok: true } as Response)
    })
    const { result, rerender } = renderHook(() => useConstellationGraph('s'))
    act(() => { result.current.assign('2', 'b') }) // edit:   rev 1 → {a, b}
    act(() => { result.current.remove('2', 'b') })  // revert: rev 2 → {a}
    expect(h.puts.map(p => p.rev)).toEqual([1, 2])
    expect(result.current.nodesInSlot('2')).toEqual([])

    // The earlier edit's echo (rev 1, carries 'b') arrives BEFORE the revert's. The
    // overlay (rev 2) out-revises it, so 'b' must not reappear.
    await act(async () => {
      h.serverState = {
        constellationGraphs: [{ spaceId: 's', snapped: [], members: [{ widget: 'a', slot: '1' }, { widget: 'b', slot: '2' }], rev: 1 }],
      }
      rerender()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.nodesInSlot('2')).toEqual([])

    // The revert's own echo (rev 2) lands — now the overlay clears onto server state.
    await act(async () => {
      h.serverState = {
        constellationGraphs: [{ spaceId: 's', snapped: [], members: [{ widget: 'a', slot: '1' }], rev: 2 }],
      }
      rerender()
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.nodesInSlot('1')).toEqual(['a'])
    expect(result.current.nodesInSlot('2')).toEqual([])
  })

  it('tracks revisions independently per space across switches', () => {
    const { result, rerender } = renderHook(({ id }) => useConstellationGraph(id), {
      initialProps: { id: 's' },
    })
    act(() => { result.current.assign('1', 'a') }) // 's': rev 1
    rerender({ id: 't' })
    act(() => { result.current.assign('2', 'b') }) // 't': its own rev 1, not 's'+1

    const sPut = h.puts.find(p => p.spaceId === 's')!
    const tPut = h.puts.find(p => p.spaceId === 't')!
    expect(sPut.rev).toBe(1)
    expect(tPut.rev).toBe(1)
  })
})
