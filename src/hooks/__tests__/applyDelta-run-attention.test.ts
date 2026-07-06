import { describe, it, expect } from 'vitest'
import { applyDelta } from '../useServerEvents'

const base = () => ({
  activeSpaceId: '', spaces: [], initiatives: [], epics: [], tasks: [], worktrees: [],
  runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [],
  topicMetadata: [], readyQueue: [], pluginWidgets: [], constellationGraphs: [], pinSets: [],
}) as any

const run = (over: Record<string, unknown> = {}) => ({
  id: 'R-1', status: 'running', background: false, blocked: false,
  sessionId: 'S-1', initiative: 'I', epic: 'E', task: 'T',
  repo: 'r', worktree: 'w', touchedFiles: [], recapEntries: [], rawLogs: '',
  ...over,
})

describe('applyDelta run attention merge', () => {
  it('applies attention arriving on a run delta', () => {
    const prev = applyDelta(base(), { entity: 'run', id: 'R-1', data: run() })
    const next = applyDelta(prev, {
      entity: 'run', id: 'R-1',
      data: run({ attention: { level: 'urgent', reason: 'Waiting on permission', setAt: 't' } }),
    })
    expect(next.runs[0]!.attention?.level).toBe('urgent')
  })

  it('clears attention when the delta omits the key (JSON drops attention: undefined)', () => {
    // The server stores a cleared attention as `attention: undefined`, which
    // JSON.stringify drops from the SSE payload — so a clear arrives as a full
    // run object WITHOUT the attention key. The merge must not inherit the
    // stale attention from the previous client state.
    const withAttention = applyDelta(base(), {
      entity: 'run', id: 'R-1',
      data: run({ attention: { level: 'urgent', reason: 'Waiting on permission', setAt: 't' } }),
    })
    // Simulate the JSON round-trip: cleared attention key is absent entirely.
    const cleared = applyDelta(withAttention, { entity: 'run', id: 'R-1', data: run() })
    expect(cleared.runs[0]!.attention).toBeUndefined()
  })
})
