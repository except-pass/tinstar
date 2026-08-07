import { describe, it, expect } from 'vitest'
import { computeNatsSubscriptions } from '../nats-subscriptions'
import type { DocumentStore } from '../../stores/document-store'

/**
 * Minimal fake DocumentStore covering only the lookups computeNatsSubscriptions
 * uses: getSpace. Project and Worktree names are supplied by scope.
 */
function fakeStore(): DocumentStore {
  const spaces: Record<string, { id: string; name: string }> = {
    'space-1': { id: 'space-1', name: 'My Space' },
  }
  return {
    getSpace: (id: string) => spaces[id] ?? null,
  } as unknown as DocumentStore
}

describe('computeNatsSubscriptions', () => {
  const store = fakeStore()

  it('gives a Worktree-scoped agent both broadcast and DM subjects', () => {
    const subs = computeNatsSubscriptions(
      { sessionName: 'agent-1', spaceId: 'space-1', project: 'Project One', worktree: 'feature/one' },
      store,
    )
    expect(subs).toEqual([
      'tinstar.my-space.project-one.feature-one',
      'tinstar.my-space.project-one.feature-one.agent-1',
    ])
    expect(subs.some(s => s.includes('>'))).toBe(false)
  })

  it('gives an Unscoped agent a DM-only inbox, never a wildcard', () => {
    const subs = computeNatsSubscriptions(
      { sessionName: 'lone-wolf', spaceId: 'space-1' },
      store,
    )
    // Exactly its own direct subject, '_' for the unresolved levels.
    expect(subs).toEqual(['tinstar.my-space._._.lone-wolf'])
    // The leak this guards against: no `tinstar.my-space.>` catch-all.
    expect(subs.some(s => s.includes('>'))).toBe(false)
  })

  it('gives a Project-only agent a DM-only inbox', () => {
    const subs = computeNatsSubscriptions(
      { sessionName: 'project-watcher', spaceId: 'space-1', project: 'Project One' },
      store,
    )
    expect(subs).toEqual(['tinstar.my-space.project-one._.project-watcher'])
    expect(subs.some(s => s.includes('>'))).toBe(false)
  })

  it('does not broadcast when Worktree is supplied without Project', () => {
    const subs = computeNatsSubscriptions(
      { sessionName: 'invalid-watcher', spaceId: 'space-1', worktree: 'feature-one' },
      store,
    )
    expect(subs).toEqual(['tinstar.my-space._.feature-one.invalid-watcher'])
    expect(subs.some(s => s.includes('>'))).toBe(false)
  })
})
