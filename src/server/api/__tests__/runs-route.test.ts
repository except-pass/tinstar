import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { Run } from '../../../domain/types'

const FIXTURE_SPACE_ID = 'spc-test-fixture'

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
  docStore.upsertSpace(FIXTURE_SPACE_ID, {
    id: FIXTURE_SPACE_ID,
    name: 'Test Space',
    createdAt: new Date().toISOString(),
  })
  return { sessionConfig: cfg, docStore } as unknown as RouteContext
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
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
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

function makeRun(): Run {
  return {
    id: 'r1',
    status: 'idle',
    sessionId: 's1',
    initiative: 'i',
    epic: 'e',
    task: 't',
    repo: 'repo',
    worktree: 'wt',
    taskId: 't',
    worktreeId: 'wt',
    createdAt: '2026-05-22T00:00:00Z',
    recapEntries: [],
    touchedFiles: [],
    rawLogs: '',
    port: null,
    backend: 'tmux',
    spaceId: FIXTURE_SPACE_ID,
    attention: { level: 'attention', reason: 'Ready for input', setAt: '2026-05-28T00:00:00Z' },
  }
}

let tmpRoot: string
let testCtx: TestCtx

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tinstar-runs-route-test-'))
  testCtx = createTestServer(tmpRoot)
})

afterEach(async () => {
  await testCtx.close()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('PATCH /api/runs/:id', () => {
  it('clears existing run attention', async () => {
    testCtx.docStore.upsertRun('r1', makeRun())

    const res = await testCtx.fetch('/api/runs/r1', {
      method: 'PATCH',
      body: JSON.stringify({ attention: null }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: Run }
    expect(body.ok).toBe(true)
    expect(body.data.attention).toBeUndefined()
    expect(testCtx.docStore.getRun('r1')?.attention).toBeUndefined()
  })
})
