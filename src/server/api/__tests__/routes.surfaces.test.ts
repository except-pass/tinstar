// @vitest-environment node
//
// The HTTP half of U3's agent parity. `surface-service.test.ts` owns the rules;
// this file owns the things only a real socket can prove — route ordering, the
// envelope, status codes, header-derived identity, and the fact that nothing in
// the adapter quietly reinterprets a body on its way through.
//
// The route-ordering assertions are the ones worth reading. `POST
// /api/surfaces/group` and `DELETE /api/surfaces/:id/purge` both look like a
// bare-id route to a `startsWith` matcher, and the second failure mode is the bad
// one: a purge that fell through to delete would ERASE a live Surface, return
// 200, and look like it worked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { Surface } from '../../../domain/types'

const SPACE = 'spc-a'

interface Harness {
  docStore: DocumentStore
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{
    status: number
    body: { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }
  }>
  /** Bypasses `JSON.stringify` so a torn or unparseable body can be sent. */
  raw(method: string, path: string, text: string): Promise<{ status: number }>
  close(): Promise<void>
}

/**
 * A stand-in for the refresh engine that records what it was asked and answers
 * whatever the test needs (plan U5).
 *
 * The COORDINATOR's behaviour has its own suite; what this file owns is the gate in
 * front of it — which intents reach it, from which principals, and on which recipe
 * classes. So the fake exists mainly to be observed as NOT CALLED.
 */
function fakeCoordinator() {
  const asked: string[] = []
  let answer: { status: string; job?: { id: string; execution: string } } = {
    status: 'started', job: { id: 'job-1', execution: 'owner' },
  }
  return {
    asked,
    answerWith(next: typeof answer) { answer = next },
    humanIntent: async (id: string) => { asked.push(id); return answer },
  }
}

function createTestServer(root: string, coordinator?: unknown): Harness {
  const cfg = {
    sessions: { prefix: 'tinstar' },
    cliTemplates: [],
    editor: 'vim',
    ports: { ttyd: 7681, hostStart: 5273 },
    dirs: { root, secrets: join(root, 'secrets'), sessions: join(root, 'sessions') },
    files: { config: join(root, 'config.json'), projects: join(root, 'projects.json') },
    git: { taskMarkerRegex: '#([A-Za-z0-9_-]+)', reconciliationRepos: [], reconciliationBranchScope: 'local' },
    nats: { channelServerPackage: '', bunPath: '', jetstream: false },
    uploadMaxBytes: 100 * 1024 * 1024,
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: {} },
  }
  const docStore = new DocumentStore()
  docStore.activeSpaceId = SPACE
  const ctx = {
    sessionConfig: cfg,
    docStore,
    ...(coordinator ? { refreshCoordinator: coordinator } : {}),
    bus: { emit: () => {} },
    readyQueue: { onDelete: () => {}, getQueue: () => [] },
    sse: { setReadyQueue: () => {}, broadcastReadyQueueUpdate: () => {} },
  } as unknown as RouteContext

  const server: Server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => {
      if (!handled) { res.statusCode = 404; res.end('{}') }
    }).catch(() => { res.statusCode = 500; res.end('{}') })
  })
  let port = 0
  const ready = new Promise<void>(resolve => server.listen(0, () => {
    port = (server.address() as AddressInfo).port
    resolve()
  }))
  return {
    docStore,
    async call(method, path, body, headers) {
      await ready
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, body: await res.json() as never }
    },
    async raw(method, path, text) {
      await ready
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: text,
      })
      return { status: res.status }
    },
    close: () => new Promise(resolve => { server.close(() => resolve()) }),
  }
}

let h: Harness
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'routes-surfaces-'))
  h = createTestServer(root)
})
afterEach(async () => {
  await h.close()
  rmSync(root, { recursive: true, force: true })
})

async function create(headline: string, over: Record<string, unknown> = {}): Promise<Surface> {
  const r = await h.call('POST', '/api/surfaces', {
    spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline }, ...over,
  })
  if (!r.body.ok) throw new Error(`create failed: ${r.body.error.message}`)
  return (r.body.data.surfaces as { surface: Surface }[])[0]!.surface
}

