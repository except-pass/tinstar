import { describe, it, expect } from 'vitest'
import { resolveEntitySettings } from '../entity-settings'
import type { DocumentStore } from '../../stores/document-store'

/**
 * Minimal fake DocumentStore for settings resolution. Mirrors the real
 * "Crossfade" shape: an initiative carries the settings, the epic inherits
 * them, and a task sits under the epic WITHOUT a direct initiativeId.
 */
function fakeStore(overrides?: {
  taskInitiativeId?: string
}): DocumentStore {
  const initiatives: Record<string, any> = {
    'init-1': {
      id: 'init-1',
      name: 'OtherProjects',
      settings: { project: 'Cross Fade', cliTemplate: 'Claude (multi-agent)' },
    },
  }
  const epics: Record<string, any> = {
    'epic-1': { id: 'epic-1', name: 'Crossfade', initiativeId: 'init-1' /* no settings */ },
  }
  const tasks: Record<string, any> = {
    'task-1': {
      id: 'task-1',
      name: 'crossfade',
      epicId: 'epic-1',
      initiativeId: overrides?.taskInitiativeId ?? '',
    },
  }
  return {
    getInitiative: (id: string) => initiatives[id] ?? null,
    getEpic: (id: string) => epics[id] ?? null,
    getTask: (id: string) => tasks[id] ?? null,
  } as unknown as DocumentStore
}

describe('resolveEntitySettings', () => {
  it('task under an epic inherits the epic\'s initiative settings even without a direct initiativeId', () => {
    const result = resolveEntitySettings('task-1', 'task', fakeStore())
    expect(result?.resolved).toEqual({
      project: 'Cross Fade',
      cliTemplate: 'Claude (multi-agent)',
    })
    expect(result?.sources.project).toEqual({ type: 'initiative', name: 'OtherProjects' })
  })

  it('still resolves when the task carries its own initiativeId', () => {
    const result = resolveEntitySettings('task-1', 'task', fakeStore({ taskInitiativeId: 'init-1' }))
    expect(result?.resolved.project).toBe('Cross Fade')
  })

  it('epic inherits its initiative settings', () => {
    const result = resolveEntitySettings('epic-1', 'epic', fakeStore())
    expect(result?.resolved.project).toBe('Cross Fade')
  })
})
