import { describe, it, expect } from 'vitest'
import { applyDelta, _resetServerEventsForTests } from '../useServerEvents'
import type { ConstellationGraph } from '../../domain/constellationGraph'

// applyDelta is a pure function — no EventSource needed.
// _resetServerEventsForTests keeps the module singleton clean between test files.

const baseState = (() => {
  _resetServerEventsForTests()
  // Access the exported applyDelta with an empty prev state by calling it once
  // on a no-op delta to get back the EMPTY_STATE shape.
  // We construct a minimal ServerState manually instead.
  return {
    activeSpaceId: '',
    spaces: [],
    initiatives: [],
    epics: [],
    tasks: [],
    worktrees: [],
    runs: [],
    marshal: null,
    editorWidgets: [],
    browserWidgets: [],
    imageWidgets: [],
    topicMetadata: [],
    readyQueue: [],
    pluginWidgets: [],
    constellationGraphs: [],
  } as Parameters<typeof applyDelta>[0]
})()

const graph1: ConstellationGraph = { spaceId: 'space-1', snapped: [{ nodes: ['a', 'b'] }], members: [] }
const graph2: ConstellationGraph = { spaceId: 'space-2', snapped: [], members: [{ widget: 'w1', slot: '1' }] }

describe('applyDelta — constellationGraph arm', () => {
  it('inserts a graph when none exists yet', () => {
    const next = applyDelta(baseState, { entity: 'constellationGraph', id: 'space-1', data: graph1 })
    expect(next.constellationGraphs).toHaveLength(1)
    expect(next.constellationGraphs[0]).toEqual(graph1)
  })

  it('replaces an existing graph (upsert by spaceId)', () => {
    const stateWithOne = { ...baseState, constellationGraphs: [graph1] }
    const updated: ConstellationGraph = { ...graph1, snapped: [{ nodes: ['c', 'd'] }] }
    const next = applyDelta(stateWithOne, { entity: 'constellationGraph', id: 'space-1', data: updated })
    expect(next.constellationGraphs).toHaveLength(1)
    expect(next.constellationGraphs[0]!.snapped).toEqual([{ nodes: ['c', 'd'] }])
  })

  it('appends without touching other graphs', () => {
    const stateWithOne = { ...baseState, constellationGraphs: [graph1] }
    const next = applyDelta(stateWithOne, { entity: 'constellationGraph', id: 'space-2', data: graph2 })
    expect(next.constellationGraphs).toHaveLength(2)
    expect(next.constellationGraphs.map(g => g.spaceId)).toEqual(['space-1', 'space-2'])
  })

  it('removes a graph on null data', () => {
    const stateWithTwo = { ...baseState, constellationGraphs: [graph1, graph2] }
    const next = applyDelta(stateWithTwo, { entity: 'constellationGraph', id: 'space-1', data: null })
    expect(next.constellationGraphs).toHaveLength(1)
    expect(next.constellationGraphs[0]!.spaceId).toBe('space-2')
  })

  it('no-ops on null data when graph is not present', () => {
    const next = applyDelta(baseState, { entity: 'constellationGraph', id: 'space-99', data: null })
    expect(next.constellationGraphs).toHaveLength(0)
    expect(next).toBe(next) // still returns an object (no throw)
  })

  it('does not mutate constellationGraphs on unrelated delta entity', () => {
    const stateWithOne = { ...baseState, constellationGraphs: [graph1] }
    const next = applyDelta(stateWithOne, { entity: 'commit', id: '', data: null })
    expect(next.constellationGraphs).toBe(stateWithOne.constellationGraphs) // same reference
  })

  it('clears constellationGraphs on an "all" reset delta', () => {
    const stateWithTwo = { ...baseState, constellationGraphs: [graph1, graph2] }
    const next = applyDelta(stateWithTwo, { entity: 'all', id: '*', data: null })
    expect(next.constellationGraphs).toEqual([])
  })
})
