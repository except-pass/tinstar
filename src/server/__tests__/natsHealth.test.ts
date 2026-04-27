// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NatsHealthMonitor, backoffMs, type ProbeOutcome } from '../nats-health'
import { createSession } from '../sessions/session'
import { DocumentStore } from '../stores/document-store'
import type { Run } from '../../domain/types'

function makeRun(sessionId: string): Run {
  return {
    id: sessionId,
    status: 'idle',
    sessionId,
    taskId: 't1',
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

    // Healthy again: flag cleared, counter reset.
    m.applyOutcome('sess-a', { kind: 'healthy' }, t0 + 2000)
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
})

