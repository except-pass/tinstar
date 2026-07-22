// @vitest-environment node
//
// The Slate staleness sweep (U9 / R19): a `kill -9`'d `tinstar-run` wrapper never
// runs its finalize trap, so only a SERVER sweep can retire its fake-live spinner.
// These tests drive a fake clock (explicit `now`) so there is no real waiting.
import { describe, it, expect } from 'vitest'
import { SlateStore, type SlateChange, type PointInput } from '../../stores/slate'
import { DocumentStore } from '../../stores/document-store'
import type { Run } from '../../../domain/types'
import { sweepStalledProcessPoints, DEFAULT_STALENESS_MS } from '../slate-staleness'

const RUN = 'CLD-run-1'
const THRESHOLD = 10 * 60_000 // 10 minutes

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN, sessionId: RUN, taskId: 't1', worktreeId: 'wt1',
    status: 'running', background: false, blocked: false,
    initiative: 'i', epic: 'e', task: 't', repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null, createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

function body(text: string) {
  return { root: 'r', components: [{ component: 'Text', id: 'r', text }] }
}

function procInput(id: string, over: Partial<PointInput> = {}): PointInput {
  return { id, author: 'process', headline: `h:${id}`, content: body('running…'), ...over }
}

function makeStore(): { store: SlateStore; changes: SlateChange[] } {
  const changes: SlateChange[] = []
  const store = new SlateStore((e) => { changes.push(e) })
  return { store, changes }
}

describe('sweepStalledProcessPoints (R19)', () => {
  it('marks a stale process point and leaves a fresh one alone', () => {
    const { store, changes } = makeStore()
    // A process point amended long ago (its wrapper was hard-killed). Re-project it
    // alongside a fresh point at `now`: the stale point's body is unchanged so its
    // `amendedAt` stays at 0, while the fresh point's `amendedAt` is `now`.
    store.applyProjection(RUN, [procInput('stale')], 0)
    const now = THRESHOLD + 5_000
    store.applyProjection(RUN, [procInput('stale'), procInput('fresh')], now)
    changes.length = 0

    const affected = sweepStalledProcessPoints(store, now, THRESHOLD)

    expect([...affected]).toEqual([RUN])
    expect(store.getPoint(RUN, 'stale')!.stalledAt).toBe(now)
    expect(store.getPoint(RUN, 'fresh')!.stalledAt).toBeUndefined()
    // Exactly one point changed → exactly one emit.
    expect(changes.map((c) => c.id)).toEqual(['stale'])
  })

  it('does not mark a resolved or dismissed process point', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [procInput('resolved'), procInput('dismissed')], 0)
    store.resolve(RUN, 'resolved', 0)
    store.dismiss(RUN, 'dismissed', 0)
    const now = THRESHOLD + 1

    sweepStalledProcessPoints(store, now, THRESHOLD)

    expect(store.getPoint(RUN, 'resolved')!.stalledAt).toBeUndefined()
    expect(store.getPoint(RUN, 'dismissed')!.stalledAt).toBeUndefined()
  })

  it('only marks process-authored points, not agent/user ones', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [
      procInput('proc'),
      { id: 'agent', author: 'agent', headline: 'h', content: body('x') },
    ], 0)
    const now = THRESHOLD + 1

    sweepStalledProcessPoints(store, now, THRESHOLD)

    expect(store.getPoint(RUN, 'proc')!.stalledAt).toBe(now)
    expect(store.getPoint(RUN, 'agent')!.stalledAt).toBeUndefined()
  })

  it('is idempotent — a second sweep re-marks nothing (no emit storm)', () => {
    const { store, changes } = makeStore()
    store.applyProjection(RUN, [procInput('stale')], 0)
    const now = THRESHOLD + 1
    sweepStalledProcessPoints(store, now, THRESHOLD)
    changes.length = 0

    const affected = sweepStalledProcessPoints(store, now + 60_000, THRESHOLD)

    expect([...affected]).toEqual([])
    expect(changes).toHaveLength(0)
    // stalledAt keeps its ORIGINAL timestamp (not re-stamped).
    expect(store.getPoint(RUN, 'stale')!.stalledAt).toBe(now)
  })

  it('a later file re-projection that changes the body clears the stalled marker', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [procInput('p', { content: body('running…') })], 0)
    const now = THRESHOLD + 1
    sweepStalledProcessPoints(store, now, THRESHOLD)
    expect(store.getPoint(RUN, 'p')!.stalledAt).toBe(now)

    // Wrapper resumed writing: a body change re-freshens the point and un-stalls it.
    store.applyProjection(RUN, [procInput('p', { content: body('✓ done') })], now + 1000)

    expect(store.getPoint(RUN, 'p')!.stalledAt).toBeUndefined()
  })

  it('respects the threshold boundary (exactly at threshold is NOT yet stale)', () => {
    const { store } = makeStore()
    store.applyProjection(RUN, [procInput('p')], 0)
    // now - amendedAt === THRESHOLD → not strictly older → not marked.
    sweepStalledProcessPoints(store, THRESHOLD, THRESHOLD)
    expect(store.getPoint(RUN, 'p')!.stalledAt).toBeUndefined()
    // One ms past the threshold → marked.
    sweepStalledProcessPoints(store, THRESHOLD + 1, THRESHOLD)
    expect(store.getPoint(RUN, 'p')!.stalledAt).toBe(THRESHOLD + 1)
  })

  it('DEFAULT_STALENESS_MS is 10 minutes', () => {
    expect(DEFAULT_STALENESS_MS).toBe(10 * 60_000)
  })
})

describe('DocumentStore.markStalledSlatePoints re-projects the run render channel', () => {
  it('carries stalledAt onto RunData.slate so the client can style it', () => {
    const store = new DocumentStore()
    store.upsertRun(RUN, makeRun())
    store.applyRunSlateProjection(RUN, [
      { id: 'proc', author: 'process', headline: 'build', content: body('running…') },
    ], 0)

    const now = THRESHOLD + 1
    store.markStalledSlatePoints(now, THRESHOLD)

    const run = store.getRun(RUN)
    const surface = run?.slate?.find((s) => s.id === 'proc')
    expect(surface?.stalledAt).toBe(now)
  })
})
