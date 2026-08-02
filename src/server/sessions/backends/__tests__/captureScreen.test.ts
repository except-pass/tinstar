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

  it('settles and submits the checked prompt in one tmux command queue', async () => {
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
      input.submitPrompt('durable envelope', async () => (
        (await input.captureScreen()).includes('? for shortcuts')
      ))
    ))

    expect(submitted).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      [
        'send-keys', '-t', '=tinstar-worker:', 'durable envelope', '',
        ';', 'run-shell', 'sleep 0.3',
        ';', 'send-keys', '-t', '=tinstar-worker:', '', 'Enter',
      ],
      expect.any(Object),
    )
  })
})
