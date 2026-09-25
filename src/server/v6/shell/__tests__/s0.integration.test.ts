import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseWorkerDescriptor } from '../../../../v6/contract/descriptor'
import { cycleSelection, jumpBoard } from '../../../../v6/shell/navigation'
import { readReceipts, submitIntent } from '../submitIntent'
import { listWorkerDescriptors } from '../snapshot'

const snapshotBin = process.env.FM_V6_BIN
  ?? '/Users/wtg/.local/state/pm-build/tinstar-v6/worktrees/fm-boundary/bin/fm-fleet-snapshot.sh'
const binDir = snapshotBin.endsWith('.sh') ? dirname(snapshotBin) : snapshotBin
const script = join(process.cwd(), 'bin/tinstar-v6-view')

function meta(id: string, session: string, window: string): string {
  return [
    'spawn_gen=1',
    'project=fixture-project',
    'backend=tmux',
    `window=${session}:${window}`,
    `worktree=/tmp/v6-s0-${id}`,
    'kind=ship',
    '',
  ].join('\n')
}

describe('S0 integrated temp home', () => {
  const previous = {
    FM_HOME: process.env.FM_HOME,
    TMUX: process.env.TMUX,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    TINSTAR_V6_FIXTURE: process.env.TINSTAR_V6_FIXTURE,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('lists real --task descriptors, keeps the private window, and shows the inbox reply', async () => {
    const home = mkdtempSync(join(tmpdir(), 'v6-s0-home-'))
    const sockDir = mkdtempSync(join(tmpdir(), 'v6-s0-sock-'))
    const projection = join(mkdtempSync(join(tmpdir(), 'v6-s0-proj-')), 'projection.json')
    const socket = `tsv6s0${process.pid}`
    mkdirSync(join(home, 'state'))
    mkdirSync(join(home, 'data'))
    writeFileSync(join(home, 'state', 'alpha.meta'), meta('alpha', 'worker-a', 'alpha'))
    writeFileSync(join(home, 'state', 'beta.meta'), meta('beta', 'worker-b', 'beta'))
    const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: sockDir, FM_HOME: home }
    delete env.TMUX
    process.env.TMUX_TMPDIR = sockDir
    delete process.env.TMUX
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8' })
    try {
      tmux('new-session', '-d', '-s', 'worker-a', '-n', 'alpha')
      tmux('new-session', '-d', '-s', 'worker-b', '-n', 'beta')
      const list = await listWorkerDescriptors({
        home,
        configured: true,
        binDir,
        fixture: true,
      })
      expect(list.workers.map(worker => worker.id)).toEqual(['alpha', 'beta'])
      for (const worker of list.workers) {
        expect(worker.fixture).toBe(true)
        expect(worker.source).toBe('fm-fleet-snapshot')
        expect(worker.spawnGen).toBe('1')
        expect(JSON.stringify(worker)).not.toContain('fm-send')
      }
      expect(list.workers[0]?.endpoint.target).toBe('worker-a:alpha')

      const nav = jumpBoard(cycleSelection(
        { selectedWorkerId: 'alpha', history: { current: { kind: 'worker', id: 'alpha' }, past: [] } },
        list.workers.map(worker => worker.id),
        1,
      ))
      expect(nav.selectedWorkerId).toBe('beta')
      expect(nav.history.current.kind).toBe('portfolio')
      expect(nav.history.past).toEqual([{ kind: 'worker', id: 'beta' }])

      const alphaWindow = tmux('list-windows', '-t', '=worker-a', '-F', '#{window_id} #{window_name}').trim().split(' ')
      const view = spawn(script, [socket, 'worker-a', alphaWindow[0]!, alphaWindow[1]!], {
        env: { ...env, TINSTAR_V6_VIEW_DIE_SLEEP: '0' },
        stdio: 'ignore',
      })
      let sessions = ''
      for (let i = 0; i < 30; i++) {
        sessions = tmux('list-sessions', '-F', '#{session_name}')
        if (sessions.includes('v6view-')) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(sessions).toContain('v6view-')
      view.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 200))
      const surviving = tmux('list-sessions', '-F', '#{session_name}')
      expect(surviving).toContain('worker-a')
      expect(surviving).toContain('worker-b')

      const submission = await submitIntent({
        schema: 'tinstar.v6.intent/1',
        kind: 'thread.message',
        requestId: 'req-s0-alpha',
        revision: null,
        anchor: { type: 'worker', ids: ['alpha'] },
        body: { text: 'hello from the shell' },
      }, { home, binDir, projectionFile: projection })
      expect(submission.applied).toBe(false)
      expect(submission.noteId).toBeTruthy()
      expect(submission.disposition === 'queued' || submission.disposition === 'not-receivable').toBe(true)
      expect(submission.canReceive).not.toBe(true)

      execFileSync(
        join(binDir, 'fm-inbox.sh'),
        ['reply', '--json', submission.noteId!, 'captain read the worker note'],
        { env, encoding: 'utf8' },
      )
      const { reply } = await readReceipts({ home, binDir }, 'req-s0-alpha')
      expect(reply?.body).toBe('captain read the worker note')
      expect(reply?.requestId).toBe('req-s0-alpha')
      expect(reply?.appliedOutcome).toBeNull()
    } finally {
      try { tmux('kill-server') } catch { /* private socket */ }
      try {
        execFileSync('tmux', ['-L', 'default', 'kill-server'], { env, stdio: 'ignore' })
      } catch { /* probe server was not started */ }
      rmSync(home, { recursive: true, force: true })
      rmSync(sockDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('still labels a hand-built JSON fixture as a fixture', () => {
    const parsed = parseWorkerDescriptor({
      id: 'alpha',
      fixture: true,
      project: 'demo',
      spawn_gen: '1',
      backend: 'tmux',
      paths: { worktree: { path: '/tmp/alpha', present: true } },
      endpoint: { target: 'sess:alpha', exists: true, agent_alive: 'alive', status: 'alive' },
      current_state: { state: 'working', observed_at: '2026-09-24T04:00:00Z' },
    })
    expect(parsed.ok && parsed.value.fixture).toBe(true)
  })
})
