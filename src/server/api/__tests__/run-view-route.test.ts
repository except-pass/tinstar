import { describe, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'

function makeCtx(): { ctx: RouteContext; docStore: DocumentStore } {
  const docStore = new DocumentStore()
  docStore.upsertRun('R1', { id: 'R1', sessionId: 'R1', status: 'idle', taskId: '', initiative: '', epic: '', task: '', repo: '', worktree: '', touchedFiles: [], recapEntries: [], rawLogs: '', port: null, backend: 'tmux', worktreeId: '', createdAt: new Date(0).toISOString() } as never)
  return { ctx: { docStore, sse: { broadcastEvent: vi.fn() } } as unknown as RouteContext, docStore }
}
async function call(ctx: RouteContext, method: string, path: string, body?: unknown) {
  const server = createServer((req, res) => { void handleRequest(ctx, req, res) })
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => null)
  await new Promise<void>((r) => server.close(() => r()))
  return { status: res.status, json }
}

describe('PATCH /api/runs/:id — view/viewData', () => {
  it('updates viewData on an existing run', async () => {
    const { ctx, docStore } = makeCtx()
    const { status } = await call(ctx, 'PATCH', '/api/runs/R1', { viewData: { launched: true } })
    expect(status).toBe(200)
    expect(docStore.getRun('R1')?.viewData).toEqual({ launched: true })
  })
  it('updates view on an existing run', async () => {
    const { ctx, docStore } = makeCtx()
    const { status } = await call(ctx, 'PATCH', '/api/runs/R1', { view: 'roborev-cockpit' })
    expect(status).toBe(200)
    expect(docStore.getRun('R1')?.view).toBe('roborev-cockpit')
  })
  it('404 for an unknown run', async () => {
    const { ctx } = makeCtx()
    expect((await call(ctx, 'PATCH', '/api/runs/nope', { viewData: {} })).status).toBe(404)
  })
})
