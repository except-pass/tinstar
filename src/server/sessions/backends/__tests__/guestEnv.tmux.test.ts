import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exactTmuxPaneTarget, exactTmuxSessionTarget, scrubTmuxSessionEnv } from '../tmux'
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

/**
 * A socket name UNIQUE PER TEST.
 *
 * Sharing one socket across tests and killing the server between them races:
 * `kill-server` returns before the server has finished shutting down, so the
 * next test's `tmux new` can hit a socket that still exists but no longer
 * accepts connections, and fails with "Command failed: tmux … new -d -s …".
 * It passed locally and failed on the slower CI runner — the classic shape.
 * A distinct socket per test removes the shared resource instead of guessing
 * at a timing margin.
 */
const sockets = new Set<string>()
function socketFor(name: string): string {
  const s = `tinstar-guestenv-${process.pid}-${name}`
  sockets.add(s)
  return s
}
const tmuxOn = (socket: string) => (...args: string[]) =>
  execFileAsync('tmux', ['-L', socket, ...args], { timeout: 15_000 })

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

/**
 * Probed SYNCHRONOUSLY at module load, not in beforeAll: `it.skipIf(...)` is
 * evaluated at COLLECTION time, before any hook runs, so a flag set in
 * beforeAll is still false when skipIf reads it and every test would skip
 * permanently — silently reporting green with zero coverage, the exact failure
 * this suite exists to prevent.
 */
const tmuxAvailable = (() => {
  try { execFileSync('tmux', ['-V'], { timeout: 5_000, stdio: 'ignore' }); return true } catch { return false }
})()

/** The env of the "Tinstar" that started each polluted test server. The scrub's
 *  attribution filter is relative to THIS, not to the vitest process (which has
 *  no NODE_ENV — the suite runs under `env -u NODE_ENV`). */
const POLLUTED_ENV_NAMES = () => Object.keys(POLLUTED_ENV)

let scratch: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'guestenv-'))
})

