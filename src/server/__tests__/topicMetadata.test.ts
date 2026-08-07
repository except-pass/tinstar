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
  it('returns "Worktree: <name>" for a broadcast subject ending in a registered worktree', () => {
    const ds = new DocumentStore()
    ds.upsertSpace('s1', { id: 's1', name: 'Work Space', createdAt: '' })
    ds.activeSpaceId = 's1'
    ds.upsertWorktree('w1', { id: 'w1', name: 'feature-one', branch: 'feature-one', repo: 'Project One', worktreePath: '/tmp/feature-one', spaceId: 's1' })
    expect(deriveHierarchicalName('tinstar.work-space.project-one.feature-one', ds, 'broadcast'))
      .toBe('Worktree: feature-one')
  })

  it('uses the git branch when the worktree display name differs', () => {
    const ds = new DocumentStore()
    ds.upsertWorktree('w1', { id: 'w1', name: 'Friendly session', branch: 'feature/scope', repo: 'Project One', worktreePath: '/tmp/feature-scope' })
    expect(deriveHierarchicalName('tinstar.work-space.project-one.feature-scope', ds, 'broadcast'))
      .toBe('Worktree: feature/scope')
  })

  it('returns "DM → <session>" for a DM subject', () => {
    const ds = new DocumentStore()
    expect(deriveHierarchicalName('tinstar.work-space.project-one.feature-one.natsviz', ds, 'dm'))
      .toBe('DM → natsviz')
  })

  it('returns null for an unrecognized shape', () => {
    const ds = new DocumentStore()
    expect(deriveHierarchicalName('tinstar.weird', ds, 'broadcast')).toBe(null)
  })

  it('returns null for wildcard subjects', () => {
    const ds = new DocumentStore()
    expect(deriveHierarchicalName('tinstar.work-space.project-one.>', ds, 'broadcast')).toBe(null)
    expect(deriveHierarchicalName('tinstar.work-space.>', ds, 'broadcast')).toBe(null)
  })
})
