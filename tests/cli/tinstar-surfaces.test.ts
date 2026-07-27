// @vitest-environment node
//
// `tinstar surfaces` — the CLI half of the plan's Agent-Native Action Parity
// table ("any action a human can take, an agent can take through the API or
// CLI").
//
// Two layers, deliberately:
//   · `buildRequest` is pure, so the argv → HTTP mapping is asserted directly and
//     a subcommand that quietly stopped sending a field is caught here;
//   · the second block runs the REAL `run()` against a REAL route server over a
//     real socket, with `TINSTAR_API_BASE` pointed at it. That is what proves the
//     plan's scenario "CLI commands and HTTP primitives report the same conflict
//     and recovery states" — a mocked transport would only prove the CLI agrees
//     with the mock.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
// The CLI is plain JS by design (it runs from `bin/` with no build step), so the
// imports are typed structurally here rather than by a `.d.ts` nobody would keep
// in sync.
import * as cli from '../../bin/tinstar/commands/surfaces.js'
const buildRequest = cli.buildRequest as (argv: string[]) => { method: string; path: string; body?: Record<string, unknown> }
const renderSuccess = cli.renderSuccess as (sub: string, data: unknown) => string
const renderFailure = cli.renderFailure as (error: unknown) => string
const run = cli.run as (argv: string[]) => Promise<void>
import { handleRequest, type RouteContext } from '../../src/server/api/routes'
import { DocumentStore } from '../../src/server/stores/document-store'

const SPACE = 'spc-a'

/** argv as the CLI sees it: node, script, command, subcommand, ... */
function argv(...rest: string[]): string[] {
  return ['node', 'tinstar', 'surfaces', ...rest]
}

describe('buildRequest', () => {
  it('maps every read to its endpoint', () => {
    expect(buildRequest(argv('list'))).toEqual({ method: 'GET', path: '/api/surfaces' })
    expect(buildRequest(argv('list', '--space', SPACE, '--deleted')))
      .toEqual({ method: 'GET', path: '/api/surfaces?spaceId=spc-a&includeDeleted=true' })
    expect(buildRequest(argv('get', 'sf-1'))).toEqual({ method: 'GET', path: '/api/surfaces/sf-1' })
    expect(buildRequest(argv('context', 'sf-1'))).toEqual({ method: 'GET', path: '/api/surfaces/sf-1/context' })
    expect(buildRequest(argv('contributors', 'sf-1')))
      .toEqual({ method: 'GET', path: '/api/surfaces/sf-1/contributors' })
  })

  it('builds a create body with provenance only when a run or worktree is given', () => {
    expect(buildRequest(argv('create', '--space', SPACE, '--home', 'canvas', '--headline', 'hi'))).toEqual({
      method: 'POST',
      path: '/api/surfaces',
      body: { spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'hi' } },
    })
    const withRun = buildRequest(argv('create', '--space', SPACE, '--home', 'sf-9', '--headline', 'hi', '--run', 'r1'))
    expect(withRun.body?.home).toEqual({ kind: 'surface', surfaceId: 'sf-9' })
    expect(withRun.body?.provenance).toEqual({ runId: 'r1' })
  })

  it('distinguishes clearing a recipe from setting one', () => {
    expect(buildRequest(argv('update', 'sf-1', '--rev', '2', '--recipe', 'run it')).body)
      .toEqual({ expectedRev: 2, recipe: 'run it' })
    expect(buildRequest(argv('update', 'sf-1', '--rev', '2', '--clear-recipe')).body)
      .toEqual({ expectedRev: 2, recipe: null })
  })

  it('sends the collection verbs to the collection endpoints, not to an id path', () => {
    expect(buildRequest(argv('group', 'sf-1,sf-2', '--headline', 'box'))).toEqual({
      method: 'POST', path: '/api/surfaces/group',
      body: { childIds: ['sf-1', 'sf-2'], content: { headline: 'box' } },
    })
    expect(buildRequest(argv('reparent', 'sf-1', '--home', 'sf-2'))).toEqual({
      method: 'POST', path: '/api/surfaces/reparent',
      body: { ids: ['sf-1'], home: { kind: 'surface', surfaceId: 'sf-2' } },
    })
  })

  it('sends purge to its own path and delete to the bare id', () => {
    expect(buildRequest(argv('purge', 'sf-1')).path).toBe('/api/surfaces/sf-1/purge')
    expect(buildRequest(argv('delete', 'sf-1')).path).toBe('/api/surfaces/sf-1')
  })

  it('carries the descendant set and disposition a non-empty delete needs', () => {
    expect(buildRequest(argv('delete', 'sf-1', '--descendants', 'sf-2,sf-3', '--disposition', 'delete-subtree')).body)
      .toEqual({ descendants: ['sf-2', 'sf-3'], disposition: 'delete-subtree' })
  })

  it.each([
    ['get'], ['context'], ['contributors'], ['ungroup'], ['restore'], ['purge'], ['refresh'], ['delete'],
  ])('refuses %s with no id rather than addressing the collection', sub => {
    expect(() => buildRequest(argv(sub))).toThrow(/<id> is required/)
  })

  it('refuses an unknown subcommand with the usage text', () => {
    expect(() => buildRequest(argv('nonsense'))).toThrow(/usage: tinstar surfaces/)
  })
})

