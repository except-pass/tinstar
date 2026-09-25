import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkerDescriptor } from '../../../../v6/contract/descriptor'
import { TERMINAL_AUTH_HEADER } from '../../../sessionProxy'
import type { CommandResult, FmCommandRunner } from '../fmExec'
import { handleV6Http, setV6RouteDepsForTests } from '../routes'
import { sessionNameRefusal } from '../sessionGuard'
import { descriptorChanged, upgradeOriginAllowed, v6ViewTtydArgv, V6Views, type V6ViewDeps } from '../views'

const worker: WorkerDescriptor = {
  source: 'fm-fleet-snapshot',
  fixture: true,
  id: 'alpha',
  spawnGen: '1',
  project: 'tinstar',
  worktree: { path: '/tmp/alpha', present: true },
  backend: 'tmux',
  endpoint: { target: 'worker-a:alpha', exists: true, agentAlive: 'alive', status: 'alive' },
  crewState: 'working',
  observedAt: '2026-09-24T04:00:00Z',
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  child.kill = () => true
  return child
}

function deps(tmuxCalls: string[][]): V6ViewDeps {
  return {
    tmux: async (socket, args) => {
      tmuxCalls.push([socket, ...args])
      return '@4 alpha\n'
    },
    spawnTtyd: () => fakeChild(),
    ttydRefusal: () => null,
    healthCheck: async () => true,
    claimPort: async () => 23111,
    releasePort: () => undefined,
  }
}

function req(method: string, url: string, body?: unknown): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage
  emitter.method = method
  emitter.url = url
  emitter.headers = { 'content-type': 'application/json' }
  process.nextTick(() => {
    if (body !== undefined) emitter.emit('data', Buffer.from(JSON.stringify(body)))
    emitter.emit('end')
  })
  return emitter
}

function res() {
  const response = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      this.statusCode = status
      this.headersSent = true
      return this
    },
    end(payload?: string) {
      this.body = payload ?? ''
      this.writableEnded = true
      return this
    },
  }
  return response as unknown as ServerResponse & { statusCode: number; body: string }
}

