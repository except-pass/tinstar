/**
 * T20 — a card bound to one incarnation and endpoint must not attach to a
 * replacement or to another worker that reused that endpoint.
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
  incarnation: 'incarnation-1',
  endpointId: 'endpoint-new:alpha',
}

const UNRELATED: FixtureWorker = {
  id: 'beta',
  incarnation: 'incarnation-9',
  endpointId: 'endpoint-old:alpha',
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

describe('T20 stale endpoint', () => {
  const previousSocket = process.env.TINSTAR_V6_TMUX_SOCKET
  let tmuxCalls: string[][] = []
  let views: V6Views
  let fresh: FixtureWorker | null = SHOWN
  let shown: WorkerDescriptor[] = [card(SHOWN)]
  let posts: Array<{ url: string; spawnGen: string | null; target: string | null }> = []

  afterEach(() => {
    cleanup()
    setV6RouteDepsForTests(null)
    vi.unstubAllGlobals()
    if (previousSocket === undefined) delete process.env.TINSTAR_V6_TMUX_SOCKET
    else process.env.TINSTAR_V6_TMUX_SOCKET = previousSocket
  })

  function install(pollMs = 60_000): void {
    tmuxCalls = []
    posts = []
    views = new V6Views(viewDeps(tmuxCalls), '/opt/tinstar/bin/tinstar-v6-view')
    const home = mkdtempSync(join(tmpdir(), 'v6-t20-'))
    process.env.TINSTAR_V6_TMUX_SOCKET = 't20fixture'
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
      if (url.includes('/api/v6/workers') && method === 'GET') {
        return Response.json({
          ok: true,
          data: { configured: true, workers: shown, identities: {}, diagnostics: [] },
        })
      }
      if (url.includes('/api/v6/identity')) {
        return Response.json({ ok: true, data: { color: '#00f0ff' } })
      }
      if (url.includes('/terminal') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { spawnGen?: string | null; target?: string | null }
        posts.push({
          url,
          spawnGen: body.spawnGen ?? null,
          target: body.target ?? null,
        })
        const { response, done } = nodeRes()
        await handleV6Http(nodeReq('POST', new URL(url, 'http://127.0.0.1').pathname, String(init?.body ?? '')), response)
        const result = await done
        expect(result.body).not.toContain('fm-send')
        expect(result.body).not.toContain('must-not-leak')
        return new Response(result.body, {
          status: result.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return Response.json({ ok: false, error: { message: 'absent' } }, { status: 404 })
    }))
    render(<V6Shell pollMs={pollMs} />)
  }

  async function openShownCard(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal' }))
  }

  it('does not attach when a replacement reuses the endpoint id', async () => {
    fresh = REPLACEMENT
    shown = [card(SHOWN), card(UNRELATED)]
    install()
    await openShownCard()

    expect(await screen.findByTestId('terminal-note')).toHaveTextContent('worker changed or is unavailable')
    expect(screen.queryByTestId('terminal-alpha')).toBeNull()
    expect(screen.queryByTestId('terminal-beta')).toBeNull()
    expect(posts).toEqual([
      { url: expect.stringContaining('/api/v6/workers/alpha/terminal'), spawnGen: 'incarnation-1', target: 'endpoint-old:alpha' },
    ])
    expect(posts[0]?.url).not.toContain('/beta/')
    expect(tmuxCalls).toEqual([])
    expect(views.spawns).toEqual([])
    expect(screen.getAllByTestId('fixture-label').length).toBeGreaterThan(0)
  })

  it('does not attach when the endpoint id on the fresh worker differs from the card', async () => {
    fresh = MOVED
    shown = [card(SHOWN)]
    install()
    await openShownCard()

    expect(await screen.findByTestId('terminal-note')).toHaveTextContent('worker changed or is unavailable')
    expect(screen.queryByTestId('terminal-alpha')).toBeNull()
    expect(posts).toEqual([
      expect.objectContaining({ spawnGen: 'incarnation-1', target: 'endpoint-old:alpha' }),
    ])
    expect(tmuxCalls).toEqual([])
    expect(views.spawns).toEqual([])
  })

  it('does not attach the old card when that worker is gone and another worker holds its endpoint', async () => {
    fresh = null
    shown = [card(SHOWN), card(UNRELATED)]
    install()
    await openShownCard()

    const note = await screen.findByTestId('terminal-note')
    expect(note.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(screen.queryByTestId('terminal-alpha')).toBeNull()
    expect(screen.queryByTestId('terminal-beta')).toBeNull()
    expect(posts).toEqual([
      expect.objectContaining({ spawnGen: 'incarnation-1', target: 'endpoint-old:alpha' }),
    ])
    expect(posts.map(post => post.url).join(' ')).not.toContain('/beta/')
    expect(tmuxCalls).toEqual([])
    expect(views.spawns).toEqual([])
  })

  it('shows the terminal as unavailable when the endpoint id is missing', async () => {
    const missing: FixtureWorker = { ...SHOWN, endpointId: null }
    fresh = missing
    shown = [card(missing)]
    install()
    await openShownCard()

    expect(await screen.findByTestId('terminal-note')).toHaveTextContent('terminal target is unavailable')
    expect(screen.queryByTestId('terminal-alpha')).toBeNull()
    expect(tmuxCalls).toEqual([])
    expect(views.spawns).toEqual([])
  })

  it('attaches only when the fresh incarnation and endpoint id still match the card', async () => {
    fresh = SHOWN
    shown = [card(SHOWN), card({ ...UNRELATED, endpointId: 'endpoint-beta:beta' })]
    install()
    await openShownCard()

    expect(await screen.findByTestId('terminal-alpha')).toBeInTheDocument()
    expect(screen.queryByTestId('terminal-beta')).toBeNull()
    expect(screen.queryByTestId('terminal-note')).toBeNull()
    expect(posts).toEqual([
      expect.objectContaining({ spawnGen: 'incarnation-1', target: 'endpoint-old:alpha' }),
    ])
    expect(tmuxCalls.some(call => call.includes('=endpoint-old'))).toBe(true)
    expect(tmuxCalls.some(call => call.join(' ').includes('beta'))).toBe(false)
    expect(views.spawns.some(argv => argv.includes('endpoint-old'))).toBe(true)
    expect(views.spawns.some(argv => argv.join('\n').includes('endpoint-beta'))).toBe(false)
    expect(views.spawns.join('\n')).not.toMatch(/fm-send|fm-spawn|bash/)
    expect(views.spawns.join('\n')).not.toMatch(/5280|5281/)
  })

  it('does not open a replacement over a card that was already attached', async () => {
    fresh = SHOWN
    shown = [card(SHOWN)]
    install(40)
    await openShownCard()
    expect(await screen.findByTestId('terminal-alpha')).toBeInTheDocument()

    const replacement: FixtureWorker = { ...REPLACEMENT, endpointId: 'endpoint-new:alpha' }
    fresh = replacement
    shown = [card(replacement, 'unrelated-project'), card(UNRELATED)]
    await waitFor(() => {
      expect(screen.getAllByText(/unrelated-project/).length).toBeGreaterThan(0)
    })

    expect(screen.queryByTestId('terminal-beta')).toBeNull()
    expect(posts.filter(post => post.spawnGen === 'incarnation-2' || post.target === 'endpoint-new:alpha')).toEqual([])
    expect(posts.filter(post => post.url.includes('/beta/'))).toEqual([])
    expect(tmuxCalls.filter(call => call.join(' ').includes('endpoint-new'))).toEqual([])
    expect(views.spawns.some(argv => argv.join('\n').includes('endpoint-new'))).toBe(false)
    expect(views.spawns.some(argv => argv.join('\n').includes('incarnation-2'))).toBe(false)
  })
})
