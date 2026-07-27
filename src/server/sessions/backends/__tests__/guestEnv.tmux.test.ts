import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scrubTmuxSessionEnv } from '../tmux'
import { guestEnv } from '../../guestEnv'

const execFileAsync = promisify(execFile)

/**
 * ACCEPTANCE TEST for the guest-environment boundary.
 *
 * Asserts against a REAL tmux session's REAL shell environment — not a mock,
 * and not "NODE_ENV !== 'production'". The bug being guarded is that Tinstar's
 * own runtime config leaked into guest agent sessions, where NODE_ENV=production
 * made `npm install` silently omit devDependencies.
 *
 * ISOLATION. Every tmux call here passes an explicit `-L <socket>`. That is the
 * ONLY reliable isolation mechanism: TMUX_TMPDIR does NOT isolate when $TMUX is
 * set (a tmux client with $TMUX set uses that socket and ignores TMUX_TMPDIR),
 * so a test run from inside tmux — which is how Tinstar's own agents run it —
 * would otherwise operate on the developer's real tmux server. A `kill-server`
 * without `-L` did exactly that during this investigation.
 */

const SOCKET = `tinstar-guestenv-test-${process.pid}`
const tmux = (...args: string[]) => execFileAsync('tmux', ['-L', SOCKET, ...args], { timeout: 15_000 })

/**
 * Tinstar's own environment as systemd gives it: ambient login vars, plus the
 * private runtime config that must not cross into a guest.
 */
const POLLUTED_ENV = {
  ...guestEnv(),                                  // real PATH etc. so tmux/bash actually run
  NODE_ENV: 'production',                         // the variable that broke npm install
  TINSTAR_CORS_ORIGINS: 'http://localhost:5273',  // unit-file private config
  INVOCATION_ID: 'test-invocation',               // systemd instance identity
  A_FUTURE_TINSTAR_SETTING: 'leaked',             // stands in for the NEXT var someone adds
}

let tmuxAvailable = false
let scratch: string

beforeAll(async () => {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: 5_000 })
    tmuxAvailable = true
  } catch { tmuxAvailable = false }
  scratch = mkdtempSync(join(tmpdir(), 'guestenv-'))
})

afterEach(async () => {
  try { await tmux('kill-server') } catch { /* no server to kill */ }
})

