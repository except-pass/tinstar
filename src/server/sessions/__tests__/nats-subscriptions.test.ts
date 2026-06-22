import { describe, it, expect } from 'vitest'
import { computeNatsSubscriptions } from '../nats-subscriptions'
import type { DocumentStore } from '../../stores/document-store'

/**
 * Minimal fake DocumentStore covering only the lookups computeNatsSubscriptions
 * uses: getTask / getEpic / getInitiative / getSpace. Entities carry a name and
 * the parent ids needed to walk up the hierarchy.
 */
function fakeStore(): DocumentStore {
  const spaces: Record<string, { id: string; name: string }> = {
    'space-1': { id: 'space-1', name: 'My Space' },
  }
  const initiatives: Record<string, { id: string; name: string; spaceId: string }> = {
    'init-1': { id: 'init-1', name: 'Init One', spaceId: 'space-1' },
  }
  const epics: Record<string, { id: string; name: string; initiativeId: string; spaceId: string }> = {
    'epic-1': { id: 'epic-1', name: 'Epic One', initiativeId: 'init-1', spaceId: 'space-1' },
  }
  const tasks: Record<string, { id: string; name: string; epicId: string; initiativeId: string; spaceId: string }> = {
    'task-1': { id: 'task-1', name: 'Task One', epicId: 'epic-1', initiativeId: 'init-1', spaceId: 'space-1' },
  }
  return {
    getSpace: (id: string) => spaces[id] ?? null,
    getInitiative: (id: string) => initiatives[id] ?? null,
    getEpic: (id: string) => epics[id] ?? null,
    getTask: (id: string) => tasks[id] ?? null,
  } as unknown as DocumentStore
}

describe('computeNatsSubscriptions', () => {
  const store = fakeStore()

  it('gives a task-seated agent both broadcast and DM subjects', () => {
    const subs = computeNatsSubscriptions(
      { sessionName: 'agent-1', taskId: 'task-1' },
      store,
    )
    expect(subs).toEqual([
      'tinstar.my-space.init-one.epic-one.task-one', // broadcast (index 0)
      'tinstar.my-space.init-one.epic-one.task-one.agent-1', // DM (index 1)
    ])
    expect(subs.some(s => s.includes('>'))).toBe(false)
  })

  it('gives a space-only (task-less) agent a DM-ONLY inbox, never a wildcard', () => {
    const subs = computeNatsSubscriptions(
      { sessionName: 'lone-wolf', spaceId: 'space-1' },
      store,
    )
    // Exactly its own direct subject, '_' for the unresolved levels.
    expect(subs).toEqual(['tinstar.my-space._._._.lone-wolf'])
    // The leak this guards against: no `tinstar.my-space.>` catch-all.
    expect(subs.some(s => s.includes('>'))).toBe(false)
  })

  it('gives an epic-only agent a DM-only inbox (no epic-subtree wildcard)', () => {
    const subs = computeNatsSubscriptions(
      { sessionName: 'epic-watcher', epicId: 'epic-1' },
      store,
    )
    expect(subs).toEqual(['tinstar.my-space.init-one.epic-one._.epic-watcher'])
    expect(subs.some(s => s.includes('>'))).toBe(false)
  })

  it('gives an initiative-only agent a DM-only inbox (no initiative wildcard)', () => {
    const subs = computeNatsSubscriptions(
      { sessionName: 'init-watcher', initiativeId: 'init-1' },
      store,
    )
    expect(subs).toEqual(['tinstar.my-space.init-one._._.init-watcher'])
    expect(subs.some(s => s.includes('>'))).toBe(false)
  })
})
