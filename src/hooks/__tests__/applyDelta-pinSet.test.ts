import { describe, it, expect } from 'vitest'
import { applyDelta } from '../useServerEvents'

const base = () => ({
  activeSpaceId: '', spaces: [], initiatives: [], epics: [], tasks: [], worktrees: [],
  runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [],
  topicMetadata: [], readyQueue: [], pluginWidgets: [], constellationGraphs: [], pinSets: [],
}) as any

describe('applyDelta pinSet', () => {
  it('inserts a new pin set', () => {
    const next = applyDelta(base(), { entity: 'pinSet', id: 'sp', data: { spaceId: 'sp', pins: [], rev: 1 } })
    expect(next.pinSets).toHaveLength(1)
  })
  it('replaces an existing pin set by spaceId', () => {
    const prev = applyDelta(base(), { entity: 'pinSet', id: 'sp', data: { spaceId: 'sp', pins: [], rev: 1 } })
    const next = applyDelta(prev, { entity: 'pinSet', id: 'sp', data: { spaceId: 'sp', pins: [{ id: 'p', nodeId: 'n', nx: 0, ny: 0, comment: '', createdAt: 1 }], rev: 2 } })
    expect(next.pinSets).toHaveLength(1)
    expect(next.pinSets[0]!.pins).toHaveLength(1)
  })
  it('null data removes the pin set', () => {
    const prev = applyDelta(base(), { entity: 'pinSet', id: 'sp', data: { spaceId: 'sp', pins: [], rev: 1 } })
    expect(applyDelta(prev, { entity: 'pinSet', id: 'sp', data: null }).pinSets).toHaveLength(0)
  })
})
