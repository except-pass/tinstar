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
