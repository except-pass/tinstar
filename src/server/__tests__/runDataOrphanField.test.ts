// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { RunData } from '../../types'

describe('RunData.natsControlOrphanedAt', () => {
  it('is optional and nullable on RunData', () => {
    const run: RunData = {
      id: 'r1', status: 'idle', sessionId: 's1', taskId: 't1',
      initiative: '', epic: '', task: '', repo: '', worktree: '',
      touchedFiles: [], recapEntries: [], rawLogs: '', port: null,
      backend: null,
      natsControlOrphanedAt: '2026-04-24T12:00:00Z',
    }
    expect(run.natsControlOrphanedAt).toBe('2026-04-24T12:00:00Z')
  })

  it('accepts null', () => {
    const run: RunData = {
      id: 'r1', status: 'idle', sessionId: 's1', taskId: 't1',
      initiative: '', epic: '', task: '', repo: '', worktree: '',
      touchedFiles: [], recapEntries: [], rawLogs: '', port: null,
      backend: null,
      natsControlOrphanedAt: null,
    }
    expect(run.natsControlOrphanedAt).toBeNull()
  })
})
