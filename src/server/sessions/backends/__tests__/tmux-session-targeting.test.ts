import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:util', async (orig) => {
  const actual = await orig<typeof import('node:util')>()
  return { ...actual, promisify: () => execFileMock }
})

import {
  deleteTmuxSession,
  getTmuxAgentIdentity,
  getTmuxSessionState,
  healthCheck,
  startTmuxSession,
  stopTmuxSession,
  tmuxHasSession,
} from '../tmux'
import { log } from '../../../logger'
import type { TinstarConfig } from '../../config'
import type { Session } from '../../session'

const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig
const parent = { name: 'parent' } as Session

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
})

describe('session-scoped tmux targets', () => {
  it('keeps a surviving agent identity stable and rotates it on relaunch', async () => {
    let launchToken = 'launch-one'
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'pgrep') return { stdout: '5252\n', stderr: '' }
      if (args[0] === 'show-environment') {
        return {
          stdout: `TINSTAR_AGENT_INCARNATION=${launchToken}\n`,
          stderr: '',
        }
      }
      return { stdout: '4242\n', stderr: '' }
    })

    const first = await getTmuxAgentIdentity(config, 'parent')
    const sameProcess = await getTmuxAgentIdentity(config, 'parent')
    launchToken = 'launch-two'
    const replacement = await getTmuxAgentIdentity(config, 'parent')

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(sameProcess).toBe(first)
    expect(replacement).not.toBe(first)
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      [
        'display-message',
        '-p',
        '-t',
        '=tinstar-parent:',
        '#{pane_pid}',
      ],
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
    expect(execFileMock).toHaveBeenCalledWith(
      'pgrep',
      ['-P', '4242'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })

  it('rotates identity when the agent process is replaced without a managed relaunch', async () => {
    let agentPid = '5252'
    let processBirth = 'Fri Aug  1 10:00:00 2026'
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'pgrep') return { stdout: `${agentPid}\n`, stderr: '' }
      if (file === 'ps') return { stdout: `${processBirth}\n`, stderr: '' }
      if (args[0] === 'show-environment') {
        return {
          stdout: 'TINSTAR_AGENT_INCARNATION=unchanged-launch\n',
          stderr: '',
        }
      }
      return { stdout: '4242\n', stderr: '' }
    })

    const first = await getTmuxAgentIdentity(config, 'parent')
    agentPid = '6262'
    processBirth = 'Fri Aug  1 10:05:00 2026'
    const replacement = await getTmuxAgentIdentity(config, 'parent')

    expect(replacement).not.toBe(first)
  })

  it('does not report a live recipient when the pane shell has no agent child', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '4242\n', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('no child'), {
        code: 1,
        stdout: '',
        stderr: '',
      }))

    await expect(getTmuxAgentIdentity(config, 'parent')).resolves.toBeNull()
  })

  it('propagates transient launch-token inspection failures', async () => {
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'pgrep') return { stdout: '5252\n', stderr: '' }
      if (args[0] === 'show-environment') {
        throw Object.assign(new Error('tmux timed out'), {
          killed: true,
          signal: 'SIGTERM',
          stderr: '',
        })
      }
      return { stdout: '4242\n', stderr: '' }
    })

    await expect(getTmuxAgentIdentity(config, 'parent'))
      .rejects.toThrow('tmux timed out')
  })

  it('uses process birth for legacy sessions whose launch token is absent', async () => {
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'pgrep') return { stdout: '5252\n', stderr: '' }
      if (file === 'ps') {
        return { stdout: 'Fri Aug  1 10:00:00 2026\n', stderr: '' }
      }
      if (args[0] === 'show-environment') {
        throw Object.assign(new Error('unknown variable'), {
          code: 1,
          stderr: 'unknown variable: TINSTAR_AGENT_INCARNATION\n',
        })
      }
      return { stdout: '4242\n', stderr: '' }
    })

    await expect(getTmuxAgentIdentity(config, 'parent'))
      .resolves.toMatch(/^[a-f0-9]{64}$/)
  })

  it('leaves a live tmux agent unchanged on a redundant start', async () => {
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'pgrep') return { stdout: '5252\n', stderr: '' }
      if (file === 'ps') {
        return { stdout: 'Fri Aug  1 10:00:00 2026\n', stderr: '' }
      }
      if (args[0] === 'show-environment') {
        return {
          stdout: 'TINSTAR_AGENT_INCARNATION=launch-one\n',
          stderr: '',
        }
      }
      return { stdout: '4242\n', stderr: '' }
    })

    await expect(startTmuxSession(config, {
      session: {
        ...parent,
        adapter: 'claude',
        state: 'running',
        ttydPid: 7373,
      },
      secrets: {},
      port: 6123,
      provider: {} as never,
    })).resolves.toEqual({ port: 6123, ttydPid: 7373 })
    expect(execFileMock).not.toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['set-environment']),
      expect.anything(),
    )
  })

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

  it('warns once when strict-probe output does not match a known absence', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    execFileMock.mockRejectedValue(Object.assign(new Error('wording drift'), {
      code: 1,
      stderr: 'session lookup failed in an unfamiliar way',
    }))

    await expect(getTmuxSessionState(config, 'drift')).rejects.toThrow('wording drift')
    await expect(getTmuxSessionState(config, 'drift')).rejects.toThrow('wording drift')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'tmux',
      expect.stringContaining('session lookup failed in an unfamiliar way'),
    )
    warn.mockRestore()
  })

  it('bounds a fetch that accepts the connection but never responds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    )
    const started = Date.now()

    await expect(healthCheck(6123, {
      timeout: 25,
      interval: 1,
    })).resolves.toBe(false)

    expect(Date.now() - started).toBeLessThan(500)
    fetchMock.mockRestore()
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

  it.each([
    ['stop', stopTmuxSession],
    ['delete', deleteTmuxSession],
  ] as const)('surfaces non-missing %s failures for strict verification', async (_label, action) => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('permission denied'), {
      code: 1,
      stderr: 'error connecting to tmux (Permission denied)',
    }))

    await expect(action(config, parent)).rejects.toThrow('permission denied')
  })
})
