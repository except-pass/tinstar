import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:util', async (orig) => {
  const actual = await orig<typeof import('node:util')>()
  return { ...actual, promisify: () => execFileMock }
})

import {
  captureScreen,
  exactTmuxPaneTarget,
  exactTmuxSessionTarget,
  TerminalPromptSubmissionError,
  withSessionInput,
} from '../tmux'
import type { TinstarConfig } from '../../config'

beforeEach(() => { execFileMock.mockReset() })

describe('captureScreen', () => {
  it('treats a leading equals as part of the raw canonical session name', () => {
    expect(exactTmuxSessionTarget('=tmux-abc')).toBe('==tmux-abc')
    expect(exactTmuxPaneTarget('=tmux-abc')).toBe('==tmux-abc:')
  })

  it('captures the visible pane by default', async () => {
    execFileMock.mockResolvedValue({ stdout: 'SCREEN', stderr: '' })
    const out = await captureScreen('tmux-abc')
    // execFileAsync wraps every tmux call with a { timeout } option (see tmux.ts).
    expect(execFileMock).toHaveBeenCalledWith('tmux', ['capture-pane', '-t', '=tmux-abc:', '-p'], expect.objectContaining({ timeout: expect.any(Number) }))
    expect(out).toBe('SCREEN')
  })
  it('includes scrollback when requested', async () => {
    execFileMock.mockResolvedValue({ stdout: 'X', stderr: '' })
    await captureScreen('tmux-abc', 200)
    expect(execFileMock).toHaveBeenCalledWith('tmux', ['capture-pane', '-t', '=tmux-abc:', '-p', '-S', '-200'], expect.objectContaining({ timeout: expect.any(Number) }))
  })

  it('withholds every keystroke when the pane becomes unsafe at the injection boundary', async () => {
    const screens = [
      '› Add a follow-up\n  ? for shortcuts',
      'Would you like to run this command?\nPress enter to confirm',
    ]
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args[0] === 'capture-pane') return { stdout: screens.shift() ?? '', stderr: '' }
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    const submitted = await withSessionInput(config, 'worker', async input => {
      expect(await input.captureScreen()).toContain('? for shortcuts')
      return input.submitPrompt('durable envelope', async () => (
        !(await input.captureScreen()).includes('Press enter to confirm')
      ))
    })

    expect(submitted).toBe(false)
    expect(execFileMock.mock.calls.some(([, args]) => (
      Array.isArray(args) && args.includes('durable envelope')
    ))).toBe(false)
  })

  it('settles and submits checked text through a private tmux buffer', async () => {
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args[0] === 'capture-pane') {
        return { stdout: '› Add a follow-up\n  ? for shortcuts', stderr: '' }
      }
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    const submitted = await withSessionInput(config, 'worker', async input => (
      input.submitPrompt('durable envelope;', async () => (
        (await input.captureScreen()).includes('? for shortcuts')
      ))
    ))

    expect(submitted).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['load-buffer', '-b', expect.stringMatching(/^tinstar-/), expect.any(String)],
      expect.any(Object),
    )
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['paste-buffer', '-d', '-b', expect.stringMatching(/^tinstar-/), '-t', '%1'],
      expect.any(Object),
    )
    expect(execFileMock.mock.calls.some(([, args]) => args.includes('durable envelope;')))
      .toBe(false)
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', '%1', '', 'Enter'],
      expect.any(Object),
    )
  })

  it('withholds literal bytes when copy mode starts after the caller boundary check', async () => {
    let paneInMode = false
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') {
        return { stdout: paneInMode ? '1\n' : '0\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    const submitted = await withSessionInput(config, 'worker', input => (
      input.submitPrompt('must remain unsent', async () => {
        paneInMode = true
        return true
      })
    ))

    expect(submitted).toBe(false)
    expect(execFileMock.mock.calls.some(([, args]) => (
      args[0] === 'load-buffer' || args[0] === 'paste-buffer'
    ))).toBe(false)
  })

  it('returns safely before literal input when the final pane-mode probe fails', async () => {
    let modeProbes = 0
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') {
        modeProbes++
        if (modeProbes === 2) throw new Error('tmux display-message timed out')
        return { stdout: '0\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    await expect(withSessionInput(config, 'worker', input => (
      input.submitPrompt('must remain retryable', async () => true)
    ))).resolves.toBe(false)
    expect(execFileMock.mock.calls.some(([, args]) => (
      args[0] === 'load-buffer' || args[0] === 'paste-buffer'
    ))).toBe(false)
  })

  it('clears an unsubmitted line after a late failure before accepting a later prompt', async () => {
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    await expect(withSessionInput(config, 'worker', input => (
      input.submitPrompt('first unsent prompt', async () => true, async () => {
        throw new Error('original late probe failure')
      })
    ))).rejects.toThrow('original late probe failure')

    await expect(withSessionInput(config, 'worker', input => (
      input.submitPrompt('second clean prompt', async () => true)
    ))).resolves.toBe(true)

    const sentKeys = execFileMock.mock.calls
      .map(([, args]) => args as string[])
      .filter(args => args[0] === 'send-keys')
    expect(sentKeys).toEqual([
      ['send-keys', '-t', '%1', 'C-u'],
      ['send-keys', '-t', '%1', '', 'Enter'],
    ])
    expect(execFileMock.mock.calls.filter(([, args]) => args[0] === 'paste-buffer'))
      .toHaveLength(2)
  })

  it('clears a potentially partial line when buffer paste fails', async () => {
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      if (args[0] === 'paste-buffer') {
        throw new Error('buffer paste timed out')
      }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    await expect(withSessionInput(config, 'worker', input => (
      input.submitPrompt('possibly partial prompt', async () => true)
    ))).rejects.toMatchObject({
      name: 'TerminalPromptSubmissionError',
      submissionState: 'cleared',
      message: 'buffer paste timed out',
    })

    expect(execFileMock.mock.calls
      .map(([, args]) => args as string[])
      .filter(args => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', '%1', 'C-u'],
    ])
  })

  it('stages messages larger than the operating-system argv limit', async () => {
    const prompt = 'x'.repeat(256 * 1024)
    let stagedPrompt = ''
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      if (args[0] === 'load-buffer') stagedPrompt = readFileSync(args[3]!, 'utf8')
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    await expect(withSessionInput(config, 'worker', input => (
      input.submitPrompt(prompt, async () => true)
    ))).resolves.toBe(true)

    expect(stagedPrompt).toBe(prompt)
    expect(execFileMock.mock.calls.some(([, args]) => args.includes(prompt))).toBe(false)
    expect(execFileMock.mock.calls.some(([, args]) => args[0] === 'paste-buffer')).toBe(true)
  })

  it('marks a failed Enter command as possibly submitted', async () => {
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      if (args[0] === 'send-keys' && args.includes('Enter')) {
        throw new Error('Enter timed out')
      }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    await expect(withSessionInput(config, 'worker', input => (
      input.submitPrompt('possibly submitted', async () => true)
    ))).rejects.toMatchObject({
      name: 'TerminalPromptSubmissionError',
      submissionState: 'possibly-submitted',
      message: 'Enter timed out',
    })
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', '%1', 'C-u'],
      expect.any(Object),
    )
  })

  it('does not mask a late probe error when clearing the unsubmitted line fails', async () => {
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      if (args[0] === 'send-keys' && args.includes('C-u')) {
        throw new Error('cleanup failed')
      }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    const rejection = withSessionInput(config, 'worker', input => (
      input.submitPrompt('first unsent prompt', async () => true, async () => {
        throw new Error('original late probe failure')
      })
    ))
    await expect(rejection).rejects.toBeInstanceOf(TerminalPromptSubmissionError)
    await expect(rejection).rejects.toMatchObject({ submissionState: 'orphaned' })
  })

  it('pins capture, cwd, and both prompt stages when the active pane changes', async () => {
    let activePane = '%1'
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'ps' && args[1] === 'tpgid=') return { stdout: '5252\n', stderr: '' }
      if (file === 'ps') return { stdout: 'Fri Aug  1 10:00:00 2026\n', stderr: '' }
      if (args[0] === 'show-environment') {
        return { stdout: 'TINSTAR_AGENT_INCARNATION=launch-one\n', stderr: '' }
      }
      if (args.at(-1) === '#{pane_id}') return { stdout: `${activePane}\n`, stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      if (args.at(-1) === '#{pane_pid}') {
        return { stdout: args[3] === '%1' ? '4242\n' : '4343\n', stderr: '' }
      }
      if (args.at(-1) === '#{pane_current_path}') {
        return { stdout: args[3] === '%1' ? '/work/pinned\n' : '/work/other\n', stderr: '' }
      }
      if (args[0] === 'capture-pane') {
        return {
          stdout: args[2] === '%1'
            ? '› Add a follow-up\n  ? for shortcuts'
            : 'other-pane$ ',
          stderr: '',
        }
      }
      if (args[0] === 'paste-buffer') activePane = '%2'
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    const submitted = await withSessionInput(config, 'worker', async input => {
      // A user switches panes immediately after the transaction pins %1.
      activePane = '%2'
      expect(await input.captureScreen()).toContain('? for shortcuts')
      expect(await input.getWorkingDirectory()).toBe('/work/pinned')
      const identity = await input.getAgentIdentity()
      expect(identity).toMatch(/^[a-f0-9]{64}$/)
      return input.submitPrompt(
        'durable envelope',
        async () => (await input.captureScreen()).includes('? for shortcuts'),
        async () => {
          expect(await input.getAgentIdentity()).toBe(identity)
        },
      )
    })

    expect(submitted).toBe(true)
    const paneOperations = execFileMock.mock.calls.filter(([, args]) => (
      Array.isArray(args)
      && (args[0] === 'capture-pane'
        || args[0] === 'send-keys'
        || args.at(-1) === '#{pane_current_path}'
        || args.at(-1) === '#{pane_pid}')
    ))
    expect(paneOperations.every(([, args]) => args[args.indexOf('-t') + 1] === '%1')).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', '%1', '', 'Enter'],
      expect.any(Object),
    )
  })

  it('withholds every prompt byte when the pinned foreground changes before injection', async () => {
    let foregroundPid = '5252'
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'ps' && args[1] === 'tpgid=') {
        return { stdout: `${foregroundPid}\n`, stderr: '' }
      }
      if (file === 'ps') return { stdout: 'Fri Aug  1 10:00:00 2026\n', stderr: '' }
      if (args[0] === 'show-environment') {
        return { stdout: 'TINSTAR_AGENT_INCARNATION=launch-one\n', stderr: '' }
      }
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      if (args.at(-1) === '#{pane_pid}') return { stdout: '4242\n', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    const submitted = await withSessionInput(config, 'worker', async input => {
      const identity = await input.getAgentIdentity()
      foregroundPid = '6262'
      return input.submitPrompt(
        'durable envelope',
        async () => await input.getAgentIdentity() === identity,
      )
    })

    expect(submitted).toBe(false)
    expect(execFileMock.mock.calls.some(([, args]) => args[0] === 'paste-buffer'))
      .toBe(false)
  })

  it('withholds Enter when the pinned foreground changes after literal bytes', async () => {
    let foregroundPid = '5252'
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'ps' && args[1] === 'tpgid=') {
        return { stdout: `${foregroundPid}\n`, stderr: '' }
      }
      if (file === 'ps') return { stdout: 'Fri Aug  1 10:00:00 2026\n', stderr: '' }
      if (args[0] === 'show-environment') {
        return { stdout: 'TINSTAR_AGENT_INCARNATION=launch-one\n', stderr: '' }
      }
      if (args.at(-1) === '#{pane_id}') return { stdout: '%1\n', stderr: '' }
      if (args.at(-1) === '#{pane_in_mode}') return { stdout: '0\n', stderr: '' }
      if (args.at(-1) === '#{pane_pid}') return { stdout: '4242\n', stderr: '' }
      if (args[0] === 'paste-buffer') foregroundPid = '6262'
      return { stdout: '', stderr: '' }
    })
    const config = { sessions: { prefix: 'tinstar-' } } as TinstarConfig

    await expect(withSessionInput(config, 'worker', async input => {
      const identity = await input.getAgentIdentity()
      return input.submitPrompt(
        'durable envelope',
        async () => true,
        async () => {
          if (await input.getAgentIdentity() !== identity) {
            throw new Error('recipient changed after prompt text injection')
          }
        },
      )
    })).rejects.toThrow('recipient changed after prompt text injection')

    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['paste-buffer', '-d', '-b', expect.stringMatching(/^tinstar-/), '-t', '%1'],
      expect.any(Object),
    )
    expect(execFileMock.mock.calls.some(([, args]) => args.includes('Enter'))).toBe(false)
  })
})
