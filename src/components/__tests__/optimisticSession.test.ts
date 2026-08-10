import { describe, expect, it } from 'vitest'
import {
  buildOptimisticSessionRun,
  markOptimisticSessionFailed,
  mergeOptimisticSessionRuns,
  reconcileOptimisticSessionFailure,
} from '../optimisticSession'
import { applyDelta } from '../../hooks/useServerEvents'
import { OBJECTIVE_POINT_ID } from '../../domain/types'

const baseState = () => ({
  activeSpaceId: 'space-1', spaces: [], initiatives: [], epics: [], tasks: [], worktrees: [],
  runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [],
  topicMetadata: [], readyQueue: [], pluginWidgets: [], constellationGraphs: [], pinSets: [],
  surfaceHealth: { health: 'healthy' as const },
}) as Parameters<typeof applyDelta>[0]

describe('optimistic session projection', () => {
  it('creates a run-workspace-compatible creating run immediately', () => {
    const run = buildOptimisticSessionRun({
      id: 'fresh-run',
      prompt: 'start here',
      project: 'tinstar',
      worktree: 'fresh-run',
      worktreeMode: 'new',
      color: '#00ff88',
    }, 'space-1', '2026-08-07T12:00:00.000Z')

    expect(run).toMatchObject({
      id: 'fresh-run',
      sessionId: 'fresh-run',
      status: 'creating',
      backend: null,
      port: null,
      repo: 'tinstar',
      worktree: 'fresh-run',
      scope: { project: 'tinstar', worktree: 'fresh-run' },
      taskId: '',
      spaceId: 'space-1',
      createdAt: '2026-08-07T12:00:00.000Z',
      slate: [{
        id: OBJECTIVE_POINT_ID,
        kind: 'objective',
        author: 'user',
        headline: 'start here',
      }],
    })
  })

  it('keeps the run visible and records the launch error', () => {
    const creating = buildOptimisticSessionRun({ id: 'fresh-run', prompt: 'start here' })

    const failed = markOptimisticSessionFailed(creating, 'ttyd did not bind', '2026-08-07T12:01:00.000Z')

    expect(failed.status).toBe('needs_attention')
    expect(failed.blocked).toBe(true)
    expect(failed.recapEntries.at(-1)).toMatchObject({
      type: 'status',
      content: 'Session creation failed: ttyd did not bind',
      timestamp: '2026-08-07T12:01:00.000Z',
    })
    expect(failed.rawLogs).toContain('Session creation failed: ttyd did not bind')
  })

  it('does not overwrite a real run when only the HTTP response was lost', () => {
    const live = {
      ...buildOptimisticSessionRun({ id: 'fresh-run' }),
      status: 'idle' as const,
      backend: 'tmux' as const,
      port: 8681,
    }

    expect(reconcileOptimisticSessionFailure(
      live,
      { id: 'fresh-run', prompt: 'start here' },
      'network connection closed',
    )).toBeNull()
  })

  it('reconciles the server run onto the same optimistic canvas identity', () => {
    const optimistic = buildOptimisticSessionRun({ id: 'fresh-run', prompt: 'start here' })
    const state = { ...baseState(), runs: [optimistic] }
    const serverRun = {
      ...optimistic,
      status: 'running' as const,
      backend: 'tmux' as const,
      port: 8681,
      backendInfo: 'tmux session: fresh-run',
    }

    const reconciled = applyDelta(state, { entity: 'run', id: 'fresh-run', data: serverRun })

    expect(reconciled.runs).toHaveLength(1)
    expect(reconciled.runs[0]).toMatchObject({
      id: 'fresh-run',
      status: 'running',
      backend: 'tmux',
      port: 8681,
    })
  })

  it('survives a reconnect snapshot until a backend-backed run arrives', () => {
    const optimistic = buildOptimisticSessionRun({ id: 'fresh-run', prompt: 'start here' })

    expect(mergeOptimisticSessionRuns([], [optimistic])).toEqual([optimistic])

    const live = {
      ...optimistic,
      status: 'running' as const,
      backend: 'tmux' as const,
      port: 8681,
    }
    expect(mergeOptimisticSessionRuns([live], [optimistic])).toEqual([live])
  })

  it('keeps the optimistic Objective through an early backend delta', () => {
    const optimistic = buildOptimisticSessionRun({ id: 'fresh-run', prompt: 'start here' })
    const backendRun = {
      ...optimistic,
      slate: undefined,
      status: 'running' as const,
      backend: 'tmux' as const,
      port: 8681,
    }

    const [merged] = mergeOptimisticSessionRuns([backendRun], [optimistic])
    expect(merged).toMatchObject({
      backend: 'tmux',
      slate: [{ id: OBJECTIVE_POINT_ID, headline: 'start here' }],
    })
  })

  it('replaces the optimistic Objective only after the canonical one arrives', () => {
    const optimistic = buildOptimisticSessionRun({ id: 'fresh-run', prompt: 'start here' })
    const canonicalObjective = {
      ...optimistic.slate![0]!,
      rev: 2,
      headline: 'start here',
      amendedAt: Date.now() + 1,
    }
    const backendRun = {
      ...optimistic,
      slate: [canonicalObjective],
      status: 'running' as const,
      backend: 'tmux' as const,
      port: 8681,
    }

    expect(mergeOptimisticSessionRuns([backendRun], [optimistic])).toEqual([backendRun])
  })
})
