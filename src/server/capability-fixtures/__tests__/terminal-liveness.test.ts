/**
 * Characterization: the terminal-side signals — is the session alive, and is
 * the agent sitting on a modal?
 *
 * Both providers run in tmux, so the transport (has-session / capture-pane) is
 * already shared. What is NOT shared is the *reading* of a pane: every
 * "is it blocked / did it start / is it busy" heuristic in the codebase is a
 * substring match against provider-specific chrome. Those substrings are the
 * real capability surface, so the frozen captures pin them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadTerminalCapture } from '../index'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:util', async (orig) => {
  const actual = await orig<typeof import('node:util')>()
  return { ...actual, promisify: () => execFileMock }
})

import { captureScreen, tmuxHasSession } from '../../sessions/backends/tmux'

beforeEach(() => { execFileMock.mockReset() })

describe('tmux liveness', () => {
  it('a session that exists resolves true', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(tmuxHasSession('tinstar-demo')).resolves.toBe(true)
    // Every tmux call is wrapped with a timeout, so a wedged tmux can never
    // hang a liveness probe indefinitely.
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      ['has-session', '-t', '=tinstar-demo'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })

  it('a non-zero exit is read as "gone", not as an error to propagate', async () => {
    execFileMock.mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: "can't find session" }))
    await expect(tmuxHasSession('tinstar-demo')).resolves.toBe(false)
  })

  it('a tmux server that is not running is ALSO read as "gone" — indistinguishable here', async () => {
    // Load-bearing: at this level "no server" and "no such session" collapse to
    // the same false. Only the ttyd sweep (listLiveTmuxSessionNames) keeps them
    // apart, because there "everything is dead" would mean killing live ttyds.
    execFileMock.mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'no server running on /tmp/tmux-1000/default' }))
    await expect(tmuxHasSession('tinstar-demo')).resolves.toBe(false)
  })
})

describe('pane capture', () => {
  it('returns the pane verbatim — the reader, not the transport, interprets it', async () => {
    const pane = loadTerminalCapture('codex-running')
    execFileMock.mockResolvedValue({ stdout: pane, stderr: '' })
    await expect(captureScreen('tinstar-demo')).resolves.toBe(pane)
  })

  it('asks for scrollback only when requested (codex transcript discovery uses 200)', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
    await captureScreen('tinstar-demo')
    expect(execFileMock).toHaveBeenLastCalledWith('tmux', ['capture-pane', '-t', '=tinstar-demo:', '-p'], expect.any(Object))
    await captureScreen('tinstar-demo', 200)
    expect(execFileMock).toHaveBeenLastCalledWith('tmux', ['capture-pane', '-t', '=tinstar-demo:', '-p', '-S', '-200'], expect.any(Object))
  })
})

describe('modal and busy states, as the pane renders them', () => {
  it('Claude\'s NATS dev-channel prompt is detected by the literal "Enter to confirm"', () => {
    // This exact substring is what autoAcceptDevChannelWarning polls for before
    // sending Enter; lose it and every NATS-enabled launch hangs on the modal.
    const pane = loadTerminalCapture('claude-dev-channel-warning')
    expect(pane).toContain('Enter to confirm')
    expect(pane).toContain('WARNING:')
  })

  it('the "already started, no warning" branch keys on the Claude Code banner', () => {
    const banner = loadTerminalCapture('claude-startup-banner')
    expect(banner).toContain('Claude Code')
    expect(banner).not.toContain('WARNING:')
    // …and the warning pane must NOT satisfy that branch, or auto-accept exits early.
    const warning = loadTerminalCapture('claude-dev-channel-warning')
    expect(warning.includes('Claude Code') && !warning.includes('WARNING:')).toBe(false)
  })

  it('cursor-agent\'s workspace-trust modal is the state the trust marker pre-empts', () => {
    const pane = loadTerminalCapture('cursor-trust-modal')
    expect(pane).toContain('Workspace Trust Required')
    // No keystroke automation exists for this one — Tinstar writes cursor's
    // marker file before launch instead (see sessions/cursor-trust.ts).
  })

  it('a Claude permission prompt looks idle to the JSONL but is a blocked modal', () => {
    const pane = loadTerminalCapture('claude-permission-modal')
    expect(pane).toContain('Do you want to proceed?')
    // The transcript still shows a pending tool_use here; only the process-tree
    // check in status-watcher tells the two apart. Nothing reads this pane today.
  })

  it('busy markers differ per provider — no shared substring identifies "working"', () => {
    const claude = loadTerminalCapture('claude-running')
    const codex = loadTerminalCapture('codex-running')
    expect(claude).toContain('esc to interrupt')
    expect(codex).toContain('esc to interrupt')
    // The only overlap is that phrase; everything around it is provider chrome.
    expect(claude).toContain('⏵⏵ bypass permissions')
    expect(codex).toContain('• Working')
    expect(codex).not.toContain('bypass permissions')
  })

  it('idle panes carry a provider-specific prompt glyph and no busy marker', () => {
    const claude = loadTerminalCapture('claude-idle')
    const codex = loadTerminalCapture('codex-idle')
    expect(claude).not.toContain('esc to interrupt')
    expect(codex).not.toContain('esc to interrupt')
    expect(claude).toContain('❯')
    expect(codex).toContain('›')
    expect(codex).toContain('Worked for')
  })

  it('Claude\'s statusline hook renders quota into the pane itself', () => {
    // The same numbers Tinstar ingests over HTTP also land here, which is why a
    // pane scrape is not an independent quota source for Claude.
    expect(loadTerminalCapture('claude-idle')).toMatch(/5h:\d+%\s+7d:\d+%/)
  })

  it('a dead agent leaves a bare shell prompt — the pane is alive, the agent is not', () => {
    const pane = loadTerminalCapture('agent-exited-shell')
    expect(pane).toMatch(/\$\s*$/)
    expect(pane).not.toContain('❯')
    expect(pane).not.toContain('›')
    // tmuxHasSession still returns true here; liveness of the *agent* is only
    // recoverable from the process tree, not from has-session.
  })
})