afterAll(async () => {
  const dir = join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`)
  for (const s of sockets) {
    // ALWAYS -L. TMUX_TMPDIR does not isolate when $TMUX is set (a client with
    // $TMUX set uses that socket and ignores it), and these tests run inside
    // tmux. A kill-server without -L would take down the developer's server.
    try { await execFileAsync('tmux', ['-L', s, 'kill-server'], { timeout: 15_000 }) } catch { /* already gone */ }
    // kill-server leaves the socket FILE behind; it would accumulate per run.
    try { rmSync(join(dir, s), { force: true }) } catch { /* never fail teardown */ }
  }
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* ditto */ }
})

/**
 * Start an isolated tmux server whose environment is Tinstar's polluted one,
 * on a socket unique to this test. Returns the socket-bound tmux runner.
 */
async function startPollutedServer(
  session: string,
  extraEnv: Record<string, string> = {},
): Promise<(...args: string[]) => Promise<{ stdout: string; stderr: string }>> {
  const socket = socketFor(session)
  await execFileAsync('tmux', ['-L', socket, '-f', '/dev/null', 'new', '-d', '-s', session], {
    env: { ...POLLUTED_ENV, ...extraEnv },
    timeout: 15_000,
  })
  return tmuxOn(socket)
}

/**
 * Environment of a REAL shell started in `session`, read by having tmux run
 * `env` in a new window. Polls for the file rather than sleeping a fixed
 * interval — CI runners are slower than local and fixed waits flake there.
 */
async function paneEnv(
  tmux: (...args: string[]) => Promise<{ stdout: string; stderr: string }>,
  session: string,
): Promise<Record<string, string>> {
  const out = join(scratch, `${session}.env`)
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
  it.skipIf(!tmuxAvailable)('leaks Tinstar env without the fix — proves the test can detect the bug', async () => {
    // Guard against a vacuous suite: if this ever stops failing to leak, the
    // assertions below would pass for the wrong reason.
    const tmux = await startPollutedServer('leaky')
    const env = await paneEnv(tmux, 'leaky')
    expect(env.NODE_ENV).toBe('production')
    expect(env.A_FUTURE_TINSTAR_SETTING).toBe('leaked')
  }, 60_000)

  it.skipIf(!tmuxAvailable)('a guest shell has NO NODE_ENV once the session is scrubbed', async () => {
    const tmux = await startPollutedServer('scrubbed')
    await scrubTmuxSessionEnv('scrubbed', 'scrubbed', ['-L', socketFor('scrubbed')], POLLUTED_ENV_NAMES())

    const env = await paneEnv(tmux, 'scrubbed')
    // Absent entirely — not merely "not production". A guest project that sets
    // its own NODE_ENV is then free to do so without fighting an inherited one.
    expect(env).not.toHaveProperty('NODE_ENV')
    expect(env).not.toHaveProperty('TINSTAR_CORS_ORIGINS')
    expect(env).not.toHaveProperty('INVOCATION_ID')
    // The allowlist's whole point: a variable nobody anticipated is stripped
    // without anyone having edited a denylist.
    expect(env).not.toHaveProperty('A_FUTURE_TINSTAR_SETTING')
  }, 60_000)

  it.skipIf(!tmuxAvailable)('keeps what a login shell needs', async () => {
    const tmux = await startPollutedServer('keeps')
    await scrubTmuxSessionEnv('keeps', 'keeps', ['-L', socketFor('keeps')], POLLUTED_ENV_NAMES())

    const env = await paneEnv(tmux, 'keeps')
    expect(env.HOME).toBe(process.env.HOME)
    expect(env.PATH).toBeTruthy()
    expect(env.USER).toBe(process.env.USER)
  }, 60_000)

  it.skipIf(!tmuxAvailable)('never strips a session-scoped var — session identity survives', async () => {
    // The restart-path hazard: when Tinstar runs inside a Tinstar session, the
    // PARENT's TINSTAR_SESSION_NAME and secrets sit in the global env. Removing
    // those names blindly replaces the child's own session-scoped values with
    // removal markers, leaving the pane with no identity at all.
    const tmux = await startPollutedServer('ident', {
      TINSTAR_SESSION_NAME: 'parent',
      ANTHROPIC_API_KEY: 'parent-key',
    })
    // Tinstar's deliberate injections for the CHILD session.
    await tmux('set-environment', '-t', 'ident', 'TINSTAR_SESSION_NAME', 'child')
    await tmux('set-environment', '-t', 'ident', 'ANTHROPIC_API_KEY', 'child-key')

    await scrubTmuxSessionEnv('ident', 'ident', ['-L', socketFor('ident')], POLLUTED_ENV_NAMES())

    const env = await paneEnv(tmux, 'ident')
    expect(env.TINSTAR_SESSION_NAME).toBe('child')
    expect(env.ANTHROPIC_API_KEY).toBe('child-key')  // dynamic secret name, no hardcoded list
    expect(env).not.toHaveProperty('NODE_ENV')       // ...while still stripping the private ones
  }, 60_000)

  it.skipIf(!tmuxAvailable)('corrects the ALREADY-RUNNING pane shell, not just new ones', async () => {
    // A pane's environment is frozen at exec, so the shell that was already
    // running keeps the stale value in /proc. Tinstar's launch line starts with
    // `eval "$(tmux show-environment -s)"`, and a removal makes that emit
    // `unset NODE_ENV;` — which is what repairs the live shell.
    const tmux = await startPollutedServer('live')
    const socket = socketFor('live')
    await scrubTmuxSessionEnv('live', 'live', ['-L', socket], POLLUTED_ENV_NAMES())

    const out = join(scratch, 'live-shell.env')
    await tmux('send-keys', '-t', 'live',
      `eval "$(tmux -L ${socket} show-environment -s)" && env > ${out}`, 'Enter')
    for (let i = 0; i < 100; i++) {
      if (existsSync(out) && readFileSync(out, 'utf-8').includes('PATH=')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const text = readFileSync(out, 'utf-8')
    expect(text).not.toMatch(/^NODE_ENV=/m)
    expect(text).toMatch(/^PATH=/m)
  }, 60_000)
})

describe('exact target grammar (real tmux)', () => {
  it.skipIf(!tmuxAvailable)('does not resolve a missing parent to its prefixed child', async () => {
    const parent = 'target-parent'
    const child = `${parent}-child`
    const tmux = await startPollutedServer(child)

    const bareLookup = await tmux('list-panes', '-t', parent, '-F', '#{session_name}')
    expect(bareLookup.stdout.trim()).toBe(child)

    await expect(tmux('has-session', '-t', exactTmuxSessionTarget(parent))).rejects.toThrow()
    await expect(tmux('list-panes', '-t', exactTmuxPaneTarget(parent), '-F', '#{session_name}')).rejects.toThrow()
    await expect(tmux('kill-session', '-t', exactTmuxSessionTarget(parent))).rejects.toThrow()
    await expect(tmux('has-session', '-t', exactTmuxSessionTarget(child))).resolves.toBeDefined()
  }, 60_000)

  it.skipIf(!tmuxAvailable)('accepts exact pane targets for every lifecycle command form', async () => {
    const session = 'target-live'
    const tmux = await startPollutedServer(session)
    const target = exactTmuxPaneTarget(session)

    await expect(tmux('set', '-t', target, 'status', 'off')).resolves.toBeDefined()
    await expect(tmux('capture-pane', '-t', target, '-p')).resolves.toBeDefined()
    await expect(tmux('display-message', '-p', '-t', target, '#{pane_id}')).resolves.toBeDefined()
    await expect(tmux('send-keys', '-t', target, 'C-l')).resolves.toBeDefined()
  }, 60_000)
})
