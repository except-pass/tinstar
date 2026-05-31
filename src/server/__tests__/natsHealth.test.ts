// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NatsHealthMonitor, backoffMs, type ProbeOutcome } from '../nats-health'
import { createSession, setState, updateSession } from '../sessions/session'
import { DocumentStore } from '../stores/document-store'
import type { Run } from '../../domain/types'

function makeRun(sessionId: string): Run {
  return {
    id: sessionId,
    status: 'idle',
    sessionId,
    taskId: 't1',
    worktreeId: 'wt1',
    createdAt: '2026-01-01T00:00:00.000Z',
    initiative: '',
    epic: '',
    task: '',
    repo: '',
    worktree: '',
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: null,
    backend: null,
    natsControlOrphanedAt: null,
  }
}

describe('backoffMs', () => {
  it('produces the documented schedule (30s, 60s, 2m, 4m, 5m cap)', () => {
    expect(backoffMs(0)).toBe(30_000)  // baseline
    expect(backoffMs(1)).toBe(30_000)  // 1 fail → 30s
    expect(backoffMs(2)).toBe(60_000)  // 2 fail → 60s
    expect(backoffMs(3)).toBe(120_000) // 3 fail → 2m
    expect(backoffMs(4)).toBe(240_000) // 4 fail → 4m
    expect(backoffMs(5)).toBe(300_000) // 5 fail → 5m (cap)
    expect(backoffMs(6)).toBe(300_000) // capped
    expect(backoffMs(20)).toBe(300_000) // still capped
  })
})

