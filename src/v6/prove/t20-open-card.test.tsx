/**
 * T20 — an already-open terminal must leave the card when a later poll shows
 * a replacement worker. The open-path cases live in t20-stale-endpoint on
 * feat/v-t20. This file starts from a live frame and then changes the poll.
 * Fixture descriptors only. The tmux and ttyd doubles never start a process.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerDescriptor } from '../contract/descriptor'
import { handleV6Http, setV6RouteDepsForTests } from '../../server/v6/shell/routes'
import { V6Views, type V6ViewDeps } from '../../server/v6/shell/views'
import { V6Shell } from '../shell/V6Shell'

interface FixtureWorker {
  id: string
  incarnation: string
  endpointId: string | null
}

const SHOWN: FixtureWorker = {
  id: 'alpha',
  incarnation: 'incarnation-1',
  endpointId: 'endpoint-old:alpha',
}

const REPLACEMENT: FixtureWorker = {
  id: 'alpha',
  incarnation: 'incarnation-2',
  endpointId: 'endpoint-old:alpha',
}

const MOVED: FixtureWorker = {
  id: 'alpha',
  incarnation: 'incarnation-2',
  endpointId: 'endpoint-new:alpha',
}

const UNRELATED: FixtureWorker = {
  id: 'beta',
  incarnation: 'incarnation-9',
  endpointId: 'endpoint-old:alpha',
}

interface TerminalCall {
  method: string
  url: string
  spawnGen: string | null
  target: string | null
}

function card(worker: FixtureWorker, project = 'fixture-project'): WorkerDescriptor {
  return {
    source: 'fm-fleet-snapshot',
    fixture: true,
    id: worker.id,
    spawnGen: worker.incarnation,
    project,
    worktree: { path: `/tmp/fixture-${worker.id}`, present: true },
    backend: 'tmux',
    endpoint: {
      target: worker.endpointId,
      exists: worker.endpointId !== null,
      agentAlive: 'alive',
      status: 'alive',
    },
    crewState: 'working',
    observedAt: '2026-09-25T12:00:00.000Z',
  }
}

function rawTask(worker: FixtureWorker): string {
  return JSON.stringify({
    id: worker.id,
    fixture: true,
    project: 'fresh-project',
    spawn_gen: worker.incarnation,
    backend: 'tmux',
    paths: { worktree: { path: `/tmp/fixture-${worker.id}`, present: true } },
    endpoint: {
      target: worker.endpointId,
      exists: worker.endpointId !== null,
      agent_alive: 'alive',
      status: 'alive',
    },
    current_state: { state: 'working', observed_at: '2026-09-25T12:00:00.000Z' },
    actions: { steer: 'bin/fm-send.sh must-not-leak' },
  })
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  child.kill = () => true
  return child
}

function viewDeps(tmuxCalls: string[][]): V6ViewDeps {
  return {
    tmux: async (socket, args) => {
      tmuxCalls.push([socket, ...args])
      return '@4 alpha\n'
    },
    spawnTtyd: () => fakeChild(),
    ttydRefusal: () => null,
    healthCheck: async () => true,
    claimPort: async () => 23120,
    releasePort: () => undefined,
  }
}

function nodeReq(method: string, url: string, body?: string): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage
  emitter.method = method
  emitter.url = url
  emitter.headers = body ? { 'content-type': 'application/json' } : {}
  process.nextTick(() => {
    if (body) emitter.emit('data', Buffer.from(body))
    emitter.emit('end')
  })
  return emitter
}

function nodeRes(): { response: ServerResponse; done: Promise<{ status: number; body: string }> } {
  let resolve: (value: { status: number; body: string }) => void = () => undefined
  const done = new Promise<{ status: number; body: string }>(resolveDone => {
    resolve = resolveDone
  })
  const response = {
    statusCode: 200,
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
      resolve({ status: this.statusCode, body: this.body })
      return this
    },
  }
  return { response: response as unknown as ServerResponse, done }
}

describe('T20 open card', () => {
  const previousSocket = process.env.TINSTAR_V6_TMUX_SOCKET
  let tmuxCalls: string[][] = []
  let views: V6Views
  let fresh: FixtureWorker | null = SHOWN
  let shown: WorkerDescriptor[] = [card(SHOWN)]
  let calls: TerminalCall[] = []

  afterEach(() => {
    cleanup()
    setV6RouteDepsForTests(null)
    vi.unstubAllGlobals()
    if (previousSocket === undefined) delete process.env.TINSTAR_V6_TMUX_SOCKET
    else process.env.TINSTAR_V6_TMUX_SOCKET = previousSocket
  })

  function install(): void {
    tmuxCalls = []
    calls = []
    views = new V6Views(viewDeps(tmuxCalls), '/opt/tinstar/bin/tinstar-v6-view')
    const home = mkdtempSync(join(tmpdir(), 'v6-t20b-'))
    process.env.TINSTAR_V6_TMUX_SOCKET = 't20bfixture'
    setV6RouteDepsForTests({
      views,
      projectionFile: join(home, 'projection.json'),
      home,
      configured: true,
      binDir: join(home, 'bin'),
      runner: {
        exec: async (_script, args) => {
          expect(args.join(' ')).not.toMatch(/fm-send|fm-spawn/)
          if (args[0] === '--task' && fresh && args[1] === fresh.id) {
            return { code: 0, stdout: rawTask(fresh), stderr: '' }
          }
          return { code: 1, stdout: '', stderr: '' }
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/api/v6/workers') && method === 'GET' && !url.includes('/terminal')) {
        return Response.json({
          ok: true,
          data: { configured: true, workers: shown, identities: {}, diagnostics: [] },
        })
      }
      if (url.includes('/api/v6/identity')) {
        return Response.json({ ok: true, data: { color: '#00f0ff' } })
      }
      if (url.includes('/terminal') && (method === 'POST' || method === 'DELETE')) {
        const bodyText = String(init?.body ?? '')
        const body = bodyText ? JSON.parse(bodyText) as { spawnGen?: string | null; target?: string | null } : {}
        calls.push({
          method,
          url,
          spawnGen: body.spawnGen ?? null,
          target: body.target ?? null,
        })
        const { response, done } = nodeRes()
        const pathname = new URL(url, 'http://127.0.0.1').pathname
        await handleV6Http(nodeReq(method, pathname, method === 'POST' ? bodyText : undefined), response)
        const result = await done
        expect(result.body).not.toContain('fm-send')
        expect(result.body).not.toContain('must-not-leak')
        expect(result.body).not.toContain('workerKilled":true')
        return new Response(result.body, {
          status: result.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return Response.json({ ok: false, error: { message: 'absent' } }, { status: 404 })
    }))
    render(<V6Shell pollMs={40} />)
  }

  async function openShownCard(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal' }))
    expect(await screen.findByTestId('terminal-alpha')).toBeInTheDocument()
    expect(views.portOf('alpha')).toBe(23120)
    expect(calls.filter(call => call.method === 'POST')).toEqual([
      expect.objectContaining({ spawnGen: 'incarnation-1', target: 'endpoint-old:alpha' }),
    ])
  }

  function expectNoReplacementAttach(): void {
    expect(screen.queryByTestId('terminal-alpha')).toBeNull()
    expect(screen.queryByTestId('terminal-beta')).toBeNull()
    expect(screen.getByTestId('terminal-note')).toHaveTextContent(/changed|unavailable|reconnect/i)
    expect(screen.getByTestId('open-terminal')).toBeInTheDocument()
    expect(calls.filter(call => call.method === 'POST' && (call.spawnGen === 'incarnation-2' || call.target === 'endpoint-new:alpha'))).toEqual([])
    expect(calls.filter(call => call.url.includes('/beta/'))).toEqual([])
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.url).join(' ')).toContain('/alpha/')
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.url).join(' ')).not.toContain('/beta/')
    expect(tmuxCalls.filter(call => call.join(' ').includes('endpoint-new'))).toEqual([])
    expect(tmuxCalls.filter(call => call.join(' ').includes('beta'))).toEqual([])
    expect(views.portOf('alpha')).toBeNull()
    expect(views.portOf('beta')).toBeNull()
    expect(views.spawns.some(argv => argv.join('\n').includes('endpoint-new'))).toBe(false)
    expect(views.spawns.some(argv => argv.join('\n').includes('incarnation-2'))).toBe(false)
    expect(views.spawns.join('\n')).not.toMatch(/fm-send|fm-spawn|bash/)
    expect(views.spawns.join('\n')).not.toMatch(/5280|5281/)
  }

  it('clears an open terminal when a later poll replaces the worker on the same endpoint', async () => {
    fresh = SHOWN
    shown = [card(SHOWN)]
    install()
    await openShownCard()
    const spawnsAtOpen = views.spawns.length
    const tmuxAtOpen = tmuxCalls.length
    expect(spawnsAtOpen).toBeGreaterThan(0)

    fresh = REPLACEMENT
    shown = [card(REPLACEMENT, 'replaced-project'), card(UNRELATED)]
    await waitFor(() => {
      expect(screen.getAllByText(/replaced-project/).length).toBeGreaterThan(0)
      expectNoReplacementAttach()
    })
    await new Promise(resolve => setTimeout(resolve, 90))
    expectNoReplacementAttach()
    expect(views.spawns).toHaveLength(spawnsAtOpen)
    expect(tmuxCalls).toHaveLength(tmuxAtOpen)
    expect(screen.getAllByTestId('fixture-label').length).toBeGreaterThan(0)
  })

  it('clears an open terminal when a later poll moves the endpoint onto a replacement', async () => {
    fresh = SHOWN
    shown = [card(SHOWN)]
    install()
    await openShownCard()
    const spawnsAtOpen = views.spawns.length

    fresh = MOVED
    shown = [card(MOVED, 'moved-project'), card(UNRELATED)]
    await waitFor(() => {
      expect(screen.getAllByText(/moved-project/).length).toBeGreaterThan(0)
      expectNoReplacementAttach()
    })
    await new Promise(resolve => setTimeout(resolve, 90))
    expectNoReplacementAttach()
    expect(views.spawns).toHaveLength(spawnsAtOpen)
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('keeps the open terminal when a later poll only changes the project text', async () => {
    fresh = SHOWN
    shown = [card(SHOWN)]
    install()
    await openShownCard()

    shown = [card(SHOWN, 'same-worker-project')]
    await waitFor(() => {
      expect(screen.getAllByText(/same-worker-project/).length).toBeGreaterThan(0)
    })
    await new Promise(resolve => setTimeout(resolve, 90))
    expect(screen.getByTestId('terminal-alpha')).toBeInTheDocument()
    expect(screen.queryByTestId('terminal-note')).toBeNull()
    expect(screen.queryByTestId('open-terminal')).toBeNull()
    expect(views.portOf('alpha')).toBe(23120)
    expect(calls.filter(call => call.method === 'DELETE')).toEqual([])
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(views.spawns.join('\n')).not.toMatch(/5280|5281/)
  })
})
