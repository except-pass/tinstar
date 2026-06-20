import { describe, it, expect, beforeEach } from 'vitest'
import {
  observeFromRecapEntries,
  flushOnStateChange,
  reconcileLiveSessions,
  turnLengthHist,
  _resetForTests,
} from '../turn-length'
import type { RecapEntry } from '../../../types'
import type { Session } from '../../sessions/session'

function entry(type: 'user' | 'agent', timestamp: string): RecapEntry {
  return { id: `${type}-${timestamp}`, type, content: '', timestamp }
}

function fakeSession(name: string, ccConvId: string | null = 'conv-1'): Session {
  return {
    name,
    backend: 'tmux',
    state: 'running',
    project: null,
    workspace: { path: null, branch: null } as Session['workspace'],
    conversation: { id: ccConvId },
    profile: null,
    oneshot: false,
    skipPermissions: false,
    cliTemplate: null,
    adapter: 'claude',
    nats: null,
    port: null,
    ttydPid: null,
    natsControlOrphanedAt: null,
    appendSystemPrompt: null,
    agent: null,
    modelOverride: null,
    created: '2026-05-17T00:00:00.000Z',
    lastActive: '2026-05-17T00:00:00.000Z',
  }
}

async function bucketCounts(labels: { tinstar_session: string; cc_conversation_id: string }) {
  const json = await turnLengthHist.get()
  return json.values.filter(
    v =>
      v.labels.tinstar_session === labels.tinstar_session &&
      v.labels.cc_conversation_id === labels.cc_conversation_id &&
      v.metricName?.endsWith('_count'),
  )
}

describe('turn-length: observeFromRecapEntries', () => {
  beforeEach(() => _resetForTests())

  it('emits last_assistant_ts - user_ts when next user line arrives', async () => {
    const s = fakeSession('alpha', 'conv-1')
    observeFromRecapEntries('alpha', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      entry('agent', '2026-05-17T12:00:05.000Z'),
      entry('agent', '2026-05-17T12:00:12.000Z'),
      entry('user',  '2026-05-17T12:01:00.000Z'),
    ], s)

    const counts = await bucketCounts({ tinstar_session: 'alpha', cc_conversation_id: 'conv-1' })
    expect(counts.find(c => c.metricName === 'tinstar_turn_length_seconds_count')?.value).toBe(1)
    const sum = (await turnLengthHist.get()).values.find(
      v => v.metricName === 'tinstar_turn_length_seconds_sum'
        && v.labels.tinstar_session === 'alpha',
    )?.value
    expect(sum).toBe(12)
  })
})

describe('turn-length: edge cases', () => {
  beforeEach(() => _resetForTests())

  it('does not emit when user line has no following agent line', async () => {
    const s = fakeSession('beta')
    observeFromRecapEntries('beta', [
      entry('user', '2026-05-17T12:00:00.000Z'),
      entry('user', '2026-05-17T12:01:00.000Z'),
    ], s)
    const counts = await bucketCounts({ tinstar_session: 'beta', cc_conversation_id: 'conv-1' })
    expect(counts.find(c => c.metricName === 'tinstar_turn_length_seconds_count')?.value ?? 0).toBe(0)
  })

  it('drops negative-duration turns and logs', async () => {
    const s = fakeSession('gamma')
    observeFromRecapEntries('gamma', [
      entry('user',  '2026-05-17T12:00:10.000Z'),
      entry('agent', '2026-05-17T12:00:05.000Z'),  // before user — corrupt
      entry('user',  '2026-05-17T12:00:20.000Z'),
    ], s)
    const counts = await bucketCounts({ tinstar_session: 'gamma', cc_conversation_id: 'conv-1' })
    expect(counts.find(c => c.metricName === 'tinstar_turn_length_seconds_count')?.value ?? 0).toBe(0)
  })

  it('drops absurdly large duration (>24h)', async () => {
    const s = fakeSession('delta')
    observeFromRecapEntries('delta', [
      entry('user',  '2026-05-17T00:00:00.000Z'),
      entry('agent', '2026-05-18T01:00:00.000Z'), // 25h
      entry('user',  '2026-05-18T02:00:00.000Z'),
    ], s)
    const counts = await bucketCounts({ tinstar_session: 'delta', cc_conversation_id: 'conv-1' })
    expect(counts.find(c => c.metricName === 'tinstar_turn_length_seconds_count')?.value ?? 0).toBe(0)
  })

  it('uses "unknown" when conversation.id is null', async () => {
    const s = fakeSession('eps', null)
    observeFromRecapEntries('eps', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      entry('agent', '2026-05-17T12:00:04.000Z'),
      entry('user',  '2026-05-17T12:01:00.000Z'),
    ], s)
    const counts = await bucketCounts({ tinstar_session: 'eps', cc_conversation_id: 'unknown' })
    expect(counts.find(c => c.metricName === 'tinstar_turn_length_seconds_count')?.value).toBe(1)
  })

  it('ignores status-type entries', async () => {
    const s = fakeSession('zeta')
    observeFromRecapEntries('zeta', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      { id: 'st', type: 'status', content: 'whatever', timestamp: '2026-05-17T12:00:01.000Z' },
      entry('agent', '2026-05-17T12:00:05.000Z'),
      entry('user',  '2026-05-17T12:01:00.000Z'),
    ], s)
    const sum = (await turnLengthHist.get()).values.find(
      v => v.metricName === 'tinstar_turn_length_seconds_sum' && v.labels.tinstar_session === 'zeta',
    )?.value
    expect(sum).toBe(5)
  })
})

