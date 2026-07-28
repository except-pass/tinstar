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

function createTestServer(root: string): Harness {
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
    const refresh = await h.call('POST', `/api/surfaces/${a.id}/refresh`)
    expect(refresh.body.ok && refresh.body.data.op).toBe('refresh-request')
    const content = await h.call('PATCH', `/api/surfaces/${a.id}/content`, { headline: 'b', expectedRev: 3 })
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
