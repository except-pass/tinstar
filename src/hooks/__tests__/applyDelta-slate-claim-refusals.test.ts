// A claim refusal has to survive the wire, and — harder — its CLEAR has to
// survive it too (plan U6, R3).
//
// The trap is documented in
// docs/solutions/integration-issues/sse-delta-drops-undefined-keys-stale-client-state.md:
// the server stores a cleared field as `undefined`, `JSON.stringify` omits the key
// from the SSE payload entirely, and a client that spread-merges inherits the stale
// value forever. A refusal that clears the moment the author fixes their file is
// exactly that shape, so both directions are asserted here through a REAL
// serialization round trip rather than a hand-built object with the key still on it.
import { describe, it, expect } from 'vitest'
import { applyDelta } from '../useServerEvents'
import type { SlateSurface } from '../../types'

const base = () => ({
  activeSpaceId: '', spaces: [], initiatives: [], epics: [], tasks: [], worktrees: [],
  runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [],
  topicMetadata: [], readyQueue: [], pluginWidgets: [], constellationGraphs: [], pinSets: [],
}) as any

const REFUSAL = 'claim "u1" (witness unit-lands): no such witness kind — this host implements unit-landed, http-status'

function surface(claimRefusals?: string[]): SlateSurface {
  return {
    id: 'roadmap',
    author: 'agent',
    kind: 'open-point',
    headline: 'Roadmap — 3 of 8 landed',
    status: 'open',
    freshness: {
      phase: 'current',
      overdue: false,
      observedGeneration: 2,
      verifiedAt: 2_000,
      // The server stores "nothing refused" as `undefined`, never as `[]`.
      ...(claimRefusals ? { claimRefusals } : {}),
    },
    createdAt: 1,
    amendedAt: 2_000,
  }
}

const run = (slate: SlateSurface[]) => ({
  id: 'R-1', status: 'running', background: false, blocked: false,
  sessionId: 'S-1', initiative: 'I', epic: 'E', task: 'T',
  repo: 'r', worktree: 'w', touchedFiles: [], recapEntries: [], rawLogs: '',
  slate,
})

/** What the SSE stream actually delivers: the delta, stringified and re-parsed, so
 *  every `undefined` the server wrote is a key that simply is not there. */
function overTheWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('applyDelta carries a Slate claim refusal, and its clear', () => {
  it('delivers the refusal through a serialized run delta', () => {
    const next = applyDelta(base(), overTheWire({ entity: 'run', id: 'R-1', data: run([surface([REFUSAL])]) }))
    expect(next.runs[0]!.slate![0]!.freshness!.claimRefusals).toEqual([REFUSAL])
  })

  it('clears the refusal when the fixed entry arrives without the key', () => {
    const refused = applyDelta(base(), overTheWire({ entity: 'run', id: 'R-1', data: run([surface([REFUSAL])]) }))
    expect(refused.runs[0]!.slate![0]!.freshness!.claimRefusals).toHaveLength(1)

    // The author fixed the witness kind. The server writes `claimRefusals:
    // undefined`, which never reaches the wire — so the fix arrives as a full run
    // whose surface simply has no such key, and the merge must not keep the old one.
    const fixed = applyDelta(refused, overTheWire({ entity: 'run', id: 'R-1', data: run([surface()]) }))
    expect(fixed.runs[0]!.slate![0]!.freshness!.claimRefusals).toBeUndefined()
  })

  it('does not leak a refusal onto a sibling surface of the same run', () => {
    const bad = { ...surface([REFUSAL]), id: 'bad' }
    const good = { ...surface(), id: 'good' }
    const next = applyDelta(base(), overTheWire({ entity: 'run', id: 'R-1', data: run([bad, good]) }))

    const merged = next.runs[0]!.slate!
    expect(merged.find(s => s.id === 'bad')!.freshness!.claimRefusals).toEqual([REFUSAL])
    expect(merged.find(s => s.id === 'good')!.freshness!.claimRefusals).toBeUndefined()
  })
})
