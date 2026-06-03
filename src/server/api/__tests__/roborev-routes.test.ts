import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const listReviews = vi.hoisted(() => vi.fn())
const showReview = vi.hoisted(() => vi.fn())
const runAction = vi.hoisted(() => vi.fn())
vi.mock('../../roborev/cli', () => ({ listReviews, showReview, runAction }))

import { handleRequest, type RouteContext } from '../routes'
import { DocumentStore } from '../../stores/document-store'

function makeCtx(): RouteContext {
  // Minimal ctx — roborev routes only call the mocked cli + ok/fail.
  return { docStore: new DocumentStore(), sse: { broadcastEvent: vi.fn() } } as unknown as RouteContext
}

async function call(method: string, path: string, body?: unknown) {
  const ctx = makeCtx()
  const server = createServer((req, res) => { void handleRequest(ctx, req, res) })
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  server.close()
  return { status: res.status, json }
}

beforeEach(() => { listReviews.mockReset(); showReview.mockReset(); runAction.mockReset() })

describe('GET /api/roborev/reviews', () => {
  it('400 when repo missing', async () => {
    const { status, json } = await call('GET', '/api/roborev/reviews')
    expect(status).toBe(400)
    expect(json.ok).toBe(false)
  })
  it('returns reviews for the repo', async () => {
    listReviews.mockResolvedValue([{ id: 1, status: 'done' }])
    const { status, json } = await call('GET', '/api/roborev/reviews?repo=' + encodeURIComponent('/r'))
    expect(status).toBe(200)
    expect(listReviews).toHaveBeenCalledWith('/r')
    expect(json.data).toHaveLength(1)
  })
})

describe('GET /api/roborev/reviews/:job', () => {
  it('returns the show payload', async () => {
    showReview.mockResolvedValue({ id: 9, job_id: 3, output: 'x', verdict_bool: 1, closed: false })
    const { status, json } = await call('GET', '/api/roborev/reviews/3?repo=' + encodeURIComponent('/r'))
    expect(status).toBe(200)
    expect(showReview).toHaveBeenCalledWith('/r', 3)
    expect(json.data.output).toBe('x')
  })
})

describe('POST /api/roborev/action', () => {
  it('runs close', async () => {
    runAction.mockResolvedValue(undefined)
    const { status } = await call('POST', '/api/roborev/action', { repo: '/r', jobId: 5, action: 'close' })
    expect(status).toBe(200)
    expect(runAction).toHaveBeenCalledWith('/r', { jobId: 5, action: 'close' })
  })
  it('400 on unknown action', async () => {
    const { status } = await call('POST', '/api/roborev/action', { repo: '/r', jobId: 5, action: 'nuke' })
    expect(status).toBe(400)
    expect(runAction).not.toHaveBeenCalled()
  })
})
