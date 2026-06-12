import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// Stub the tmux backend so session-related routes don't spawn real processes.
const { createTmuxSessionMock } = vi.hoisted(() => ({
  createTmuxSessionMock: vi.fn(async (_cfg: unknown, _opts: unknown) => ({ port: 6123, ttydPid: 4242 })),
}))
vi.mock('../../sessions', async (importActual) => {
  const actual = await importActual<typeof import('../../sessions')>()
  return {
    ...actual,
    tmuxBackend: {
      ...actual.tmuxBackend,
      findPort: vi.fn(async () => 6123),
      createTmuxSession: createTmuxSessionMock,
      onTtydRestart: vi.fn(),
    },
  }
})

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import { emptyPinSet, addPin, type Pin } from '../../../domain/pinSet'

const SPACE_ID = 'space-1'

function samplePin(overrides: Partial<Pin> = {}): Pin {
  return { id: 'pin-1', nodeId: 'run-R1', nx: 0.5, ny: 0.5, comment: 'hi', createdAt: 1, ...overrides }
}

function makeCtx(root: string): RouteContext {
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
    ui: { promptComposerDefault: false, showEmptyEntities: true, layouts: {}, telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true } },
  }
  const docStore = new DocumentStore()
  docStore.upsertSpace(SPACE_ID, { id: SPACE_ID, name: 'Test Space', createdAt: new Date().toISOString() })

  return {
    sessionConfig: cfg,
    docStore,
    bus: { emit: vi.fn() },
    readyQueue: { onStatusChange: vi.fn(), getQueue: () => [] },
    sse: { setReadyQueue: vi.fn(), broadcastReadyQueueUpdate: vi.fn(), addClient: vi.fn() },
    natsTraffic: undefined,
    natsHealth: undefined,
  } as unknown as RouteContext
}

interface TestCtx {
  docStore: DocumentStore
  fetch(path: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

function createTestServer(root: string): TestCtx {
  const ctx = makeCtx(root)
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(handled => {
      if (!handled) { res.statusCode = 404; res.end() }
    })
  })
  let port: number
  const ready = new Promise<void>(resolve => server.listen(0, () => {
    port = (server.address() as AddressInfo).port
    resolve()
  }))
  return {
    docStore: ctx.docStore,
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      await ready
      const headers = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> ?? {}) }
      return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    },
    close(): Promise<void> {
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

let tmpRoot: string
let testCtx: TestCtx

beforeEach(() => {
  createTmuxSessionMock.mockClear()
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-pins-route-test-'))
  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  await testCtx.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('PUT /api/pins/:spaceId', () => {
  it('stores the pin set and acknowledges with { ok: true, data: null }', async () => {
    const set = addPin(emptyPinSet(SPACE_ID), samplePin())

    const res = await testCtx.fetch(`/api/pins/${SPACE_ID}`, {
      method: 'PUT',
      body: JSON.stringify(set),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as unknown
    expect(body).toEqual({ ok: true, data: null })

    const stored = testCtx.docStore.getPinSet(SPACE_ID)
    expect(stored).toBeDefined()
    expect(stored).toEqual(set)
  })

  it('uses the path spaceId even if body contains a different spaceId', async () => {
    const set = addPin(emptyPinSet('other-space'), samplePin())

    const res = await testCtx.fetch(`/api/pins/${SPACE_ID}`, {
      method: 'PUT',
      body: JSON.stringify(set),
    })

    expect(res.status).toBe(200)

    const stored = testCtx.docStore.getPinSet(SPACE_ID)
    expect(stored).toBeDefined()
    expect(stored!.spaceId).toBe(SPACE_ID)
  })

  it('handles URL-encoded spaceId', async () => {
    const encodedSpaceId = 'space%2F1'
    const decodedSpaceId = 'space/1'
    testCtx.docStore.upsertSpace(decodedSpaceId, { id: decodedSpaceId, name: 'Slashy', createdAt: new Date().toISOString() })
    const set = emptyPinSet(decodedSpaceId)

    const res = await testCtx.fetch(`/api/pins/${encodedSpaceId}`, {
      method: 'PUT',
      body: JSON.stringify(set),
    })

    expect(res.status).toBe(200)

    const stored = testCtx.docStore.getPinSet(decodedSpaceId)
    expect(stored).toBeDefined()
    expect(stored!.spaceId).toBe(decodedSpaceId)
  })

  it('returns 400 on a malformed JSON body instead of hanging', async () => {
    const res = await testCtx.fetch(`/api/pins/${SPACE_ID}`, {
      method: 'PUT',
      body: '{ not json',
    })

    expect(res.status).toBe(400)
    expect(testCtx.docStore.getPinSet(SPACE_ID)).toBeUndefined()
  })

  it('returns 404 for an unknown space', async () => {
    const res = await testCtx.fetch('/api/pins/nope', {
      method: 'PUT',
      body: JSON.stringify(emptyPinSet('nope')),
    })

    expect(res.status).toBe(404)
    expect(testCtx.docStore.getPinSet('nope')).toBeUndefined()
  })

  it('returns 400 for a structurally invalid pin set', async () => {
    const res = await testCtx.fetch(`/api/pins/${SPACE_ID}`, {
      method: 'PUT',
      // pin with a numeric id fails isPinSet
      body: JSON.stringify({ spaceId: SPACE_ID, pins: [{ id: 1 }] }),
    })

    expect(res.status).toBe(400)
    expect(testCtx.docStore.getPinSet(SPACE_ID)).toBeUndefined()
  })

  it('returns 409 for a stale/equal revision rather than a false success', async () => {
    const first = await testCtx.fetch(`/api/pins/${SPACE_ID}`, {
      method: 'PUT',
      body: JSON.stringify({ spaceId: SPACE_ID, pins: [], rev: 2 }),
    })
    expect(first.status).toBe(200)

    // A later write that omits rev (treated as 0) would silently drop — surface
    // the conflict instead, and leave the stored set untouched.
    const stale = await testCtx.fetch(`/api/pins/${SPACE_ID}`, {
      method: 'PUT',
      body: JSON.stringify({ spaceId: SPACE_ID, pins: [samplePin()] }),
    })
    expect(stale.status).toBe(409)
    expect(testCtx.docStore.getPinSet(SPACE_ID)!.pins).toEqual([])
  })
})