describe('v6 terminal view', () => {
  it('refuses protected session names and builds a fixed ttyd argv', () => {
    for (const name of ['firstmate', 'serena-view', 'kd-live', 'tsview-old', 'v6view-old', 'v6', 'ts']) {
      expect(sessionNameRefusal(name)).toBeTruthy()
    }
    expect(sessionNameRefusal('worker-a')).toBeNull()
    const argv = v6ViewTtydArgv({
      port: 23111,
      bind: '127.0.0.1',
      script: '/opt/tinstar/bin/tinstar-v6-view',
      socket: 'tsv6test',
      session: 'worker-a',
      windowId: '@4',
      windowName: 'alpha',
    })
    expect(argv).toEqual(expect.arrayContaining(['-i', '127.0.0.1', '-H', TERMINAL_AUTH_HEADER, '-p', '23111']))
    expect(argv).toContain('/opt/tinstar/bin/tinstar-v6-view')
    expect(argv.join('\n')).not.toMatch(/bash|-c|fm-send|fm-spawn/)
    expect(upgradeOriginAllowed('http://evil.example')).toBe(false)
    expect(upgradeOriginAllowed(undefined)).toBe(true)
    expect(descriptorChanged({ spawnGen: '1', target: 'worker-a:alpha' }, { ...worker, spawnGen: '2' })).toBe(true)
  })

  it('does not attach when spawn_gen changes and does not kill the worker on close', async () => {
    const tmuxCalls: string[][] = []
    const views = new V6Views(deps(tmuxCalls), '/opt/tinstar/bin/tinstar-v6-view')
    const file = join(mkdtempSync(join(tmpdir(), 'v6-routes-')), 'projection.json')
    const opened: string[] = []
    const runner: FmCommandRunner = {
      exec: async (_script, args) => {
        opened.push(args.join(' '))
        if (args[0] === '--task') {
          return {
            code: 0,
            stdout: JSON.stringify({
              id: 'alpha',
              fixture: true,
              project: 'tinstar',
              spawn_gen: '2',
              backend: 'tmux',
              paths: { worktree: { path: '/tmp/alpha', present: true } },
              endpoint: { target: 'worker-a:alpha', exists: true, agent_alive: 'alive', status: 'alive' },
              current_state: { state: 'working', observed_at: '2026-09-24T04:00:00Z' },
              actions: { steer: 'bin/fm-send.sh fm-alpha' },
            }),
            stderr: '',
          } satisfies CommandResult
        }
        return { code: 0, stdout: '{}', stderr: '' }
      },
    }
    const previousSocket = process.env.TINSTAR_V6_TMUX_SOCKET
    process.env.TINSTAR_V6_TMUX_SOCKET = 'tsv6test'
    setV6RouteDepsForTests({
      views,
      runner,
      projectionFile: file,
      home: '/tmp/v6-home',
      configured: true,
      binDir: '/tmp/v6-bin',
    })
    const response = res()
    await handleV6Http(req('POST', '/api/v6/workers/alpha/terminal', { spawnGen: '1', target: 'worker-a:alpha' }), response)
    const body = JSON.parse(response.body) as { data: { state: string; reason: string } }
    expect(body.data.state).toBe('unavailable')
    expect(body.data.reason).toMatch(/changed/)
    expect(tmuxCalls).toEqual([])
    expect(views.spawns).toEqual([])
    expect(opened.join(' ')).toContain('--task alpha')
    expect(opened.join(' ')).not.toContain('fm-send')

    const same = res()
    await handleV6Http(req('POST', '/api/v6/workers/alpha/terminal', { spawnGen: '2', target: 'worker-a:alpha' }), same)
    expect(JSON.parse(same.body).data.state).toBe('live')
    expect(tmuxCalls.some(call => call.includes('kill-session'))).toBe(false)
    expect(tmuxCalls.some(call => call.includes('send-keys'))).toBe(false)
    const closed = res()
    await handleV6Http(req('DELETE', '/api/v6/workers/alpha/terminal'), closed)
    expect(JSON.parse(closed.body).data).toMatchObject({ closed: true, workerKilled: false })
    expect(tmuxCalls.some(call => call.includes('kill-session'))).toBe(false)
    setV6RouteDepsForTests(null)
    if (previousSocket === undefined) delete process.env.TINSTAR_V6_TMUX_SOCKET
    else process.env.TINSTAR_V6_TMUX_SOCKET = previousSocket
  })

  it('does not kill the worker on reload or when a second view is open', async () => {
    const tmuxCalls: string[][] = []
    const ttydKilled: string[] = []
    let nextPort = 23120
    const views = new V6Views({
      tmux: async (socket, args) => {
        tmuxCalls.push([socket, ...args])
        const targetAt = args.indexOf('-t')
        const target = targetAt >= 0 ? args[targetAt + 1] ?? '' : ''
        if (target.includes('worker-b')) return '@5 beta\n'
        return '@4 alpha\n'
      },
      spawnTtyd: () => {
        const child = new EventEmitter() as ChildProcess
        child.kill = ((signal?: NodeJS.Signals) => {
          ttydKilled.push(signal ?? '')
          return true
        }) as ChildProcess['kill']
        return child
      },
      ttydRefusal: () => null,
      healthCheck: async () => true,
      claimPort: async () => {
        const port = nextPort
        nextPort += 1
        return port
      },
      releasePort: () => undefined,
    }, '/opt/tinstar/bin/tinstar-v6-view')
    const commands: string[] = []
    const runner: FmCommandRunner = {
      exec: async (_script, args) => {
        commands.push(args.join(' '))
        const id = args[1]
        if (args[0] !== '--task' || (id !== 'alpha' && id !== 'beta')) {
          return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
        }
        const session = id === 'alpha' ? 'worker-a' : 'worker-b'
        return {
          code: 0,
          stdout: JSON.stringify({
            id,
            fixture: true,
            project: 'tinstar',
            spawn_gen: '1',
            backend: 'tmux',
            paths: { worktree: { path: `/tmp/${id}`, present: true } },
            endpoint: { target: `${session}:${id}`, exists: true, agent_alive: 'alive', status: 'alive' },
            current_state: { state: 'working', observed_at: '2026-09-24T04:00:00Z' },
            actions: { steer: `bin/fm-send.sh fm-${id}` },
          }),
          stderr: '',
        } satisfies CommandResult
      },
    }
    const previousSocket = process.env.TINSTAR_V6_TMUX_SOCKET
    process.env.TINSTAR_V6_TMUX_SOCKET = 'tsv6test'
    const file = join(mkdtempSync(join(tmpdir(), 'v6-views-')), 'projection.json')
    setV6RouteDepsForTests({
      views,
      runner,
      projectionFile: file,
      home: '/tmp/v6-home',
      configured: true,
      binDir: '/tmp/v6-bin',
    })
    try {
      const opened = res()
      await handleV6Http(req('POST', '/api/v6/workers/alpha/terminal', { spawnGen: '1', target: 'worker-a:alpha' }), opened)
      const first = JSON.parse(opened.body).data as { state: string; port: number }
      expect(first.state).toBe('live')
      expect(first.port).toBe(23120)
      const spawnsAfterOpen = views.spawns.length
      expect(spawnsAfterOpen).toBeGreaterThan(0)

      const reloaded = res()
      await handleV6Http(req('POST', '/api/v6/workers/alpha/terminal', { spawnGen: '1', target: 'worker-a:alpha' }), reloaded)
      const reloadBody = JSON.parse(reloaded.body).data as { state: string; port: number }
      expect(reloadBody).toEqual({ state: 'live', port: first.port })
      expect(views.portOf('alpha')).toBe(first.port)
      expect(views.spawns.length).toBe(spawnsAfterOpen)
      expect(ttydKilled).toEqual([])

      const second = res()
      await handleV6Http(req('POST', '/api/v6/workers/beta/terminal', { spawnGen: '1', target: 'worker-b:beta' }), second)
      const secondBody = JSON.parse(second.body).data as { state: string; port: number }
      expect(secondBody.state).toBe('live')
      expect(secondBody.port).not.toBe(first.port)
      expect(views.portOf('alpha')).toBe(first.port)
      expect(views.portOf('beta')).toBe(secondBody.port)
      expect(views.spawns.length).toBeGreaterThan(spawnsAfterOpen)
      expect(ttydKilled).toEqual([])

      expect(tmuxCalls).toEqual([
        ['tsv6test', 'list-windows', '-t', '=worker-a', '-F', '#{window_id} #{window_name}'],
        ['tsv6test', 'list-windows', '-t', '=worker-a', '-F', '#{window_id} #{window_name}'],
        ['tsv6test', 'list-windows', '-t', '=worker-b', '-F', '#{window_id} #{window_name}'],
      ])
      const tmuxText = tmuxCalls.map(call => call.join(' ')).join('\n')
      expect(tmuxText).not.toMatch(/kill-session|kill-window|kill-server|send-keys/)
      expect(tmuxText).not.toMatch(/firstmate|serena-view|kd-live/)
      expect(tmuxText).not.toContain('/tmp/alpha')
      expect(tmuxText).not.toContain('/tmp/beta')
      expect(commands).toEqual(['--task alpha --json', '--task alpha --json', '--task beta --json'])
      expect(commands.join(' ')).not.toMatch(/fm-spawn|fm-send/)
      expect(opened.body).not.toContain('fm-send')
      expect(second.body).not.toContain('fm-send')

      const closedAlpha = res()
      await handleV6Http(req('DELETE', '/api/v6/workers/alpha/terminal'), closedAlpha)
      expect(JSON.parse(closedAlpha.body).data).toMatchObject({ closed: true, workerKilled: false })
      expect(views.portOf('alpha')).toBeNull()
      expect(views.portOf('beta')).toBe(secondBody.port)
      const closedBeta = res()
      await handleV6Http(req('DELETE', '/api/v6/workers/beta/terminal'), closedBeta)
      expect(JSON.parse(closedBeta.body).data).toMatchObject({ closed: true, workerKilled: false })
      expect(tmuxCalls.map(call => call.join(' ')).join('\n')).toBe(tmuxText)
      expect(ttydKilled.every(signal => signal === 'SIGTERM')).toBe(true)
      expect(ttydKilled.length).toBe(views.spawns.length)
    } finally {
      setV6RouteDepsForTests(null)
      if (previousSocket === undefined) delete process.env.TINSTAR_V6_TMUX_SOCKET
      else process.env.TINSTAR_V6_TMUX_SOCKET = previousSocket
    }
  })

  it('serves descriptors without steer strings', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'v6-list-')), 'projection.json')
    const runner: FmCommandRunner = {
      exec: async (_script, args) => {
        if (args[0] === '--task' && args[1] === 'alpha') {
          return {
            code: 0,
            stdout: JSON.stringify({
              id: 'alpha',
              fixture: true,
              project: 'tinstar',
              spawn_gen: '1',
              backend: 'tmux',
              paths: { worktree: { path: '/tmp/alpha', present: true } },
              endpoint: { target: 'worker-a:alpha', exists: true, agent_alive: 'alive', status: 'alive' },
              current_state: { state: 'working', observed_at: '2026-09-24T04:00:00Z' },
              actions: { steer: "bin/fm-send.sh fm-alpha '<instruction>'" },
              hints: { last_event_text: 'raw status' },
            }),
            stderr: '',
          }
        }
        return { code: 1, stdout: '', stderr: 'missing' }
      },
    }
    setV6RouteDepsForTests({
      views: new V6Views(deps([]), '/opt/tinstar/bin/tinstar-v6-view'),
      runner,
      projectionFile: file,
      home: join(mkdtempSync(join(tmpdir(), 'v6-home-')), 'home'),
      configured: true,
      binDir: '/tmp/v6-bin',
    })
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const home = join(mkdtempSync(join(tmpdir(), 'v6-meta-')), 'state')
    mkdirSync(home)
    writeFileSync(join(home, 'alpha.meta'), 'id=alpha\n')
    setV6RouteDepsForTests({
      views: new V6Views(deps([]), '/opt/tinstar/bin/tinstar-v6-view'),
      runner,
      projectionFile: file,
      home: join(home, '..'),
      configured: true,
      binDir: '/tmp/v6-bin',
    })
    const response = res()
    await handleV6Http(req('GET', '/api/v6/workers'), response)
    expect(response.body).not.toContain('fm-send')
    expect(response.body).not.toContain('actions')
    expect(response.body).toContain('fixture')
    expect(response.body).toContain('"crewState":"working"')
    setV6RouteDepsForTests(null)
  })
})
