import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * M2 GATE: proves, on a PRIVATE tmux server, the tmux semantics the first mate
 * terminal view is built on (docs/features/firstmate-observer.md).
 *
 * ISOLATION. The live first mate workers run on the user's default tmux server, so
 * nothing here may ever reach it. Every tmux call goes through a `tmux` shim placed
 * first on PATH that pins `-L <private socket> -f /dev/null`, and $TMUX is removed
 * from the environment (a client with $TMUX set would otherwise talk to that
 * socket). The shim also means the first mate's own helpers, which call a bare
 * `tmux`, and bin/tinstar-fm-view, do too.
 */

const REPO = resolve(__dirname, '../../..')
const VIEW_SCRIPT = join(REPO, 'bin', 'tinstar-fm-view')
const FM_HOME = process.env.FIRSTMATE_HOME ?? ''
const FM_TMUX_LIB = FM_HOME ? join(FM_HOME, 'bin', 'backends', 'tmux.sh') : ''
const HAS_FM = FM_TMUX_LIB !== '' && existsSync(FM_TMUX_LIB)
const FM_GATE = "the first mate's own tmux helpers give unchanged results while a view is attached"
const DESTRUCTIVE = new Set(['kill-session', 'kill-window', 'kill-pane', 'kill-server', 'respawn-pane', 'respawn-window', 'send-keys', 'unlink-window'])
const REAL_TMUX = (() => { try { return execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim() } catch { return '' } })()
const HAS_PY = (() => { try { execFileSync('python3', ['-V']); return true } catch { return false } })()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await sleep(40) }
  return fn()
}

// A real client needs a pty. This forwards its stdin to a pty child and keeps it alive.
const PTY_HELPER = `
import os, pty, select, sys, signal, struct, fcntl, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
def bye(*_):
    try: os.kill(pid, signal.SIGHUP)
    except Exception: pass
    os._exit(0)
signal.signal(signal.SIGTERM, bye)
sin = sys.stdin.fileno()
while True:
    try: r, _, _ = select.select([fd, sin], [], [])
    except Exception: break
    if fd in r:
        try:
            if not os.read(fd, 65536): break
        except OSError: break
    if sin in r:
        d = os.read(sin, 65536)
        if not d: bye()
        os.write(fd, d)
try: os.waitpid(pid, 0)
except Exception: pass
`