describe('NatsHealthMonitor', () => {
  let sessionsDir: string
  let docStore: DocumentStore

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'nats-health-test-'))
    docStore = new DocumentStore()
  })

  function makeMonitor(probe: (p: string) => Promise<ProbeOutcome>) {
    return new NatsHealthMonitor({
      sessionsDir,
      docStore,
      getSocketPath: () => '/tmp/fake.sock',
      probe,
    })
  }

  function makeSession(name: string) {
    createSession(sessionsDir, {
      name,
      backend: 'tmux',
      nats: { enabled: true, subscriptions: [] },
    })
    docStore.upsertRun(name, makeRun(name))
  }

  it('trackSession adds, untrackSession removes', () => {
    const m = makeMonitor(async () => ({ kind: 'healthy' }))
    expect(m.__getState('sess-a')).toBeUndefined()
    m.trackSession('sess-a')
    expect(m.__getState('sess-a')).toBeDefined()
    m.untrackSession('sess-a')
    expect(m.__getState('sess-a')).toBeUndefined()
  })

  it('untrackSession clears in-flight backoff state', () => {
    const m = makeMonitor(async () => ({ kind: 'healthy' }))
    m.trackSession('sess-a')
    m.applyOutcome('sess-a', { kind: 'orphaned' }, Date.now())
    const before = m.__getState('sess-a')!
    expect(before.consecutiveFailures).toBe(1)
    m.untrackSession('sess-a')
    expect(m.__getState('sess-a')).toBeUndefined()
    // re-tracking gives a fresh state
    m.trackSession('sess-a')
    expect(m.__getState('sess-a')!.consecutiveFailures).toBe(0)
  })

  it('healthy → orphaned → cleared transitions toggle the orphan flag', async () => {
    const m = makeMonitor(async () => ({ kind: 'healthy' }))
    makeSession('sess-a')
    m.trackSession('sess-a')

    const t0 = Date.now()
    // Healthy: should clear (already null) — flag stays null.
    m.applyOutcome('sess-a', { kind: 'healthy' }, t0)
    expect(docStore.getRun('sess-a')?.natsControlOrphanedAt).toBeNull()
    expect(m.__getState('sess-a')!.consecutiveFailures).toBe(0)

    // Orphaned: flag set, failures bumped.
    m.applyOutcome('sess-a', { kind: 'orphaned' }, t0 + 1000)
    const orphaned = docStore.getRun('sess-a')?.natsControlOrphanedAt
    expect(typeof orphaned).toBe('string')
    expect(m.__getState('sess-a')!.consecutiveFailures).toBe(1)

    // Healthy again: flag cleared (passing the observed pre-probe value
    // — what the probe loop captures before awaiting), counter reset.
    m.applyOutcome('sess-a', { kind: 'healthy' }, t0 + 2000, orphaned ?? null)
    expect(docStore.getRun('sess-a')?.natsControlOrphanedAt).toBeNull()
    expect(m.__getState('sess-a')!.consecutiveFailures).toBe(0)
  })

  it('degraded outcome does NOT toggle the orphan flag', () => {
    const m = makeMonitor(async () => ({ kind: 'degraded' }))
    makeSession('sess-b')
    m.trackSession('sess-b')

    m.applyOutcome('sess-b', { kind: 'degraded', natsState: 'reconnecting' }, Date.now())
    expect(docStore.getRun('sess-b')?.natsControlOrphanedAt).toBeNull()
    // but failures count up so we back off
    expect(m.__getState('sess-b')!.consecutiveFailures).toBe(1)
  })

  it('next-probe schedule follows the backoff curve on consecutive failures', () => {
    const m = makeMonitor(async () => ({ kind: 'orphaned' }))
    makeSession('sess-c')
    m.trackSession('sess-c')

    const now = 1_000_000
    m.applyOutcome('sess-c', { kind: 'orphaned' }, now)
    expect(m.__getState('sess-c')!.nextProbeAt).toBe(now + 30_000)
    m.applyOutcome('sess-c', { kind: 'orphaned' }, now)
    expect(m.__getState('sess-c')!.nextProbeAt).toBe(now + 60_000)
    m.applyOutcome('sess-c', { kind: 'orphaned' }, now)
    expect(m.__getState('sess-c')!.nextProbeAt).toBe(now + 120_000)
    m.applyOutcome('sess-c', { kind: 'orphaned' }, now)
    expect(m.__getState('sess-c')!.nextProbeAt).toBe(now + 240_000)
    m.applyOutcome('sess-c', { kind: 'orphaned' }, now)
    expect(m.__getState('sess-c')!.nextProbeAt).toBe(now + 300_000)
    m.applyOutcome('sess-c', { kind: 'orphaned' }, now)
    expect(m.__getState('sess-c')!.nextProbeAt).toBe(now + 300_000)
    // healthy resets to base
    m.applyOutcome('sess-c', { kind: 'healthy' }, now)
    expect(m.__getState('sess-c')!.nextProbeAt).toBe(now + 30_000)
    expect(m.__getState('sess-c')!.consecutiveFailures).toBe(0)
  })

  it('applyOutcome on an unknown session is a no-op', () => {
    const m = makeMonitor(async () => ({ kind: 'healthy' }))
    expect(() => m.applyOutcome('ghost', { kind: 'orphaned' }, Date.now())).not.toThrow()
  })

  it('skips probing for stopped sessions — flag is never touched', async () => {
    let probeCalls = 0
    const m = makeMonitor(async () => {
      probeCalls++
      return { kind: 'orphaned', reason: 'should not be called' }
    })
    makeSession('sess-stopped')
    setState(sessionsDir, 'sess-stopped', 'stopped')
    m.trackSession('sess-stopped')

    await m.__tickNow()

    expect(probeCalls).toBe(0)
    expect(m.__getState('sess-stopped')!.consecutiveFailures).toBe(0)
    expect(docStore.getRun('sess-stopped')?.natsControlOrphanedAt).toBeNull()
    // nextProbeAt was advanced so we re-evaluate next interval
    expect(m.__getState('sess-stopped')!.nextProbeAt).toBeGreaterThan(0)
  })

  it('does not clear an orphan flag that was set during a probe (race-clear protection)', async () => {
    // Probe is "in flight": we'll resolve it manually after mutating the
    // session's natsControlOrphanedAt to simulate the racing subscribe-
    // failure path in routes.ts.
    let resolveProbe!: (o: ProbeOutcome) => void
    const probePromise = new Promise<ProbeOutcome>(resolve => { resolveProbe = resolve })
    const m = makeMonitor(() => probePromise)
    makeSession('sess-race')
    m.trackSession('sess-race')

    // Kick off the probe via tick
    const tickPromise = m.__tickNow()
    expect(m.__inFlightSize()).toBe(1)

    // Racing writer: opportunistic write sets the flag before our probe resolves
    const racingValue = '2030-01-01T00:00:00.000Z'
    updateSession(sessionsDir, 'sess-race', { natsControlOrphanedAt: racingValue })
    const run = docStore.getRun('sess-race')!
    docStore.upsertRun('sess-race', { ...run, natsControlOrphanedAt: racingValue })

    // Probe resolves healthy — would naively try to clear, but observedFlagAtStart
    // (null) no longer matches current (racingValue), so the clear is skipped.
    resolveProbe({ kind: 'healthy' })
    await tickPromise
    // Allow the async fire-and-forget to settle
    await new Promise(resolve => setImmediate(resolve))

    expect(docStore.getRun('sess-race')?.natsControlOrphanedAt).toBe(racingValue)
    expect(m.__inFlightSize()).toBe(0)
  })

  it('in-flight guard prevents concurrent same-session probes', async () => {
    let probeCalls = 0
    const resolvers: Array<(o: ProbeOutcome) => void> = []
    const m = makeMonitor(() => {
      probeCalls++
      return new Promise<ProbeOutcome>(resolve => { resolvers.push(resolve) })
    })
    makeSession('sess-slow')
    m.trackSession('sess-slow')

    // First tick starts a probe
    await m.__tickNow()
    expect(probeCalls).toBe(1)
    expect(m.__inFlightSize()).toBe(1)

    // Second tick while probe still pending: should NOT fire another
    await m.__tickNow()
    expect(probeCalls).toBe(1)

    // Resolve the first probe
    resolvers[0]!({ kind: 'healthy' })
    await new Promise(resolve => setImmediate(resolve))
    expect(m.__inFlightSize()).toBe(0)

    // After resolution, nextProbeAt was bumped to base interval; force
    // re-eligibility so the next tick is allowed to fire.
    m.__getState('sess-slow')!.nextProbeAt = 0
    await m.__tickNow()
    expect(probeCalls).toBe(2)
    resolvers[1]!({ kind: 'healthy' })
    await new Promise(resolve => setImmediate(resolve))
  })

  it('start/stop/start/stop is clean — re-tracking after restart works fresh', () => {
    const m = makeMonitor(async () => ({ kind: 'healthy' }))
    expect(() => {
      m.start()
      m.stop()
      m.start()
      m.stop()
    }).not.toThrow()
    expect(m.__inFlightSize()).toBe(0)
    // After stop, states are cleared; tracking again gives a fresh state
    m.trackSession('sess-fresh')
    expect(m.__getState('sess-fresh')!.consecutiveFailures).toBe(0)
    expect(m.__getState('sess-fresh')!.nextProbeAt).toBe(0)
  })

  it('probe resolving after stop() is graceful — no crash, no flag write', async () => {
    let resolveProbe!: (o: ProbeOutcome) => void
    const m = makeMonitor(() => new Promise<ProbeOutcome>(resolve => { resolveProbe = resolve }))
    makeSession('sess-late')
    m.trackSession('sess-late')

    const tickPromise = m.__tickNow()
    expect(m.__inFlightSize()).toBe(1)

    // Stop the monitor while the probe is still pending
    m.stop()
    expect(m.__getState('sess-late')).toBeUndefined()

    // Now resolve the probe — applyOutcome should detect missing state and bail
    resolveProbe({ kind: 'orphaned' })
    await tickPromise
    await new Promise(resolve => setImmediate(resolve))

    expect(docStore.getRun('sess-late')?.natsControlOrphanedAt).toBeNull()
  })
})