describe('turn-length: flushOnStateChange', () => {
  beforeEach(() => _resetForTests())

  it('flushes pending turn when session transitions to stopped', async () => {
    const s = fakeSession('eta')
    observeFromRecapEntries('eta', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      entry('agent', '2026-05-17T12:00:07.000Z'),
    ], s)
    // No following user line yet — without flush the turn would be lost
    flushOnStateChange('eta', 'stopped')

    const sum = (await turnLengthHist.get()).values.find(
      v => v.metricName === 'tinstar_turn_length_seconds_sum' && v.labels.tinstar_session === 'eta',
    )?.value
    expect(sum).toBe(7)
  })

  it('does not flush on non-stopped transitions', async () => {
    const s = fakeSession('theta')
    observeFromRecapEntries('theta', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      entry('agent', '2026-05-17T12:00:07.000Z'),
    ], s)
    flushOnStateChange('theta', 'idle')
    flushOnStateChange('theta', 'running')
    flushOnStateChange('theta', 'needs_attention')

    const sum = (await turnLengthHist.get()).values.find(
      v => v.metricName === 'tinstar_turn_length_seconds_sum' && v.labels.tinstar_session === 'theta',
    )?.value ?? 0
    expect(sum).toBe(0)
  })

  it('is idempotent — flushing twice does not double-count', async () => {
    const s = fakeSession('iota')
    observeFromRecapEntries('iota', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      entry('agent', '2026-05-17T12:00:07.000Z'),
    ], s)
    flushOnStateChange('iota', 'stopped')
    flushOnStateChange('iota', 'stopped')

    const count = (await turnLengthHist.get()).values.find(
      v => v.metricName === 'tinstar_turn_length_seconds_count' && v.labels.tinstar_session === 'iota',
    )?.value
    expect(count).toBe(1)
  })
})