describe('POST /api/surfaces', () => {
  it('creates and returns 201 with the record and its capabilities', async () => {
    const r = await h.call('POST', '/api/surfaces', {
      spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'hello' },
    })
    expect(r.status).toBe(201)
    if (!r.body.ok) throw new Error('expected ok')
    const view = (r.body.data.surfaces as { surface: Surface; capabilities: Record<string, boolean> }[])[0]!
    expect(view.surface.content.headline).toBe('hello')
    expect(view.capabilities.delete).toBe(true)
    expect(r.body.data.op).toBe('create')
    expect(r.body.data.replayed).toBe(false)
  })

  it('rejects unparseable JSON and a non-object body, and persists nothing', async () => {
    const torn = await h.raw('POST', '/api/surfaces', '{ "spaceId": ')
    expect(torn.status).toBe(400)
    // `JSON.parse('42')` succeeds. Without the object guard the property reads
    // downstream would throw inside the handler and the request would hang.
    const scalar = await h.call('POST', '/api/surfaces', 42)
    expect(scalar.status).toBe(400)
    expect(h.docStore.getAllSurfaces()).toHaveLength(0)
  })

  it('maps a validation refusal to INVALID_PARAMS/400', async () => {
    const r = await h.call('POST', '/api/surfaces', {
      spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE }, content: { headline: 'x' }, id: 'sf-forged',
    })
    expect(r.status).toBe(400)
    if (r.body.ok) throw new Error('expected failure')
    expect(r.body.error.code).toBe('INVALID_PARAMS')
    expect(r.body.error.message).toContain('id')
  })
})

describe('route ordering', () => {
  it('reads POST /api/surfaces/group as the collection verb, never as an id', async () => {
    const a = await create('a')
    const b = await create('b')
    const r = await h.call('POST', '/api/surfaces/group', {
      childIds: [a.id, b.id], content: { headline: 'box' },
    })
    if (!r.body.ok) throw new Error(`group failed: ${r.body.error.message}`)
    expect(r.body.data.op).toBe('group')
    expect(h.docStore.getSurfaceRoots(SPACE)).toHaveLength(1)
    // And nothing named "group" was created or looked up.
    expect(h.docStore.getSurface('group')).toBeUndefined()
  })

  it('reads POST /api/surfaces/reparent as the collection verb', async () => {
    const a = await create('a')
    const b = await create('b')
    const r = await h.call('POST', '/api/surfaces/reparent', {
      ids: [a.id], home: { kind: 'surface', surfaceId: b.id },
    })
    if (!r.body.ok) throw new Error('expected ok')
    expect(r.body.data.op).toBe('reparent')
    expect(h.docStore.getSurfaceChildren(b.id).map(s => s.id)).toEqual([a.id])
  })

  it('does NOT let DELETE :id/purge fall through to delete — the erase-vs-move trap', async () => {
    const a = await create('a')
    // Purging a LIVE Surface must be refused. If the route fell through to the
    // delete handler this would return 200 and the Surface would be in the
    // recovery store — a silent success for an operation the caller did not ask
    // for, with the opposite blast radius.
    const r = await h.call('DELETE', `/api/surfaces/${a.id}/purge`)
    expect(r.status).toBe(409)
    if (r.body.ok) throw new Error('expected conflict')
    expect(r.body.error.details?.reason).toBe('not-deleted')
    expect(h.docStore.getSurface(a.id)!.home).toEqual({ kind: 'canvas', spaceId: SPACE })
    expect(h.docStore.getSurfaceRecoveryRoots(SPACE)).toHaveLength(0)
  })

  it('routes each per-Surface sub-resource to its own operation', async () => {
    const a = await create('a')
    const thread = await h.call('POST', `/api/surfaces/${a.id}/thread`, { text: 'hi' })
    expect(thread.body.ok && thread.body.data.op).toBe('append-thread')
    // `refresh` is NOT a thin pass-through to one mutator any more (plan U5): it is
    // the intent-aware operation, and its response is the outcome rather than a
    // service receipt. What this ordering test still owns is that the sub-route is
    // MATCHED at all — a broader handler swallowing it would 404, or worse be read
    // as a bare Surface id. This harness runs with no refresh engine, so reaching
    // the handler is exactly what a 503 proves.
    const refresh = await h.call('POST', `/api/surfaces/${a.id}/refresh`)
    expect(refresh.status).toBe(503)
    expect(!refresh.body.ok && refresh.body.error.message).toMatch(/refresh engine is not running/)
    // rev 2, not 3: the refresh above reached the intent handler and committed
    // nothing, which is itself part of what this asserts.
    const content = await h.call('PATCH', `/api/surfaces/${a.id}/content`, { headline: 'b', expectedRev: 2 })
    expect(content.body.ok && content.body.data.op).toBe('update-content')
  })

  it('refuses the wrong verb on a sub-resource instead of silently matching another route', async () => {
    const a = await create('a')
    const r = await h.call('POST', `/api/surfaces/${a.id}/content`, { headline: 'x', expectedRev: 1 })
    expect(r.status).toBe(405)
    expect(h.docStore.getSurface(a.id)!.content.headline).toBe('a')
  })
})

