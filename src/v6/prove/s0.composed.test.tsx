/**
 * Composed S0 against the real snapshot and inbox binaries.
 * The temp home is a fixture. T01's worker-process half is unfinished.
 * T25 is unsupported: tool access is not supervision, and this does not prove a native desktop client.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { _resetApiBaseForTests } from '../../apiClient'
import { setV6RouteDepsForTests } from '../../server/v6/shell/routes'
import { V6Views } from '../../server/v6/shell/views'
import { v6ModuleHandlers, handleWiredHttp } from '../../server/v6/wire'
import { handleV6Http } from '../../server/v6/shell/routes'
import { T01_PROCESS_UNCLAIMED } from '../objective/model'

vi.mock('../../components/WorkspaceShell', () => ({
  default: () => <div>workspace-shell</div>,
}))

import App from '../../App'

const BIN = process.env.FM_V6_BIN
  ?? '/Users/wtg/.local/state/pm-build/tinstar-v6/worktrees/fm-boundary/bin'
const binDir = BIN.endsWith('.sh') ? join(BIN, '..') : BIN

/** Probed at load: `it.skipIf` reads these before `beforeAll`. `-V` does not touch a session. */
function commandInstalled(bin: string): boolean {
  try {
    execFileSync(bin, ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasBins = existsSync(join(binDir, 'fm-fleet-snapshot.sh')) && existsSync(join(binDir, 'fm-inbox.sh'))
const hasTmux = commandInstalled('tmux')

function liveIt(
  name: string,
  needs: { bins?: boolean; tmux?: boolean },
  fn: () => void | Promise<void>,
  timeout?: number,
): void {
  const reasons: string[] = []
  if (needs.bins && !hasBins) reasons.push('fm-fleet-snapshot.sh and fm-inbox.sh are absent')
  if (needs.tmux && !hasTmux) reasons.push('tmux is absent')
  const reason = reasons.join('; ')
  it.skipIf(reason.length > 0)(reason ? `${name} (skipped: ${reason})` : name, fn, timeout)
}
const HELLO = 'hello from the fixture shell'
const REPLY = 'captain read the fixture worker'
const TURN_1 = 'first turn on the fixture thread'
const REPLY_1 = 'fixture reply to the first turn'
const TURN_2 = 'second turn on the fixture thread'
const REPLY_2 = 'fixture reply to the second turn'
const TOKENS = [HELLO, REPLY, TURN_1, REPLY_1, TURN_2, REPLY_2]
const DENIED = ['firstmate', 'serena-view', 'kd-live']
const ENV_KEYS = [
  'FM_HOME', 'FM_STATE_OVERRIDE', 'FM_DATA_OVERRIDE', 'FM_CONFIG_OVERRIDE',
  'FM_PROJECTS_OVERRIDE', 'FM_ROOT_OVERRIDE', 'FM_TEST_HOME', 'TMUX', 'TMUX_PANE',
  'TMUX_TMPDIR', 'TINSTAR_CONFIG_HOME', 'TINSTAR_V6_FM_HOME', 'TINSTAR_V6_FIXTURE',
  'TINSTAR_V6_TMUX_SOCKET', 'FM_V6_BIN', 'PATH',
] as const

const POLICY_FILES = [
  '/Users/wtg/repo/firstmate/config/crew-dispatch.json',
  '/Users/wtg/repo/firstmate/config/fleet-ledger',
  '/Users/wtg/repo/firstmate/config/claude-permission-mode',
  '/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home/config/crew-dispatch.json',
  '/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home/config/fleet-ledger',
  '/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home/config/claude-permission-mode',
]

interface NoteEnvelope {
  id: string
  kind?: string
  requestId?: string
  anchor?: { type?: string; ids?: string[] }
  body?: { text?: string; threadId?: string; previousNoteId?: string | null }
}

const saved: Record<string, string | undefined> = {}
let home = ''
let config = ''
let sockDir = ''
let base = ''
let server: Server | null = null
let views: V6Views | null = null
let viewChild: ChildProcess | null = null
const socket = `prove${process.pid}`
const startedAt = Date.now()
const policyHash = new Map<string, string>()

function rememberEnv(): void {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FM_HOME: home }
  if (sockDir) env.TMUX_TMPDIR = sockDir
  else delete env.TMUX_TMPDIR
  delete env.TMUX
  delete env.TMUX_PANE
  for (const key of Object.keys(env)) {
    if (key.startsWith('FM_') && key.endsWith('_OVERRIDE')) delete env[key]
  }
  delete env.FM_TEST_HOME
  return env
}

function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', socket, ...args], { env: childEnv(), encoding: 'utf8' })
}

function listSessions(): string[] {
  return tmux('list-sessions', '-F', '#{session_name}').split('\n').map(line => line.trim()).filter(Boolean)
}

function assertPrivate(names: string[]): void {
  for (const name of DENIED) expect(names).not.toContain(name)
}

function windowId(sessionName: string): string {
  return tmux('list-windows', '-t', `=${sessionName}`, '-F', '#{window_id}').trim()
}

function writeMeta(id: string, sessionName: string, windowName: string): void {
  const worktree = join(home, 'projects', id)
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(home, 'state', `${id}.meta`), [
    'spawn_gen=1',
    'project=fixture-project',
    'backend=tmux',
    `window=${sessionName}:${windowName}`,
    `worktree=${worktree}`,
    'kind=ship',
    'harness=claude',
    'mode=ship',
    'yolo=off',
    '',
  ].join('\n'))
}

