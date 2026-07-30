import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:util', async (orig) => {
  const actual = await orig<typeof import('node:util')>()
  return { ...actual, promisify: () => execFileMock }
})

import { deleteTmuxSession, stopTmuxSession, tmuxHasSession } from '../tmux'
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
