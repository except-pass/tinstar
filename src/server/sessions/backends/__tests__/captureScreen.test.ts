import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:util', async (orig) => {
  const actual = await orig<typeof import('node:util')>()
  return { ...actual, promisify: () => execFileMock }
})

import { captureScreen, exactTmuxPaneTarget, exactTmuxSessionTarget } from '../tmux'

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
})
