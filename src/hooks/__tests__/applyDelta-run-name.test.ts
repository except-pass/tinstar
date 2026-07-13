import { describe, it, expect } from 'vitest'
import { applyDelta } from '../useServerEvents'

const base = () => ({
  activeSpaceId: '', spaces: [], initiatives: [], epics: [], tasks: [], worktrees: [],
  runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [],
  topicMetadata: [], readyQueue: [], pluginWidgets: [], constellationGraphs: [], pinSets: [],
}) as any

const run = (over: Record<string, unknown> = {}) => ({
  id: 'vpppm-general-pourpose-2dc86', status: 'running', background: false, blocked: false,
  sessionId: 'vpppm-general-pourpose-2dc86', initiative: 'I', epic: 'E', task: 'T',
  repo: 'r', worktree: 'w', touchedFiles: [], recapEntries: [], rawLogs: '',
  ...over,
})

/** Round-trip through JSON exactly as the SSE bridge does, so `name: undefined`
 *  is genuinely dropped rather than merely omitted by the test author. */
const overTheWire = (data: unknown) => JSON.parse(JSON.stringify(data))

describe('applyDelta run name merge', () => {
  it('applies a friendly name arriving on a run delta', () => {
    const prev = applyDelta(base(), { entity: 'run', id: 'vpppm-general-pourpose-2dc86', data: run() })
    const next = applyDelta(prev, {
      entity: 'run', id: 'vpppm-general-pourpose-2dc86',
      data: overTheWire(run({ name: 'PM Vpp project' })),
    })
    expect(next.runs[0]!.name).toBe('PM Vpp project')
  })

  it('clears the name when the delta omits the key (JSON drops name: undefined)', () => {
    // A cleared name is stored server-side as `name: undefined`, which
    // JSON.stringify drops from the SSE payload entirely — the clear arrives as
    // a full run object with NO name key. A plain spread-merge would inherit the
    // stale name forever and the run could never fall back to its id.
    const named = applyDelta(base(), {
      entity: 'run', id: 'vpppm-general-pourpose-2dc86',
      data: overTheWire(run({ name: 'PM Vpp project' })),
    })
    expect(named.runs[0]!.name).toBe('PM Vpp project')

    const cleared = applyDelta(named, {
      entity: 'run', id: 'vpppm-general-pourpose-2dc86',
      data: overTheWire(run({ name: undefined })),
    })
    expect(cleared.runs[0]!.name).toBeUndefined()
  })

  it('renames from one name to another', () => {
    const named = applyDelta(base(), {
      entity: 'run', id: 'vpppm-general-pourpose-2dc86',
      data: overTheWire(run({ name: 'PM Vpp project' })),
    })
    const renamed = applyDelta(named, {
      entity: 'run', id: 'vpppm-general-pourpose-2dc86',
      data: overTheWire(run({ name: 'VPP program management' })),
    })
    expect(renamed.runs[0]!.name).toBe('VPP program management')
  })
})
