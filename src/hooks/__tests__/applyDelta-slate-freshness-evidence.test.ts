// Freshness evidence has to survive the wire, and — harder — its CLEAR has to
// survive it too (R3/R16/R17, KTD11).
//
// The trap is documented in
// docs/solutions/integration-issues/sse-delta-drops-undefined-keys-stale-client-state.md:
// the server stores a cleared field as `undefined`, `JSON.stringify` omits the key
// from the SSE payload entirely, and a client that spread-merges inherits the stale
// value forever. A failure badge that never goes away after the Surface recovers is
// exactly that shape — and it is the badge users would learn to distrust first, so
// both directions are asserted here through a REAL serialization round trip rather
// than a hand-built object with the key still on it.
//
// This is why `lastCheck` is `SurfaceLastCheck | null` rather than optional: the
// server writes an explicit `null` for "never checked", which survives
// `JSON.stringify` where an omitted key does not.
import { describe, it, expect } from 'vitest'
import { applyDelta } from '../useServerEvents'
import type { SlateSurface } from '../../types'
import type { SurfaceLastCheck } from '../../domain/types'

const base = () => ({
  activeSpaceId: '', spaces: [], initiatives: [], epics: [], tasks: [], worktrees: [],
  runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [],
  topicMetadata: [], readyQueue: [], pluginWidgets: [], constellationGraphs: [], pinSets: [],
}) as any

const FAILED: SurfaceLastCheck = {
  startedAt: 9_000, finishedAt: 9_400, execution: 'owner',
  reason: 'you navigated to it', targetGeneration: 4,
  outcome: 'failed', detail: 'the coverage tool is not installed',
}

const SUCCEEDED: SurfaceLastCheck = {
  startedAt: 12_000, finishedAt: 12_300, execution: 'host',
  reason: 'its verification interval elapsed', targetGeneration: 5,
  outcome: 'succeeded',
}

function surface(over: {
  lastCheck?: SurfaceLastCheck | null
  lastKnownAt?: number
  failure?: { message: string; at: number }
} = {}): SlateSurface {
  return {
    id: 'coverage',
    author: 'agent',
    kind: 'open-point',
    headline: 'Coverage 88%',
    status: 'open',
    freshness: {
      phase: 'current',
      overdue: false,
      observedGeneration: 5,
      verifiedAt: 12_300,
      lastKnownAt: over.lastKnownAt ?? 6_000,
      // Explicitly null when there is no check — the whole point of the nullable.
      lastCheck: over.lastCheck ?? null,
      // The server stores "no failure" as `undefined`, never as an empty object.
      ...(over.failure ? { failure: over.failure } : {}),
    },
    createdAt: 1,
    amendedAt: 12_300,
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

const deliver = (prev: any, slate: SlateSurface[]) =>
  applyDelta(prev, overTheWire({ entity: 'run', id: 'R-1', data: run(slate) }))

describe('applyDelta carries freshness evidence, and its clear', () => {
  it('never-checked arrives as an explicit null rather than a missing key', () => {
    const next = deliver(base(), [surface()])
    const f = next.runs[0]!.slate![0]!.freshness!
    expect(f.lastCheck).toBeNull()
    expect(f.lastKnownAt).toBe(6_000)
  })

  it('delivers a failed check whole — outcome, timing, executor, and detail', () => {
    // The card has to render all of it without going to the logs (R3), so all of it
    // has to survive serialization.
    const next = deliver(base(), [surface({ lastCheck: FAILED, failure: { message: 'boom', at: 9_400 } })])
    expect(next.runs[0]!.slate![0]!.freshness!.lastCheck).toEqual(FAILED)
  })

  it('a later SUCCESS clears the failure badge on every client', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. A Surface that failed once and then
    // recovered must stop showing the failure — otherwise the honest-freshness
    // contract reads, to a user, as a badge that lies.
    const failed = deliver(base(), [surface({ lastCheck: FAILED, failure: { message: 'boom', at: 9_400 } })])
    expect(failed.runs[0]!.slate![0]!.freshness!.lastCheck!.outcome).toBe('failed')

    // The server rebuilds freshness on a successful barrier, so `failure` is written
    // as `undefined` and never reaches the wire at all.
    const recovered = deliver(failed, [surface({ lastCheck: SUCCEEDED, lastKnownAt: 12_300 })])
    const f = recovered.runs[0]!.slate![0]!.freshness!
    expect(f.lastCheck!.outcome).toBe('succeeded')
    expect(f.failure).toBeUndefined()
  })

  it('a set-then-clear-then-set sequence lands on the LAST state, not an accumulation', () => {
    let state = deliver(base(), [surface({ lastCheck: FAILED })])
    state = deliver(state, [surface({ lastCheck: null })])
    expect(state.runs[0]!.slate![0]!.freshness!.lastCheck).toBeNull()
    state = deliver(state, [surface({ lastCheck: SUCCEEDED })])
    expect(state.runs[0]!.slate![0]!.freshness!.lastCheck).toEqual(SUCCEEDED)
  })

  it('an unchanged successful check moves lastCheck without moving lastKnownAt', () => {
    // The two-field contract as a client sees it: the content is still from 06:00,
    // and the host confirmed at 12:00 that it still holds.
    const next = deliver(base(), [surface({ lastCheck: SUCCEEDED, lastKnownAt: 6_000 })])
    const f = next.runs[0]!.slate![0]!.freshness!
    expect(f.lastKnownAt).toBe(6_000)
    expect(f.lastCheck!.finishedAt).toBe(12_300)
  })

  it('does not leak one surface\'s check onto a sibling in the same run', () => {
    const bad = { ...surface({ lastCheck: FAILED }), id: 'bad' }
    const good = { ...surface(), id: 'good' }
    const merged = deliver(base(), [bad, good]).runs[0]!.slate!
    expect(merged.find((s: SlateSurface) => s.id === 'bad')!.freshness!.lastCheck!.outcome).toBe('failed')
    expect(merged.find((s: SlateSurface) => s.id === 'good')!.freshness!.lastCheck).toBeNull()
  })
})