describe('reads', () => {
  it('lists the active space when no spaceId is given', async () => {
    await create('a')
    const r = await h.call('GET', '/api/surfaces')
    if (!r.body.ok) throw new Error('expected ok')
    expect(r.body.data.spaceId).toBe(SPACE)
    expect((r.body.data.surfaces as unknown[])).toHaveLength(1)
  })

  it('returns context with ancestors, children, and contributors', async () => {
    const parent = await create('parent')
    await h.call('POST', '/api/surfaces', {
      spaceId: SPACE, home: { kind: 'surface', surfaceId: parent.id }, content: { headline: 'kid' },
    })
    const r = await h.call('GET', `/api/surfaces/${parent.id}/context`)
    if (!r.body.ok) throw new Error('expected ok')
    expect(r.body.data.ancestors).toEqual([])
    expect((r.body.data.children as { headline: string }[])[0]!.headline).toBe('kid')
    expect(r.body.data.descendantCount).toBe(1)
  })

  it('resolves a contributor whose session is gone to unavailable, with no terminal', async () => {
    const a = await create('a', { owner: { kind: 'session', id: 'ghost' } })
    const r = await h.call('GET', `/api/surfaces/${a.id}/contributors`)
    if (!r.body.ok) throw new Error('expected ok')
    const [c] = r.body.data.contributors as { resolution: string; terminal: boolean }[]
    expect(c!.resolution).toBe('unavailable')
    expect(c!.terminal).toBe(false)
  })

  it('404s an unknown Surface', async () => {
    const r = await h.call('GET', '/api/surfaces/sf-nope')
    expect(r.status).toBe(404)
  })
})

describe('conflicts', () => {
  it('returns 409 with the reason, the current record, and the topology revision', async () => {
    const a = await create('a')
    const r = await h.call('PATCH', `/api/surfaces/${a.id}/content`, { headline: 'b', expectedRev: 99 })
    expect(r.status).toBe(409)
    if (r.body.ok) throw new Error('expected conflict')
    expect(r.body.error.code).toBe('CONFLICT')
    expect(r.body.error.details?.reason).toBe('stale-surface-revision')
    expect((r.body.error.details?.current as Surface[])[0]!.content.headline).toBe('a')
    expect(r.body.error.details?.topologyRev).toBe(1)
    expect(h.docStore.getSurface(a.id)!.content.headline).toBe('a')
  })

  it('names every affected descendant when a delete confirmation is out of date', async () => {
    const parent = await create('parent')
    const kid = await h.call('POST', '/api/surfaces', {
      spaceId: SPACE, home: { kind: 'surface', surfaceId: parent.id }, content: { headline: 'kid' },
    })
    if (!kid.body.ok) throw new Error('setup failed')
    const r = await h.call('DELETE', `/api/surfaces/${parent.id}`, { descendants: [], disposition: 'delete-subtree' })
    expect(r.status).toBe(409)
    if (r.body.ok) throw new Error('expected conflict')
    expect(r.body.error.details?.reason).toBe('descendant-mismatch')
    expect(h.docStore.getSurface(parent.id)!.home).toEqual({ kind: 'canvas', spaceId: SPACE })
  })
})

describe('actor identity and idempotency', () => {
  it('derives a session principal from the actor headers', async () => {
    const a = await create('a')
    await h.call('POST', `/api/surfaces/${a.id}/thread`, { text: 'from an agent' }, {
      'X-Tinstar-Actor': 'run-alpha', 'X-Tinstar-Actor-Kind': 'session',
    })
    // The author defaults from the actor kind: a session posts as an agent.
    expect(h.docStore.getSurface(a.id)!.thread.replies[0]!.author).toBe('agent')
    expect(h.docStore.getSurface(a.id)!.thread.status).toBe('discussing')
  })

  it('treats an unlabelled caller as the local human', async () => {
    const a = await create('a')
    await h.call('POST', `/api/surfaces/${a.id}/thread`, { text: 'from a browser' })
    expect(h.docStore.getSurface(a.id)!.thread.replies[0]!.author).toBe('user')
  })

  it('records who deleted a Surface on the recovery record', async () => {
    const a = await create('a')
    await h.call('DELETE', `/api/surfaces/${a.id}`, {}, { 'X-Tinstar-Actor': 'run-alpha' })
    expect(h.docStore.getSurface(a.id)!.deleted?.by).toEqual({ kind: 'session', id: 'run-alpha' })
  })
})

