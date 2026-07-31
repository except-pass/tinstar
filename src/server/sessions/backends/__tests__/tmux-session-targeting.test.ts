import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:util', async (orig) => {
  const actual = await orig<typeof import('node:util')>()
  return { ...actual, promisify: () => execFileMock }
})

import {
  deleteTmuxSession,
  getTmuxSessionState,
  stopTmuxSession,
  tmuxHasSession,
} from '../tmux'
import type { TinstarConfig } from '../../config'
import type { Session } from '../../session'

const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig
const parent = { name: 'parent' } as Session

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
})

describe('session-scoped tmux targets', () => {
  it('checks liveness by exact name so a live parent-hand does not make a missing parent look alive', async () => {
    await tmuxHasSession('tinstar-parent')

    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['has-session', '-t', '=tinstar-parent'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })

  it('treats a normal has-session exit 1 as a confirmed missing backend', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('missing'), {
      code: 1,
      stderr: 'can\'t find session: tinstar-parent',
    }))

    await expect(getTmuxSessionState(config, 'parent')).resolves.toBe('missing')
  })

  it('keeps a missing tmux socket inconclusive because the unlinked server may still be live', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('missing socket'), {
      code: 1,
      stderr: 'error connecting to /tmp/tmux-1000/tinstar-parent (No such file or directory)',
    }))

    await expect(getTmuxSessionState(config, 'parent')).rejects.toThrow(
      'missing socket',
    )
  })

  it('does not mistake a permission-denied exit 1 for a missing backend', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('permission denied'), {
      code: 1,
      stderr: 'error connecting to /tmp/tmux-1000/default (Permission denied)',
    }))

    await expect(getTmuxSessionState(config, 'parent')).rejects.toThrow(
      'permission denied',
    )
  })

  it('does not mistake a tmux spawn failure for a missing backend', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('tmux missing'), {
      code: 'ENOENT',
    }))

    await expect(getTmuxSessionState(config, 'parent')).rejects.toThrow('tmux missing')
  })

  it('does not mistake a killed tmux probe for a missing backend', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('timed out'), {
      code: 1,
      killed: true,
      signal: 'SIGTERM',
    }))

    await expect(getTmuxSessionState(config, 'parent')).rejects.toThrow('timed out')
  })

  it('stops only the exact session so a stale parent target cannot kill its prefixed hand', async () => {
    await stopTmuxSession(config, parent)

    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', '=tinstar-parent'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })

  it('deletes only the exact session so a stale parent target cannot kill its prefixed hand', async () => {
    await deleteTmuxSession(config, parent)

    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', '=tinstar-parent'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })
})