function readNotes(): NoteEnvelope[] {
  const dir = join(home, 'state', 'inbox')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.note')).map(name => {
    const text = readFileSync(join(dir, name), 'utf8')
    const marker = text.indexOf('\n--\n')
    if (marker < 0) throw new Error(`note ${name} has no body`)
    const parsed = JSON.parse(text.slice(marker + 4)) as Omit<NoteEnvelope, 'id'>
    return { ...parsed, id: name.slice(0, -'.note'.length) }
  })
}

function noteByText(text: string): NoteEnvelope | undefined {
  return readNotes().find(note => note.body?.text === text)
}

function reply(noteId: string, text: string): void {
  execFileSync(join(binDir, 'fm-inbox.sh'), ['reply', '--json', noteId, text], {
    env: childEnv(),
    encoding: 'utf8',
  })
}

const ptyHelper = `
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

/** ttyd answers HTTP before a client connects. The linked session appears when this script runs. */
function attachView(argv: string[]): ChildProcess {
  const scriptIndex = argv.findIndex(arg => arg.endsWith('tinstar-v6-view'))
  if (scriptIndex < 0) throw new Error(`view argv has no tinstar-v6-view: ${argv.join(' ')}`)
  const script = argv[scriptIndex]!
  const viewArgs = argv.slice(scriptIndex + 1)
  if (viewArgs[0] !== socket || viewArgs[1] !== 'worker-a') {
    throw new Error(`view argv is not the private worker: ${viewArgs.join(' ')}`)
  }
  return spawn('python3', ['-c', ptyHelper, script, ...viewArgs], {
    env: { ...childEnv(), TINSTAR_V6_VIEW_DIE_SLEEP: '0', TERM: 'xterm-256color' },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
}

function treeHas(root: string, token: string): boolean {
  const visit = (dir: string): boolean => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (visit(path)) return true
      } else if (entry.isFile()) {
        try {
          if (statSync(path).size > 1_000_000) continue
          if (readFileSync(path, 'utf8').includes(token)) return true
        } catch { /* unreadable sidecar */ }
      }
    }
    return false
  }
  return visit(root)
}

function hashFile(file: string): string | null {
  if (!existsSync(file)) return null
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function outsideHits(token: string): string[] {
  const roots = [
    '/Users/wtg/repo/firstmate/state/inbox',
    '/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home/state/inbox',
  ]
  if (saved.FM_HOME && !saved.FM_HOME.startsWith(tmpdir())) roots.push(join(saved.FM_HOME, 'state', 'inbox'))
  const hits: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const file = join(root, name)
      let info: ReturnType<typeof statSync>
      try { info = statSync(file) } catch { continue }
      if (!info.isFile() || info.mtimeMs + 1000 < startedAt || info.size > 1_000_000) continue
      if (readFileSync(file, 'utf8').includes(token)) hits.push(file)
    }
  }
  return hits
}

async function renderShell(): Promise<void> {
  localStorage.clear()
  window.history.replaceState({}, '', '/?v6=1')
  ;(globalThis as Record<string, unknown>).__TINSTAR_API_BASE__ = base
  _resetApiBaseForTests()
  render(<App />)
  await waitFor(() => {
    expect(screen.getByTestId('worker-alpha')).toBeTruthy()
    expect(screen.getByTestId('worker-beta')).toBeTruthy()
  }, { timeout: 20_000 })
  expect(screen.getAllByTestId('fixture-label').length).toBeGreaterThan(0)
  expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
}

async function openThread(): Promise<void> {
  fireEvent.click(screen.getByTestId('board'))
  fireEvent.click(screen.getByTestId('worker-alpha'))
  fireEvent.click(screen.getByRole('button', { name: /Thread/ }))
}

describe('prove composed S0', () => {
  beforeAll(async () => {
    rememberEnv()
    for (const file of POLICY_FILES) {
      const hash = hashFile(file)
      if (hash) policyHash.set(file, hash)
    }
    home = mkdtempSync(join(tmpdir(), 'prove-s0-home-'))
    config = mkdtempSync(join(tmpdir(), 'prove-s0-config-'))
    if (hasTmux && hasBins) sockDir = mkdtempSync(join(tmpdir(), 'prove-s0-sock-'))
    mkdirSync(join(home, 'state'), { recursive: true })
    mkdirSync(join(home, 'data'), { recursive: true })
    writeFileSync(join(home, 'FIXTURE'), 'fixture\n')
    writeMeta('alpha', 'worker-a', 'alpha')
    writeMeta('beta', 'worker-b', 'beta')
    const stub = join(config, 'bin')
    mkdirSync(stub)
    writeFileSync(join(stub, 'quota-axi'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(stub, 'quota-axi'), 0o755)

    process.env.FM_HOME = home
    process.env.TINSTAR_V6_FM_HOME = home
    process.env.TINSTAR_CONFIG_HOME = config
    process.env.TINSTAR_V6_FIXTURE = '1'
    if (hasBins) process.env.FM_V6_BIN = binDir
    if (sockDir) {
      process.env.TINSTAR_V6_TMUX_SOCKET = socket
      process.env.TMUX_TMPDIR = sockDir
    }
    process.env.PATH = `${stub}${process.env.PATH ? `:${process.env.PATH}` : ''}`
    delete process.env.TMUX
    delete process.env.TMUX_PANE
    for (const key of ['FM_STATE_OVERRIDE', 'FM_DATA_OVERRIDE', 'FM_CONFIG_OVERRIDE', 'FM_PROJECTS_OVERRIDE', 'FM_ROOT_OVERRIDE', 'FM_TEST_HOME']) {
      delete process.env[key]
    }

    for (const name of ['worker-a', 'worker-b']) {
      if (DENIED.includes(name)) throw new Error(`refusing to create ${name}`)
    }
    if (!hasBins) return
    if (hasTmux) {
      execFileSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'worker-a', '-n', 'alpha'], { env: childEnv() })
      tmux('new-session', '-d', '-s', 'worker-b', '-n', 'beta')
      assertPrivate(listSessions())
    }

    views = new V6Views()
    setV6RouteDepsForTests({ views })
    v6ModuleHandlers()
    server = createServer((req, res) => {
      void (async () => {
        try {
          if (await handleWiredHttp(req, res)) return
          const handled = await handleV6Http(req, res)
          if (!handled && !res.headersSent) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('not found')
          }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: { message: err instanceof Error ? err.message : 'failed' } }))
          }
        }
      })()
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('listener has no port')
    expect(address.port).not.toBe(5280)
    expect(address.port).not.toBe(5281)
    expect(address.port).not.toBe(8932)
    base = `http://127.0.0.1:${address.port}`
  }, 60_000)

  liveIt('lists the two fixture workers from fm-fleet-snapshot', { bins: true }, async () => {
    const listed = await fetch(`${base}/api/v6/workers`)
    const text = await listed.text()
    const body = JSON.parse(text) as {
      ok: boolean
      data?: { workers: Array<{ id: string; fixture: boolean; source: string; spawnGen: string | null; endpoint: { target: string | null } }> }
    }
    expect(body.ok, text).toBe(true)
    expect(body.data?.workers.map(worker => worker.id)).toEqual(['alpha', 'beta'])
    for (const worker of body.data?.workers ?? []) {
      expect(worker.fixture).toBe(true)
      expect(worker.source).toBe('fm-fleet-snapshot')
      expect(worker.spawnGen).toBe('1')
    }
    expect(body.data?.workers[0]?.endpoint.target).toBe('worker-a:alpha')
    expect(body.data?.workers[1]?.endpoint.target).toBe('worker-b:beta')
    expect(text).not.toContain('fm-send')
  })

  afterAll(async () => {
    try { viewChild?.kill('SIGTERM') } catch { /* already gone */ }
    views?.close('alpha')
    views?.close('beta')
    setV6RouteDepsForTests(null)
    if (server) {
      const closer = server as Server & { closeAllConnections?: () => void }
      closer.closeAllConnections?.()
      await new Promise<void>(resolve => server?.close(() => resolve()))
    }
    if (sockDir) {
      try { tmux('kill-server') } catch { /* private socket already gone */ }
      try { execFileSync('tmux', ['-L', 'default', 'kill-server'], { env: childEnv(), stdio: 'ignore' }) } catch { /* no probe server */ }
    }
    if (home) rmSync(home, { recursive: true, force: true })
    if (config) rmSync(config, { recursive: true, force: true })
    if (sockDir) rmSync(sockDir, { recursive: true, force: true })
    delete (globalThis as Record<string, unknown>).__TINSTAR_API_BASE__
    _resetApiBaseForTests()
    restoreEnv()
  })

  liveIt('labels the fixture home, cycles with Ctrl+], and jumps straight to the board', { bins: true, tmux: true }, async () => {
    const alphaWindow = windowId('worker-a')
    const betaWindow = windowId('worker-b')
    await renderShell()
    expect(readFileSync(join(home, 'FIXTURE'), 'utf8')).toBe('fixture\n')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')
    expect(screen.getByTestId('back')).toBeDisabled()

    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true })
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')
    expect(screen.getByTestId('back')).toBeDisabled()
    expect(windowId('worker-a')).toBe(alphaWindow)
    expect(windowId('worker-b')).toBe(betaWindow)

    fireEvent.click(screen.getByTestId('board'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'portfolio')
    expect(screen.getByRole('heading', { name: 'Portfolio' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).toBeNull()
    expect(screen.getByTestId('back')).toBeEnabled()

    fireEvent.click(screen.getByTestId('worker-alpha'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
    expect(screen.queryByRole('heading', { name: 'Portfolio' })).toBeNull()

    fireEvent.click(screen.getByTestId('back'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'portfolio')
    fireEvent.click(screen.getByTestId('back'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    assertPrivate(listSessions())
  }, 40_000)

  liveIt('closes the v6view- attach and leaves both workers', { bins: true, tmux: true }, async () => {
    const alphaWindow = windowId('worker-a')
    const betaWindow = windowId('worker-b')
    await renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() => {
      const note = screen.queryByTestId('terminal-note')
      if (note?.textContent) throw new Error(note.textContent)
      expect(screen.getByTestId('terminal-alpha')).toBeTruthy()
    }, { timeout: 20_000 })
    const argv = views?.spawns.find(row => row.some(arg => arg.endsWith('tinstar-v6-view')))
    expect(argv, JSON.stringify(views?.spawns)).toBeTruthy()
    expect(argv!.join('\n')).not.toMatch(/fm-send|fm-spawn|bash/)
    expect(argv!.join('\n')).not.toMatch(/firstmate|serena-view|kd-live/)
    viewChild = attachView(argv!)
    let stderr = ''
    viewChild.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    await waitFor(() => {
      expect(listSessions().some(name => name.startsWith('v6view-')), stderr).toBe(true)
    }, { timeout: 10_000 })
    expect(listSessions().filter(name => name.startsWith('tsview-'))).toEqual([])
    assertPrivate(listSessions())

    fireEvent.click(screen.getByRole('button', { name: 'Close view' }))
    viewChild.kill('SIGTERM')
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-alpha')).toBeNull()
      const names = listSessions()
      expect(names).toContain('worker-a')
      expect(names).toContain('worker-b')
      expect(names.some(name => name.startsWith('v6view-'))).toBe(false)
    }, { timeout: 8_000 })
    expect(windowId('worker-a')).toBe(alphaWindow)
    expect(windowId('worker-b')).toBe(betaWindow)
    expect(readdirSync(join(home, 'state')).filter(name => name.endsWith('.meta')).sort()).toEqual(['alpha.meta', 'beta.meta'])
  }, 40_000)

  liveIt('shows the anchored inbox reply on the worker', { bins: true }, async () => {
    await renderShell()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: HELLO } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => {
      const status = screen.getByTestId('intent-status').textContent ?? ''
      expect(status).toMatch(/Queued|Not receivable/)
      expect(status).toContain('Not applied')
    }, { timeout: 20_000 })

    let note: NoteEnvelope | undefined
    await waitFor(() => {
      note = noteByText(HELLO)
      expect(note?.id).toBeTruthy()
    }, { timeout: 10_000 })
    expect(note?.kind).toBe('thread.message')
    expect(note?.anchor).toMatchObject({ type: 'worker', ids: ['alpha'] })
    expect(note?.body?.threadId).toBeUndefined()
    expect(join(home, 'state', 'inbox', `${note!.id}.note`).startsWith(home)).toBe(true)

    reply(note!.id, REPLY)
    expect(await screen.findByTestId('intent-reply', {}, { timeout: 8_000 })).toHaveTextContent(REPLY)
    expect(screen.getByText('Not applied')).toBeInTheDocument()
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
  }, 40_000)

  liveIt('shows a second thread turn on the same worker anchor', { bins: true }, async () => {
    await renderShell()
    fireEvent.click(screen.getByRole('button', { name: /Thread/ }))
    const form = screen.getByRole('form', { name: 'Context thread' })
    fireEvent.change(screen.getByLabelText('Message First Mate'), { target: { value: TURN_1 } })
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(TURN_1, {}, { timeout: 20_000 })).toBeInTheDocument()

    let first: NoteEnvelope | undefined
    await waitFor(() => {
      first = noteByText(TURN_1)
      expect(first?.id).toBeTruthy()
    })
    expect(first?.anchor).toMatchObject({ type: 'worker', ids: ['alpha'] })
    expect(first?.body?.threadId).toBeTruthy()
    reply(first!.id, REPLY_1)

    await openThread()
    expect(await screen.findByText(REPLY_1, {}, { timeout: 15_000 })).toBeInTheDocument()
    const again = screen.getByRole('form', { name: 'Context thread' })
    fireEvent.change(screen.getByLabelText('Message First Mate'), { target: { value: TURN_2 } })
    fireEvent.click(within(again).getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(TURN_2, {}, { timeout: 20_000 })).toBeInTheDocument()

    let second: NoteEnvelope | undefined
    await waitFor(() => {
      second = noteByText(TURN_2)
      expect(second?.id).toBeTruthy()
    })
    expect(second?.id).not.toBe(first?.id)
    expect(second?.requestId).not.toBe(first?.requestId)
    expect(second?.body?.threadId).toBe(first?.body?.threadId)
    expect(second?.body?.previousNoteId).toBe(first?.id)
    reply(second!.id, REPLY_2)

    await openThread()
    expect(await screen.findByText(REPLY_2, {}, { timeout: 15_000 })).toBeInTheDocument()
    expect(screen.getByText(REPLY_1)).toBeInTheDocument()
    expect(screen.getByText(TURN_1)).toBeInTheDocument()
    expect(screen.getByText(TURN_2)).toBeInTheDocument()
  }, 60_000)

  liveIt('does not spawn for launch and does not claim native supervision', { bins: true, tmux: true }, async () => {
    await renderShell()
    expect(screen.getByTestId('launch-unclaimed')).toHaveTextContent(T01_PROCESS_UNCLAIMED)
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'fixture-project' } })
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'do not spawn a worker' } })
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'fixture-worker' } })
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    expect(await screen.findByTestId('launch-result', {}, { timeout: 20_000 })).toHaveTextContent('unfinished')
    expect(screen.getByTestId('launch-result')).toHaveTextContent('No process was created')
    expect(readdirSync(join(home, 'state')).filter(name => name.endsWith('.meta')).sort()).toEqual(['alpha.meta', 'beta.meta'])
    const names = listSessions()
    expect(names).toContain('worker-a')
    expect(names).toContain('worker-b')
    expect(names).not.toContain('fixture-worker')
    assertPrivate(names)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/native desktop/i)
    expect(text).not.toMatch(/autonomous supervision/i)
    expect(text).not.toMatch(/proved a native/i)
  }, 40_000)

  it('keeps the labeled fixture home and policy bytes inside the temp boundary', () => {
    expect(home.startsWith(tmpdir())).toBe(true)
    expect(config.startsWith(tmpdir())).toBe(true)
    for (const root of [home, config, sockDir].filter(root => root.length > 0)) {
      expect(root.startsWith('/Users/wtg/repo/')).toBe(false)
      expect(root.startsWith(join(homedir(), '.config', 'tinstar'))).toBe(false)
      expect(root.startsWith('/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home')).toBe(false)
    }
    expect(readFileSync(join(home, 'FIXTURE'), 'utf8')).toBe('fixture\n')
    for (const [file, hash] of policyHash) {
      expect(hashFile(file)).toBe(hash)
    }
  })

  liveIt('keeps notes inside the fixture boundary', { bins: true }, () => {
    expect(existsSync(join(config, 'v6', 'projection.json'))).toBe(true)
    expect(existsSync(join(config, 'v6', 'threads.json'))).toBe(true)
    const notes = readNotes()
    expect(notes.length).toBeGreaterThanOrEqual(3)
    for (const token of TOKENS) {
      expect(outsideHits(token)).toEqual([])
      expect(treeHas(home, token), token).toBe(true)
    }
  })

  liveIt('keeps denied sessions off the private tmux socket', { bins: true, tmux: true }, () => {
    assertPrivate(listSessions())
  })
})