describe('turn-length: reconcileLiveSessions', () => {
  beforeEach(() => _resetForTests())

  it('flushes pending turns for sessions that have disappeared', async () => {
    const s = fakeSession('kappa')
    observeFromRecapEntries('kappa', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      entry('agent', '2026-05-17T12:00:09.000Z'),
    ], s)

    reconcileLiveSessions(new Set(['other-session']))  // kappa missing

    const sum = (await turnLengthHist.get()).values.find(
      v => v.metricName === 'tinstar_turn_length_seconds_sum' && v.labels.tinstar_session === 'kappa',
    )?.value
    expect(sum).toBe(9)
  })

  it('preserves pending state for sessions that are still alive', async () => {
    const s = fakeSession('lambda')
    observeFromRecapEntries('lambda', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      entry('agent', '2026-05-17T12:00:09.000Z'),
    ], s)

    reconcileLiveSessions(new Set(['lambda', 'other']))

    // Pending should still be there; verify by sending the next user line
    observeFromRecapEntries('lambda', [entry('user', '2026-05-17T12:01:00.000Z')], s)

    const count = (await turnLengthHist.get()).values.find(
      v => v.metricName === 'tinstar_turn_length_seconds_count' && v.labels.tinstar_session === 'lambda',
    )?.value
    expect(count).toBe(1)
  })

  it('handles repeated reconcile calls (idempotent for already-flushed names)', async () => {
    const s = fakeSession('mu')
    observeFromRecapEntries('mu', [
      entry('user',  '2026-05-17T12:00:00.000Z'),
      entry('agent', '2026-05-17T12:00:09.000Z'),
    ], s)

    reconcileLiveSessions(new Set())
    reconcileLiveSessions(new Set())

    const count = (await turnLengthHist.get()).values.find(
      v => v.metricName === 'tinstar_turn_length_seconds_count' && v.labels.tinstar_session === 'mu',
    )?.value
    expect(count).toBe(1)
  })
})

import { getRecentObservations } from '../turn-length'

describe('turn-length: ring buffer', () => {
  beforeEach(() => _resetForTests())

  it('records observation when flush emits a turn', async () => {
    const s = fakeSession('rb-1', 'conv-rb1')
    observeFromRecapEntries('rb-1', [
      entry('user',  '2026-05-18T12:00:00.000Z'),
      entry('agent', '2026-05-18T12:00:05.000Z'),
      entry('user',  '2026-05-18T12:01:00.000Z'),
    ], s)
    const obs = getRecentObservations({ windowSec: 3600 })
    expect(obs).toHaveLength(1)
    expect(obs[0]!.sec).toBe(5)
    expect(obs[0]!.session).toBe('rb-1')
    expect(obs[0]!.ccConvId).toBe('conv-rb1')
  })

  it('filters by session', async () => {
    observeFromRecapEntries('a', [
      entry('user',  '2026-05-18T12:00:00.000Z'),
      entry('agent', '2026-05-18T12:00:03.000Z'),
      entry('user',  '2026-05-18T12:01:00.000Z'),
    ], fakeSession('a'))
    observeFromRecapEntries('b', [
      entry('user',  '2026-05-18T12:00:00.000Z'),
      entry('agent', '2026-05-18T12:00:04.000Z'),
      entry('user',  '2026-05-18T12:01:00.000Z'),
    ], fakeSession('b'))

    expect(getRecentObservations({ windowSec: 3600, session: 'a' })).toHaveLength(1)
    expect(getRecentObservations({ windowSec: 3600, session: 'b' })).toHaveLength(1)
    expect(getRecentObservations({ windowSec: 3600 })).toHaveLength(2)
  })

  it('clamps windowSec to [60, 3600] without throwing', async () => {
    expect(getRecentObservations({ windowSec: 0 })).toEqual([])
    expect(getRecentObservations({ windowSec: 999999 })).toEqual([])
  })

  it('prunes entries older than RETENTION_SEC', async () => {
    const realNow = Date.now
    try {
      // First entry at "now"
      Date.now = () => 1_000_000_000_000  // arbitrary epoch
      observeFromRecapEntries('old', [
        entry('user',  '2026-05-18T12:00:00.000Z'),
        entry('agent', '2026-05-18T12:00:02.000Z'),
        entry('user',  '2026-05-18T12:00:03.000Z'),
      ], fakeSession('old'))

      // Advance Date.now past RETENTION_SEC, then record another
      Date.now = () => 1_000_000_000_000 + 4_000_000   // +4000s, past 3600
      observeFromRecapEntries('new', [
        entry('user',  '2026-05-18T13:00:00.000Z'),
        entry('agent', '2026-05-18T13:00:02.000Z'),
        entry('user',  '2026-05-18T13:00:03.000Z'),
      ], fakeSession('new'))

      const obs = getRecentObservations({ windowSec: 3600 })
      expect(obs.map(o => o.session)).toEqual(['new'])
    } finally {
      Date.now = realNow
    }
  })
})