afterAll(() => {
  // `kill-server` stops the server but leaves the socket FILE behind, which
  // would accumulate one per test run under /tmp/tmux-*/.
  const sock = join(process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? 0}`, SOCKET)
  try { rmSync(sock, { force: true }) } catch { /* never fail teardown */ }
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* ditto */ }
})

/** Start an isolated tmux server whose environment is Tinstar's polluted one. */
async function startPollutedServer(session: string): Promise<void> {
  await execFileAsync('tmux', ['-L', SOCKET, '-f', '/dev/null', 'new', '-d', '-s', session], {
    env: POLLUTED_ENV,
    timeout: 15_000,
  })
}

/**
 * Environment of a REAL shell started in `session`, read by having tmux run
 * `env` in a new window. Polls for the file rather than sleeping a fixed
 * interval — CI runners are slower than local and fixed waits flake there.
 */
async function paneEnv(session: string, label: string): Promise<Record<string, string>> {
  const out = join(scratch, `${label}.env`)
  await tmux('new-window', '-t', session, '-d', `env > ${out}`)
  for (let i = 0; i < 100; i++) {
    if (existsSync(out) && readFileSync(out, 'utf-8').includes('PATH=')) break
    await new Promise((r) => setTimeout(r, 50))
  }
  const env: Record<string, string> = {}
  for (const line of readFileSync(out, 'utf-8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

describe('guest env boundary (real tmux)', () => {
  it('leaks Tinstar env without the fix — proves the test can detect the bug', async () => {
    if (!tmuxAvailable) return
    // Guard against a vacuous suite: if this ever stops failing to leak, the
    // assertions below would pass for the wrong reason.
    await startPollutedServer('leaky')
    const env = await paneEnv('leaky', 'leaky')
    expect(env.NODE_ENV).toBe('production')
    expect(env.A_FUTURE_TINSTAR_SETTING).toBe('leaked')
  }, 60_000)

  it('a guest shell has NO NODE_ENV once the session is scrubbed', async () => {
    if (!tmuxAvailable) return
    await startPollutedServer('scrubbed')
    await scrubTmuxSessionEnv('scrubbed', 'scrubbed', ['-L', SOCKET])

    const env = await paneEnv('scrubbed', 'scrubbed')
    // Absent entirely — not merely "not production". A guest project that sets
    // its own NODE_ENV is then free to do so without fighting an inherited one.
    expect(env).not.toHaveProperty('NODE_ENV')
    expect(env).not.toHaveProperty('TINSTAR_CORS_ORIGINS')
    expect(env).not.toHaveProperty('INVOCATION_ID')
    // The allowlist's whole point: a variable nobody anticipated is stripped
    // without anyone having edited a denylist.
    expect(env).not.toHaveProperty('A_FUTURE_TINSTAR_SETTING')
  }, 60_000)

  it('keeps what a login shell needs', async () => {
    if (!tmuxAvailable) return
    await startPollutedServer('keeps')
    await scrubTmuxSessionEnv('keeps', 'keeps', ['-L', SOCKET])

    const env = await paneEnv('keeps', 'keeps')
    expect(env.HOME).toBe(process.env.HOME)
    expect(env.PATH).toBeTruthy()
    expect(env.USER).toBe(process.env.USER)
  }, 60_000)

  it('never strips a session-scoped var — session identity survives', async () => {
    if (!tmuxAvailable) return
    // The restart-path hazard: when Tinstar runs inside a Tinstar session, the
    // PARENT's TINSTAR_SESSION_NAME and secrets sit in the global env. Removing
    // those names blindly replaces the child's own session-scoped values with
    // removal markers, leaving the pane with no identity at all.
    await execFileAsync('tmux', ['-L', SOCKET, '-f', '/dev/null', 'new', '-d', '-s', 'ident'], {
      env: { ...POLLUTED_ENV, TINSTAR_SESSION_NAME: 'parent', ANTHROPIC_API_KEY: 'parent-key' },
      timeout: 15_000,
    })
    // Tinstar's deliberate injections for the CHILD session.
    await tmux('set-environment', '-t', 'ident', 'TINSTAR_SESSION_NAME', 'child')
    await tmux('set-environment', '-t', 'ident', 'ANTHROPIC_API_KEY', 'child-key')

    await scrubTmuxSessionEnv('ident', 'ident', ['-L', SOCKET])

    const env = await paneEnv('ident', 'ident')
    expect(env.TINSTAR_SESSION_NAME).toBe('child')
    expect(env.ANTHROPIC_API_KEY).toBe('child-key')  // dynamic secret name, no hardcoded list
    expect(env).not.toHaveProperty('NODE_ENV')       // ...while still stripping the private ones
  }, 60_000)

  it('corrects the ALREADY-RUNNING pane shell, not just new ones', async () => {
    if (!tmuxAvailable) return
    // A pane's environment is frozen at exec, so the shell that was already
    // running keeps the stale value in /proc. Tinstar's launch line starts with
    // `eval "$(tmux show-environment -s)"`, and a removal makes that emit
    // `unset NODE_ENV;` — which is what repairs the live shell.
    await startPollutedServer('live')
    await scrubTmuxSessionEnv('live', 'live', ['-L', SOCKET])

    const out = join(scratch, 'live-shell.env')
    await tmux('send-keys', '-t', 'live',
      `eval "$(tmux -L ${SOCKET} show-environment -s)" && env > ${out}`, 'Enter')
    for (let i = 0; i < 100; i++) {
      if (existsSync(out) && readFileSync(out, 'utf-8').includes('PATH=')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const text = readFileSync(out, 'utf-8')
    expect(text).not.toMatch(/^NODE_ENV=/m)
    expect(text).toMatch(/^PATH=/m)
  }, 60_000)
})
