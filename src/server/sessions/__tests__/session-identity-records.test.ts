import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSession,
  listSessionIdentityRecords,
  updateSession,
} from '../session'

describe('listSessionIdentityRecords', () => {
  let sessionsDir: string | null = null

  afterEach(() => {
    if (sessionsDir) rmSync(sessionsDir, { recursive: true, force: true })
    sessionsDir = null
  })

  it('reads current provider identity without workspace or branch discovery', () => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'tinstar-session-identities-'))
    createSession(sessionsDir, {
      name: 'worker',
      backend: 'tmux',
      adapter: 'claude',
      workspace: {
        path: '/workspace/that/does/not/exist',
        worktree: true,
      },
    })

    updateSession(sessionsDir, 'worker', {
      adapter: 'codex',
      conversation: { id: 'thread-after-restart' },
    })

    expect(listSessionIdentityRecords(sessionsDir)).toEqual([{
      name: 'worker',
      adapter: 'codex',
      cliTemplate: null,
      conversation: { id: 'thread-after-restart' },
    }])
  })
})
