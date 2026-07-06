// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { topicParticipants, joinParticipants, deriveHierarchicalName } from '../topic-metadata'
import type { Session } from '../sessions/session'
import { DocumentStore } from '../stores/document-store'

const sess = (name: string, subs: string[] | null): Session => ({
  name, backend: 'tmux', state: 'running', project: null,
  workspace: { path: null, worktree: false, branch: null, basePath: null },
  conversation: { id: null }, profile: null, oneshot: false,
  skipPermissions: false, background: false, blocked: false, cliTemplate: null, adapter: null,
  nats: subs ? { enabled: true, subscriptions: subs } : null,
  port: null, ttydPid: null, natsControlOrphanedAt: null, appendSystemPrompt: null, agent: null,
  modelOverride: null,
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

describe('deriveHierarchicalName', () => {
  it('returns "Task: <name>" for a broadcast subject ending in a real task', () => {
    const ds = new DocumentStore()
    ds.upsertSpace('s1', { id: 's1', name: 'Work Space', createdAt: '' })
    ds.activeSpaceId = 's1'
    ds.upsertInitiative('i1', { id: 'i1', name: 'Init', color: '#000', status: 'active', summary: '', spaceId: 's1' })
    ds.upsertEpic('e1', { id: 'e1', name: 'Epic', initiativeId: 'i1', status: 'active', summary: '', spaceId: 's1' })
    ds.upsertTask('t1', { id: 't1', name: 'Tinstar Improvement', epicId: 'e1', initiativeId: 'i1', status: 'active', spaceId: 's1' })
    expect(deriveHierarchicalName('tinstar.work-space.init.epic.tinstar-improvement', ds, 'broadcast'))
      .toBe('Task: Tinstar Improvement')
  })

  it('returns "DM → <session>" for a DM subject', () => {
    const ds = new DocumentStore()
    expect(deriveHierarchicalName('tinstar.work-space.init.epic.task.natsviz', ds, 'dm'))
      .toBe('DM → natsviz')
  })

  it('returns null for an unrecognized shape', () => {
    const ds = new DocumentStore()
    expect(deriveHierarchicalName('tinstar.weird', ds, 'broadcast')).toBe(null)
  })

  it('returns null for wildcard subjects', () => {
    const ds = new DocumentStore()
    expect(deriveHierarchicalName('tinstar.work-space.init.>', ds, 'broadcast')).toBe(null)
    expect(deriveHierarchicalName('tinstar.work-space.>', ds, 'broadcast')).toBe(null)
  })
})