describe('delete, restore, purge over HTTP', () => {
  it('completes the full recoverable lifecycle', async () => {
    const a = await create('a')
    const deleted = await h.call('DELETE', `/api/surfaces/${a.id}`)
    expect(deleted.body.ok && deleted.body.data.op).toBe('delete')
    expect(h.docStore.getSurfaceRecoveryRoots(SPACE).map(s => s.id)).toEqual([a.id])

    const listed = await h.call('GET', '/api/surfaces')
    if (!listed.body.ok) throw new Error('expected ok')
    expect(listed.body.data.surfaces).toHaveLength(0)
    expect(listed.body.data.recoveryIds).toEqual([a.id])

    const restored = await h.call('POST', `/api/surfaces/${a.id}/restore`)
    expect(restored.body.ok && restored.body.data.op).toBe('restore')
    expect(h.docStore.getSurfaceRoots(SPACE).map(s => s.id)).toEqual([a.id])

    await h.call('DELETE', `/api/surfaces/${a.id}`)
    const purged = await h.call('DELETE', `/api/surfaces/${a.id}/purge`)
    if (!purged.body.ok) throw new Error('expected ok')
    expect(purged.body.data.purged).toEqual([a.id])
    expect(h.docStore.getAllSurfaces()).toHaveLength(0)
  })

  it('dissolves a group through ungroup and leaves the box recoverable', async () => {
    const a = await create('a')
    const b = await create('b')
    const grouped = await h.call('POST', '/api/surfaces/group', { childIds: [a.id, b.id], content: { headline: 'box' } })
    if (!grouped.body.ok) throw new Error('setup failed')
    const boxId = (grouped.body.data.surfaces as { surface: Surface }[])[0]!.surface.id

    const r = await h.call('POST', `/api/surfaces/${boxId}/ungroup`)
    if (!r.body.ok) throw new Error('expected ok')
    expect(h.docStore.getSurfaceRoots(SPACE).map(s => s.id).sort()).toEqual([a.id, b.id].sort())
    expect(h.docStore.getSurfaceRecoveryRoots(SPACE).map(s => s.id)).toEqual([boxId])
  })
})

// ---------------------------------------------------------------------------
// The canonical refresh intent (R11-R14, KTD4/KTD9).
//
// The coordinator's behaviour has its own suite. What THIS file owns is the gate in
// front of it: which intents reach it, from which principals, and on which recipe
// classes. Most of these assert the fake was NOT called, which is the whole point —
// the expensive thing must not happen, and "it did not happen" is only convincing
// when something is watching for it.
// ---------------------------------------------------------------------------