const suite = REAL_TMUX && HAS_PY ? describe : describe.skip
suite('first mate terminal view — tmux semantics (private server)', () => {
  let dir: string
  let socket: string
  let env: NodeJS.ProcessEnv
  let callLog: string
  const clients: ChildProcess[] = []

  const tm = (...args: string[]): string =>
    execFileSync(REAL_TMUX, ['-L', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8', timeout: 15_000 }).trim()
  const tmTry = (...args: string[]): { ok: boolean; out: string } => {
    try { return { ok: true, out: tm(...args) } } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) } }
  }
  const sessions = () => (tmTry('list-sessions', '-F', '#{session_name}').out || '').split('\n').filter(Boolean)
  const windowIds = (target: string) => tmTry('list-windows', '-t', target, '-F', '#{window_id}').out.split('\n').filter(Boolean)
  /** The view is armed once a client is attached AND destroy-unattached is on (the script sets both after the session exists). */
  const armed = () => {
    const v = viewSessions()
    return v.length === 1 && tmTry('list-clients', '-t', `=${v[0]}`).out !== '' && tmTry('show-options', '-t', `=${v[0]}:`, 'destroy-unattached').out.includes('on')
  }
  const viewSessions = () => sessions().filter(s => s.startsWith('tsview-'))

  function attachViaScript(fmSession: string, wid: string, name: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
    const c = spawn('python3', ['-c', PTY_HELPER, VIEW_SCRIPT, fmSession, wid, name], {
      env: { ...env, ...extraEnv, TERM: 'xterm-256color' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    clients.push(c)
    return c
  }
  const killClient = (c: ChildProcess) => { try { c.kill('SIGTERM') } catch { /* gone */ } }

  beforeAll(() => {
    dir = mkdtempSync(join('/tmp', 'fmv-'))
    mkdirSync(join(dir, 'bin'))
    socket = `fmv-${process.pid}`
    callLog = join(dir, 'tmux-calls.log')
    // Every call through the shim is logged (argv joined by \x1f, one call per line).
    // FMV_HOLD stalls right after new-session so a test can hang up before the attach.
    writeFileSync(join(dir, 'bin', 'tmux'), [
      '#!/bin/sh',
      `{ printf '%s\\037' "$@"; printf '\\n'; } >> '${callLog}'`,
      'if [ "$1" = new-session ] && [ -n "${FMV_HOLD:-}" ]; then',
      `  '${REAL_TMUX}' -L '${socket}' -f /dev/null "$@"; rc=$?; : > "$FMV_HOLD"; sleep 3; exit $rc`,
      'fi',
      `exec '${REAL_TMUX}' -L '${socket}' -f /dev/null "$@"`,
      '',
    ].join('\n'))
    chmodSync(join(dir, 'bin', 'tmux'), 0o755)
    env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TMUX_TMPDIR: join(dir, 'tmp') }
    delete env.TMUX
    delete env.TMUX_PANE
    mkdirSync(join(dir, 'tmp'))
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) killClient(c)
    tmTry('kill-server')
    // kill-server returns before the socket is dead; the next test must not reach a dying server.
    await until(() => !tmTry('list-sessions').ok, 3000)
  })

  afterAll(() => {
    tmTry('kill-server')
    rmSync(dir, { recursive: true, force: true })
  })

  /** A first mate–shaped server: session `firstmate` with a supervisor window + one worker window. */
  function fleet(workerCmd?: string): { wid: string; other: string } {
    tm('new-session', '-d', '-s', 'firstmate', '-x', '80', '-y', '24', '-n', 'zsh')
    const wid = tm('new-window', '-dP', '-F', '#{window_id}', '-t', 'firstmate:', '-n', 'fm-demo', ...(workerCmd ? [workerCmd] : []))
    const other = tm('new-window', '-dP', '-F', '#{window_id}', '-t', 'firstmate:', '-n', 'fm-other')
    return { wid, other }
  }

  it('the shim really is private: the test server is not the default one', () => {
    fleet()
    const priv = tm('display', '-p', '#{socket_path}')
    expect(priv).toContain(socket)
  })

  it('the view script refuses stale / malformed targets without creating anything', async () => {
    const { wid } = fleet()
    for (const [s, w, n] of [['firstmate', '@999', 'fm-demo'], ['firstmate', wid, 'fm-wrong'], ['nope', wid, 'fm-demo'], ['firstmate', 'x', 'fm-demo'], ['firstmate', wid, '$(id)']] as [string, string, string][]) {
      const c = attachViaScript(s, w, n)
      await sleep(150)
      killClient(c)
    }
    expect(viewSessions()).toEqual([])
    expect(windowIds('=firstmate')).toContain(wid)
  })

  it('killing the view leaves the origin window alive (session gone, link gone)', async () => {
    const { wid } = fleet()
    const c = attachViaScript('firstmate', wid, 'fm-demo')
    expect(await until(() => viewSessions().length === 1)).toBe(true)
    const view = viewSessions()[0]!
    expect(view.startsWith('firstmate')).toBe(false)
    // exactly one window in the view: the worker's, linked (not copied)
    expect(windowIds(`=${view}`)).toEqual([wid])
    expect(tm('list-windows', '-a', '-F', '#{window_id} #{session_name}').split('\n').filter(l => l.startsWith(wid)).length).toBe(2)
    // explicit kill-session of the view (what a delete would do)
    tm('kill-session', '-t', `=${view}`)
    expect(windowIds('=firstmate')).toContain(wid)
    killClient(c)
  })

  it('a browser disconnect (client hangs up) destroys the view and spares the worker', async () => {
    const { wid } = fleet()
    const c = attachViaScript('firstmate', wid, 'fm-demo')
    const up = await until(armed)
    killClient(c)
    const down = await until(() => viewSessions().length === 0)
    expect(up).toBe(true)
    expect(down).toBe(true)
    expect(windowIds('=firstmate')).toContain(wid)
  })

  it('killing the origin window destroys the view', async () => {
    const { wid } = fleet()
    attachViaScript('firstmate', wid, 'fm-demo')
    expect(await until(armed)).toBe(true)
    tm('kill-window', '-t', wid)
    expect(await until(() => viewSessions().length === 0)).toBe(true)
    expect(windowIds('=firstmate')).not.toContain(wid)
  })

  it('unlink-window without -k refuses to remove the last link', () => {
    const { wid } = fleet()
    tm('new-session', '-d', '-s', 'tsview-x')
    tm('link-window', '-d', '-s', wid, '-t', '=tsview-x:')
    // two links: removing one is allowed
    expect(tmTry('unlink-window', '-t', `=tsview-x:${wid}`).ok).toBe(true)
    // one link left: tmux refuses, the window survives
    const r = tmTry('unlink-window', '-t', `=firstmate:${wid}`)
    expect(r.ok).toBe(false)
    expect(windowIds('=firstmate')).toContain(wid)
  })

  it('prefix None + the passthrough table delivers C-b and C-h to the pane', async () => {
    // A raw-mode key recorder as the worker's pane process (a cooked tty would eat ^H itself).
    const keysFile = join(dir, 'keys.txt')
    writeFileSync(join(dir, 'rec.py'), `import os\nf = open(${JSON.stringify(keysFile)}, 'ab', buffering=0)\nwhile True:\n    d = os.read(0, 100)\n    f.write(d)\n`)
    const { wid } = fleet(`stty raw -echo; exec python3 ${join(dir, 'rec.py')}`)
    // A hostile server config: the root-table C-h binding Tinstar installs, and a normal prefix.
    tm('bind-key', '-n', 'C-h', 'kill-window')
    const c = attachViaScript('firstmate', wid, 'fm-demo')
    expect(await until(armed)).toBe(true)
    expect(tm('show-options', '-t', `=${viewSessions()[0]}:`, 'prefix')).toContain('None')
    await sleep(300)
    c.stdin!.write('\x02')   // C-b
    c.stdin!.write('\x08')   // C-h
    c.stdin!.write('&')      // would kill-window if C-b were still a prefix
    c.stdin!.write('x')
    expect(await until(() => existsSync(keysFile) && readFileSync(keysFile, 'latin1') === '\x02\x08&x')).toBe(true)
    // neither C-b & nor C-h killed anything
    expect(windowIds('=firstmate')).toContain(wid)
    expect(viewSessions().length).toBe(1)
  })

  if (!HAS_FM) console.warn(`SKIPPED M2 gate "${FM_GATE}": set FIRSTMATE_HOME to a first mate checkout (needs bin/backends/tmux.sh) to run it.`)
  const fmLib = HAS_FM ? it : it.skip
  fmLib(HAS_FM ? FM_GATE : `${FM_GATE} [SKIPPED: FIRSTMATE_HOME unset or missing bin/backends/tmux.sh]`, async () => {
    // A stand-in harness process whose name the first mate classifies as an agent.
    symlinkSync('/bin/sleep', join(dir, 'bin', 'claude'))
    const { wid, other } = fleet(`${join(dir, 'bin', 'claude')} 600`)
    void other
    const fm = (body: string): string => {
      try {
        return execFileSync('bash', ['-c', `FM_BACKEND_LIB_DIR='${join(FM_HOME, 'bin')}'; . '${FM_TMUX_LIB}'; ${body}`], { env, encoding: 'utf8', timeout: 20_000 }).trim()
      } catch (e) { return `ERR:${(e as { status?: number }).status}` }
    }
    const state = () => fm('fm_backend_tmux_agent_state firstmate:fm-demo')
    const beforeState = state()
    const beforeInv = fm('fm_backend_tmux_window_inventory =firstmate')
    const beforeGone = fm('fm_backend_tmux_agent_state firstmate:fm-nope')
    expect(beforeState).toBe('alive')

    const c = attachViaScript('firstmate', wid, 'fm-demo')
    expect(await until(armed)).toBe(true)
    expect(state()).toBe(beforeState)
    expect(fm('fm_backend_tmux_window_inventory =firstmate')).toBe(beforeInv)
    expect(fm('fm_backend_tmux_agent_state firstmate:fm-nope')).toBe(beforeGone)

    // Killing a DIFFERENT worker leaves this view alone …
    expect(fm('fm_backend_tmux_kill firstmate:fm-other; echo rc=$?')).toContain('rc=0')
    expect(windowIds('=firstmate')).not.toContain(other)
    expect(viewSessions().length).toBe(1)
    // … and re-killing the already-gone window is still a silent success.
    expect(fm('fm_backend_tmux_kill firstmate:fm-other; echo rc=$?')).toContain('rc=0')
    // Killing the viewed worker succeeds, closes the view, and reads as missing afterwards.
    expect(fm('fm_backend_tmux_kill firstmate:fm-demo; echo rc=$?')).toContain('rc=0')
    expect(await until(() => viewSessions().length === 0)).toBe(true)
    expect(fm('fm_backend_tmux_agent_state firstmate:fm-demo')).toBe('missing')
    killClient(c)
  })

  it('bin/tinstar-fm-view only ever aims destructive tmux verbs at =tsview- targets', async () => {
    const { wid } = fleet()
    writeFileSync(callLog, '')
    // refused targets
    for (const [s, w, n] of [['firstmate', '@999', 'fm-demo'], ['firstmate', wid, 'fm-wrong'], ['nope', wid, 'fm-demo'], ['tsview', wid, 'fm-demo']] as [string, string, string][]) {
      const c = attachViaScript(s, w, n)
      await sleep(150)
      killClient(c)
    }
    // a normal attach, then a browser disconnect
    const c = attachViaScript('firstmate', wid, 'fm-demo')
    expect(await until(armed)).toBe(true)
    killClient(c)
    expect(await until(() => viewSessions().length === 0)).toBe(true)
    // a hangup after the view session exists but before the attach
    const hold = join(dir, 'held')
    const h = attachViaScript('firstmate', wid, 'fm-demo', { FMV_HOLD: hold })
    expect(await until(() => existsSync(hold))).toBe(true)
    expect(viewSessions().length).toBe(1)
    killClient(h)
    expect(await until(() => viewSessions().length === 0)).toBe(true)
    expect(windowIds('=firstmate')).toContain(wid)

    const commands: string[][] = []
    for (const line of readFileSync(callLog, 'utf8').split('\n').filter(Boolean)) {
      let cur: string[] = []
      for (const a of line.split('\x1f').slice(0, -1)) {
        if (a === ';') { commands.push(cur); cur = [] } else cur.push(a)
      }
      commands.push(cur)
    }
    const destructive = commands.filter(cmd => DESTRUCTIVE.has(cmd[0]!))
    expect(destructive.map(cmd => cmd[0])).toEqual(expect.arrayContaining(['kill-window', 'kill-session']))
    for (const cmd of destructive) {
      const t = cmd.indexOf('-t')
      expect(t, cmd.join(' ')).toBeGreaterThan(0)
      expect(cmd[t + 1], cmd.join(' ')).toMatch(/^=tsview-/)
    }
  })
})
