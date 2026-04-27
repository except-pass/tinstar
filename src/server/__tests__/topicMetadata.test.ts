// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { topicParticipants, joinParticipants } from '../topic-metadata'
import type { Session } from '../sessions/session'

const sess = (name: string, subs: string[] | null): Session => ({
  name, backend: 'tmux', state: 'running', project: null,
  workspace: { path: null, worktree: false, branch: null, basePath: null },
  conversation: { id: null }, profile: null, oneshot: false,
  skipPermissions: false, cliTemplate: null, adapter: null,
  nats: subs ? { enabled: true, subscriptions: subs } : null,
  port: null, ttydPid: null, natsControlOrphanedAt: null,
  created: '2026-04-27T00:00:00Z', lastActive: '2026-04-27T00:00:00Z',
})

describe('topicParticipants', () => {
  it('returns session names that subscribe to the subject', () => {
    const sessions = [
      sess('alpha', ['tinstar.x', 'tinstar.y']),
      sess('beta',  ['tinstar.x']),
      sess('gamma', ['tinstar.z']),
      sess('delta', null),
    ]
    expect(topicParticipants('tinstar.x', sessions).sort()).toEqual(['alpha', 'beta'])
    expect(topicParticipants('tinstar.y', sessions)).toEqual(['alpha'])
    expect(topicParticipants('tinstar.unknown', sessions)).toEqual([])
  })
})

describe('joinParticipants', () => {
  it('attaches a participants array to the metadata record', () => {
    const md = { subject: 's', kind: 'broadcast' as const, createdAt: '' }
    const sessions = [sess('a', ['s']), sess('b', ['s'])]
    expect(joinParticipants(md, sessions)).toMatchObject({
      subject: 's', participants: ['a', 'b'],
    })
  })
})
