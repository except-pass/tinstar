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
  /** Epic's initiativeId; defaults to init-1. Set '' to drop the epic's initiative
   *  tier so resolution can only come from the task's own initiativeId. */
  epicInitiativeId?: string
}): DocumentStore {
  const initiatives: Record<string, any> = {
    'init-1': {
      id: 'init-1',
      name: 'OtherProjects',
      settings: { project: 'Cross Fade', cliTemplate: 'Claude (multi-agent)' },
    },
    'init-2': {
      id: 'init-2',
      name: 'SideProjects',
      settings: { project: 'Side Fade', cliTemplate: 'Codex (full auto)' },
    },
  }
  const epics: Record<string, any> = {
    'epic-1': { id: 'epic-1', name: 'Crossfade', initiativeId: overrides?.epicInitiativeId ?? 'init-1' /* no settings */ },
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

  it('prefers the task\'s own initiativeId over the epic\'s when they diverge', () => {
    // Task seated under epic-1 (→ init-1) but carrying its OWN init-2. Closest-wins:
    // the task's direct initiativeId takes precedence over the epic's. Locks in the
    // precedence decision (the `if (!initiativeId)` epic fallback only fills a gap).
    const result = resolveEntitySettings('task-1', 'task', fakeStore({ taskInitiativeId: 'init-2' }))
    expect(result?.resolved.project).toBe('Side Fade')
    expect(result?.sources.project).toEqual({ type: 'initiative', name: 'SideProjects' })
  })

  it('resolves via the task\'s own initiativeId even when the epic has none', () => {
    // Epic carries no initiativeId, so the initiative tier can ONLY come from the
    // task's direct initiativeId — isolates the direct-initiative branch from the
    // epic-fallback branch (which the init-1/init-1 case can't distinguish).
    const result = resolveEntitySettings('task-1', 'task', fakeStore({ taskInitiativeId: 'init-1', epicInitiativeId: '' }))
    expect(result?.resolved.project).toBe('Cross Fade')
  })

  it('epic inherits its initiative settings', () => {
    const result = resolveEntitySettings('epic-1', 'epic', fakeStore())
    expect(result?.resolved.project).toBe('Cross Fade')
  })
})
