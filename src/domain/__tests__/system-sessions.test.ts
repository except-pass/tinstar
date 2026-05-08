import { describe, it, expect } from 'vitest'
import { extractMarshal } from '../system-sessions'
import type { Run } from '../types'

const baseRun = (overrides: Partial<Run>): Run => ({
  id: overrides.id ?? 'r1',
  sessionId: overrides.sessionId ?? 'run-1',
  taskId: 'task-1',
  worktreeId: 'wt-1',
  createdAt: '2026-05-08T00:00:00Z',
  status: 'running',
  initiative: '',
  epic: '',
  task: '',
  repo: '',
  worktree: '',
  touchedFiles: [],
  recapEntries: [],
  rawLogs: '',
  port: null,
  backend: null,
  ...overrides,
})

describe('extractMarshal', () => {
  it('returns marshal=null and the same runs when no marshal is present', () => {
    const runs = [baseRun({ id: 'a', sessionId: 'run-a' }), baseRun({ id: 'b', sessionId: 'run-b' })]
    const result = extractMarshal(runs)
    expect(result.marshal).toBeNull()
    expect(result.rest).toHaveLength(2)
    expect(result.rest.map(r => r.sessionId)).toEqual(['run-a', 'run-b'])
  })

  it('separates marshal from the rest', () => {
    const runs = [
      baseRun({ id: 'a', sessionId: 'run-a' }),
      baseRun({ id: 'm', sessionId: 'marshal' }),
      baseRun({ id: 'b', sessionId: 'run-b' }),
    ]
    const result = extractMarshal(runs)
    expect(result.marshal?.sessionId).toBe('marshal')
    expect(result.rest.map(r => r.sessionId)).toEqual(['run-a', 'run-b'])
  })
})