describe('POST /api/surfaces/:id/refresh — intent', () => {
  let root2: string
  let coord: ReturnType<typeof fakeCoordinator>
  let srv: Harness

  beforeEach(() => {
    root2 = mkdtempSync(join(tmpdir(), 'tinstar-refresh-intent-'))
    coord = fakeCoordinator()
    srv = createTestServer(root2, coord)
  })
  afterEach(async () => {
    await srv.close()
    rmSync(root2, { recursive: true, force: true })
  })

  /** A dirty Surface with the given recipe, seeded straight onto the store. */
  async function dirty(recipe?: Record<string, unknown>): Promise<string> {
    const created = await srv.call('POST', '/api/surfaces', {
      spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'Coverage', ...(recipe ? { recipe } : {}) },
    })
    if (!created.body.ok) throw new Error('seed failed')
    const id = (created.body.data.surfaces as { surface: Surface }[])[0]!.surface.id
    const s = srv.docStore.getSurface(id)!
    await srv.docStore.commitSurfaceContent({
      ...s, freshness: { ...s.freshness, phase: 'possibly-stale' }, rev: s.rev + 1,
    })
    return id
  }

  const AGENT = { kind: 'agent', prompt: 'Re-run coverage.' }
  const HOST = { kind: 'host', handler: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' } }

  it('a human navigating to a dirty Surface starts the one attempt', async () => {
    const id = await dirty(AGENT)
    const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'navigate' })
    expect(r.status).toBe(200)
    expect(r.body.ok && r.body.data.outcome).toBe('started')
    expect(r.body.ok && r.body.data.attemptId).toBe('job-1')
    expect(coord.asked).toEqual([id])
  })

  it('repeated intent reports JOINED rather than a second queue error', async () => {
    // The old route answered `already-queued` with a 409 here, which a UI could only
    // render as a failure. R14 says the attempt in flight IS the answer.
    const id = await dirty(AGENT)
    coord.answerWith({ status: 'joined', job: { id: 'job-1', execution: 'owner' } })
    const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'interact' })
    expect(r.status).toBe(200)
    expect(r.body.ok && r.body.data.outcome).toBe('joined')
    expect(r.body.ok && r.body.data.attemptId).toBe('job-1')
  })

  it('a SESSION principal may not authorize agent work, and nothing is dispatched', async () => {
    // The workflow boundary (KTD4). An agent tool, a cron, or a plugin may read
    // freshness and may execute work a human already authorized — it may not be the
    // thing that decides to spend a model call.
    const id = await dirty(AGENT)
    for (const kind of ['session', 'job', 'process']) {
      const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'navigate' }, {
        'x-tinstar-actor': 'sess-a', 'x-tinstar-actor-kind': kind,
      })
      expect(r.status).toBe(403)
      expect(!r.body.ok && r.body.error.message).toMatch(/may not authorize a refresh/)
    }
    expect(coord.asked).toEqual([])
    expect(srv.docStore.getSurface(id)!.freshness.phase).toBe('possibly-stale')
  })

  it('BULK-CHECK never touches an agent recipe (KTD9)', async () => {
    // "Refresh everything" must be a cheap check, not a prompt fan-out. The Surface
    // is left dirty and the response says why rather than reporting a queue.
    const id = await dirty(AGENT)
    const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'bulk-check' })
    expect(r.status).toBe(200)
    expect(r.body.ok && r.body.data.outcome).toBe('skipped')
    expect(r.body.ok && String(r.body.data.reason)).toMatch(/use its refresh control to update it/)
    expect(coord.asked).toEqual([])
  })

  it('BULK-CHECK does run a host recipe, so the sweep is not vacuous', async () => {
    const id = await dirty(HOST)
    const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'bulk-check' })
    expect(r.body.ok && r.body.data.outcome).toBe('started')
    expect(coord.asked).toEqual([id])
  })

  it('a bulk check needs no human principal — it cannot spend a model call', async () => {
    const id = await dirty(HOST)
    const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'bulk-check' }, {
      'x-tinstar-actor': 'sess-a', 'x-tinstar-actor-kind': 'session',
    })
    expect(r.status).toBe(200)
    expect(coord.asked).toEqual([id])
  })

  it('navigating to a CURRENT Surface does nothing, so moving around a healthy Slate is free', async () => {
    const created = await srv.call('POST', '/api/surfaces', {
      spaceId: SPACE, home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'Coverage', recipe: AGENT },
    })
    if (!created.body.ok) throw new Error('seed failed')
    const id = (created.body.data.surfaces as { surface: Surface }[])[0]!.surface.id
    for (const intent of ['navigate', 'interact']) {
      const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent })
      expect(r.body.ok && r.body.data.outcome).toBe('skipped')
    }
    expect(coord.asked).toEqual([])

    // …but the ⟳ button still works, because pressing it is unambiguous (R18).
    const explicit = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'explicit' })
    expect(explicit.body.ok && explicit.body.data.outcome).toBe('started')
    expect(coord.asked).toEqual([id])
  })

  it('defaults to `explicit`, so a body-less POST from the ⟳ button keeps working', async () => {
    const id = await dirty(AGENT)
    const r = await srv.call('POST', `/api/surfaces/${id}/refresh`)
    expect(r.body.ok && r.body.data.intent).toBe('explicit')
    expect(coord.asked).toEqual([id])
  })

  it('refuses an unknown intent rather than defaulting to one', async () => {
    // Every default here is either "run a model nobody asked for" or "silently do
    // nothing". A 400 is better than both.
    const id = await dirty(AGENT)
    const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'because-i-said-so' })
    expect(r.status).toBe(400)
    expect(coord.asked).toEqual([])
  })

  it('carries the freshness AFTER the operation, so an unavailable answer needs no second request', async () => {
    const id = await dirty(AGENT)
    coord.answerWith({ status: 'unavailable' })
    const r = await srv.call('POST', `/api/surfaces/${id}/refresh`, { intent: 'navigate' })
    expect(r.status).toBe(200)
    expect(r.body.ok && r.body.data.outcome).toBe('unavailable')
    expect(r.body.ok && r.body.data.freshness).toBeDefined()
    expect(r.body.ok && r.body.data.attemptId).toBeUndefined()
  })

  it('404s an unknown Surface without reaching the engine', async () => {
    const r = await srv.call('POST', '/api/surfaces/sf-nope/refresh', { intent: 'explicit' })
    expect(r.status).toBe(404)
    expect(coord.asked).toEqual([])
  })
})