describe('renderers', () => {
  it('says out loud when a retry was replayed rather than applied', () => {
    const applied = renderSuccess('delete', {
      op: 'delete', baseTopologyRev: 1, topologyRev: 2, replayed: false,
      surfaces: [{ surface: { id: 'sf-1', rev: 2 } }],
    })
    expect(applied).not.toContain('replayed')
    const replayed = renderSuccess('delete', {
      op: 'delete', baseTopologyRev: 1, topologyRev: 2, replayed: true,
      surfaces: [{ surface: { id: 'sf-1', rev: 2 } }],
    })
    expect(replayed).toContain('replayed — nothing was re-applied')
  })

  it('prints the store reason and the authoritative record on a conflict', () => {
    const text = renderFailure({
      code: 'CONFLICT',
      message: 'mutation refused: stale-surface-revision',
      details: { reason: 'stale-surface-revision', topologyRev: 4, current: [{ id: 'sf-1', rev: 7, content: { headline: 'live' } }] },
    })
    expect(text).toContain('stale-surface-revision')
    expect(text).toContain('current topologyRev 4')
    expect(text).toContain('sf-1 rev 7 live')
  })
})

// --- The real CLI against the real routes ---------------------------------

describe('CLI against a live backend', () => {
  let server: Server
  let docStore: DocumentStore
  let root: string
  let out: string[]
  let errs: string[]

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cli-surfaces-'))
    docStore = new DocumentStore()
    docStore.activeSpaceId = SPACE
    const cfg = {
      sessions: { prefix: 'tinstar' },
      cliTemplates: [], editor: 'vim',
      ports: { ttyd: 7681, hostStart: 5273 },
      dirs: { root, secrets: join(root, 'secrets'), sessions: join(root, 'sessions') },
      files: { config: join(root, 'config.json'), projects: join(root, 'projects.json') },
      git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
      nats: { channelServerPackage: '', bunPath: '', jetstream: false },
      uploadMaxBytes: 1024,
      ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: {} },
    }
    const ctx = {
      sessionConfig: cfg, docStore,
      bus: { emit: () => {} },
      readyQueue: { onDelete: () => {}, getQueue: () => [] },
      sse: { setReadyQueue: () => {}, broadcastReadyQueueUpdate: () => {} },
    } as unknown as RouteContext
    server = createServer((req, res) => {
      handleRequest(ctx, req, res).then(handled => {
        if (!handled) { res.statusCode = 404; res.end('{}') }
      }).catch(() => { res.statusCode = 500; res.end('{}') })
    })
    await new Promise<void>(resolve => server.listen(0, () => resolve()))
    process.env.TINSTAR_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    out = []
    errs = []
    vi.spyOn(console, 'log').mockImplementation(msg => { out.push(String(msg)) })
    vi.spyOn(console, 'error').mockImplementation(msg => { errs.push(String(msg)) })
    process.exitCode = undefined
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.TINSTAR_API_BASE
    delete process.env.TINSTAR_SESSION_NAME
    process.exitCode = undefined
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    rmSync(root, { recursive: true, force: true })
  })

  /** Create through the CLI and return the id it printed. */
  async function cliCreate(headline: string): Promise<string> {
    out.length = 0
    await run(argv('create', '--space', SPACE, '--home', 'canvas', '--headline', headline, '--json'))
    const payload = JSON.parse(out.join('\n')) as { data: { surfaces: { surface: { id: string } }[] } }
    return payload.data.surfaces[0]!.surface.id
  }

  it('creates, lists, and reads back through the CLI alone', async () => {
    const id = await cliCreate('from the shell')
    out.length = 0
    await run(argv('list', '--space', SPACE))
    expect(out.join('\n')).toContain(id)
    expect(out.join('\n')).toContain('from the shell')

    out.length = 0
    await run(argv('get', id))
    expect(out.join('\n')).toContain('can: ')
    expect(out.join('\n')).toContain('delete')
  })

  it('reports the same conflict state the HTTP primitive does', async () => {
    const id = await cliCreate('a')
    // The HTTP answer.
    const http = await fetch(`${process.env.TINSTAR_API_BASE}/api/surfaces/${id}/content`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headline: 'b', expectedRev: 99 }),
    })
    const httpBody = await http.json() as { error: { code: string; message: string; details: { reason: string } } }
    expect(http.status).toBe(409)

    // The CLI answer, from the same server.
    out.length = 0
    errs.length = 0
    await run(argv('update', id, '--rev', '99', '--headline', 'b'))
    expect(process.exitCode).toBe(1)
    const text = errs.join('\n')
    expect(text).toContain(httpBody.error.code)
    expect(text).toContain(httpBody.error.message)
    expect(text).toContain(httpBody.error.details.reason)
  })

  it('completes the recovery lifecycle and reports each state', async () => {
    const id = await cliCreate('recoverable')
    out.length = 0
    await run(argv('delete', id))
    expect(out.join('\n')).toContain('delete')
    expect(docStore.getSurfaceRecoveryRoots(SPACE).map(s => s.id)).toEqual([id])

    out.length = 0
    await run(argv('list', '--space', SPACE))
    expect(out.join('\n')).toContain('recoverable 1')

    out.length = 0
    await run(argv('restore', id))
    expect(out.join('\n')).toContain('restore')
    expect(docStore.getSurfaceRoots(SPACE).map(s => s.id)).toEqual([id])

    // Purge refuses a live Surface, and says why, rather than erasing it.
    errs.length = 0
    await run(argv('purge', id))
    expect(errs.join('\n')).toContain('not-deleted')
    expect(docStore.getSurface(id)).toBeDefined()
  })

  it('identifies a managed session as itself, so its thread reply reads as an agent', async () => {
    const id = await cliCreate('question')
    process.env.TINSTAR_SESSION_NAME = 'run-alpha'
    await run(argv('thread', id, '--text', 'answering'))
    expect(docStore.getSurface(id)!.thread.replies[0]!.author).toBe('agent')
  })

  it('makes a retry with the same idempotency key a no-op', async () => {
    const id = await cliCreate('once')
    await run(argv('thread', id, '--text', 'only once', '--idempotency-key', 'k1'))
    out.length = 0
    await run(argv('thread', id, '--text', 'only once', '--idempotency-key', 'k1'))
    expect(out.join('\n')).toContain('replayed')
    expect(docStore.getSurface(id)!.thread.replies).toHaveLength(1)
  })

  it('groups and ungroups through the CLI, leaving the dissolved box recoverable', async () => {
    const a = await cliCreate('a')
    const b = await cliCreate('b')
    out.length = 0
    await run(argv('group', `${a},${b}`, '--headline', 'box', '--json'))
    const grouped = JSON.parse(out.join('\n')) as { data: { surfaces: { surface: { id: string } }[] } }
    const boxId = grouped.data.surfaces[0]!.surface.id
    expect(docStore.getSurfaceChildren(boxId).map(s => s.id)).toEqual([a, b])

    out.length = 0
    await run(argv('ungroup', boxId))
    expect(docStore.getSurfaceRoots(SPACE).map(s => s.id).sort()).toEqual([a, b].sort())
    expect(docStore.getSurfaceRecoveryRoots(SPACE).map(s => s.id)).toEqual([boxId])
  })
})
