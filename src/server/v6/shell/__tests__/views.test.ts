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
