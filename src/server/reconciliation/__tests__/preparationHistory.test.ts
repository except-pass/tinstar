import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { preparationHistoryFixture } from '../../../../test-fixtures/reconciliation/preparationHistory'

const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup(options: { cards?: number; onRead?: () => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'preparation-history-')); roots.push(root)
  const posts: unknown[] = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    expect(req.headers.authorization).toBe('Bearer fixture-only-sender')
    posts.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(202); res.end()
  }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const fixture = await preparationHistoryFixture(root, async () => JSON.stringify({ url: `http://127.0.0.1:${port}/job`, key: 'fixture-only-sender' }), options)
  const reconcile = vi.spyOn(fixture.sources.workflow, 'reconcileDecisions')
  return { ...fixture, posts, reconcile }
}

it('loads cold body and comment history for Prepare now without other readers, writes, or reconciliation', async () => {
  const { sources, cardId, requestId, reads, posts, reconcile } = await setup()
  expect(sources.preparationEvidence(cardId).reasons).toContain('Complete cached decision history is unavailable')
  const request = { card_id: cardId, request_id: requestId, reason: 'Prepare this open decision' }
  expect(await sources.preparation.prepareNow('fixture-owner', request)).toMatchObject({ outcome: 'dispatched' })
  expect(posts).toEqual([{ request_id: requestId, card_url: `https://www.notion.so/${cardId}`, publish: { tool: 'publish_prepared_packet', job_id: expect.any(String) } }])
  expect(sources.preparationEvidence(cardId)).toMatchObject({ reasons: [], requests: [{ reasons: [], answered: false }] })
  const readCount = reads.length
  expect((await sources.preparation.prepareNow('fixture-owner', request)).outcome).toBe('already-preparing')
  expect(reads).toHaveLength(readCount)
  expect(posts).toHaveLength(1)
  expect((await sources.decisionPackets.readPolicy('f'.repeat(32))).values.automatic_replenishment).toBe(false)
  expect(reads.filter(read => !read.path.endsWith('/query')).every(read => read.method === 'GET')).toBe(true)
  expect(reconcile).not.toHaveBeenCalled()
  expect(sources.leases.status(cardId)).toBeNull()
}, 20_000)

it('loads cold history for automatic admission only after replenishment is turned on', async () => {
  const { sources, reads, posts, reconcile } = await setup()
  const before = reads.length
  await sources.preparation.replenish()
  expect(reads).toHaveLength(before); expect(posts).toEqual([])
  await sources.decisionPackets.updatePolicy('f'.repeat(32), { expected_version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: true } }, 'fixture-owner')
  await sources.preparation.replenish()
  expect(posts).toHaveLength(1)
  expect(reconcile).not.toHaveBeenCalled()
}, 20_000)

it('loads history for the Preparation view and shows actual missing options per card', async () => {
  const { sources, cardId, removeOptions, reconcile } = await setup()
  removeOptions()
  const snapshot = await sources.preparedReviews.snapshot()
  expect(snapshot.source_failures).toContainEqual({ card_id: cardId, reasons: expect.arrayContaining(['Source-supported option identities are unavailable']) })
  expect(snapshot.source_failures.flatMap(row => row.reasons)).not.toContain('Complete cached decision history is unavailable')
  expect(snapshot.pending).toContainEqual(expect.objectContaining({ card_id: cardId, state: 'Blocked', reasons: expect.arrayContaining(['Source-supported option identities are unavailable']) }))
  expect(reconcile).not.toHaveBeenCalled()
}, 20_000)

it('keeps incomplete comment history ineligible and refreshes after cache expiry', async () => {
  const { sources, cardId, requestId, denyComments, allowComments, posts } = await setup()
  denyComments()
  const result = await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Try unavailable comments' })
  expect(result.outcome).toBe('ineligible')
  expect(sources.preparationEvidence(cardId).reasons).toContain('Complete cached decision history is unavailable')
  expect(posts).toEqual([])
  allowComments()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 31_000)
  expect((await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Retry after read permission returns' })).outcome).toBe('dispatched')
  expect(posts).toHaveLength(1)
}, 20_000)

it('shows a missing exact source binding without treating complete history as unavailable', async () => {
  const { sources, cardId, removeBinding, posts } = await setup()
  removeBinding()
  const snapshot = await sources.preparedReviews.snapshot()
  expect(snapshot.source_failures).toContainEqual({ card_id: cardId, reasons: expect.arrayContaining(['Request has no exact First Mate source binding']) })
  expect(snapshot.source_failures.flatMap(row => row.reasons)).not.toContain('Complete cached decision history is unavailable')
  expect(posts).toEqual([])
}, 20_000)

it('explains queue cards whose complete history has no recorded decision request', async () => {
  const { sources, cardId, removeRequest, posts } = await setup()
  removeRequest()
  const snapshot = await sources.preparedReviews.snapshot()
  expect(snapshot.source_failures).toEqual([{ card_id: cardId, reasons: ['No decision request is recorded in the complete card history'] }])
  expect(snapshot.pending).toEqual([])
  expect(posts).toEqual([])
}, 20_000)

for (const mode of ['automatic', 'snapshot'] as const) {
  it(`enforces freshness at ${mode} consumption on a paced 64-card board`, async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { sources, cardId, posts, reads, reconcile } = await setup({ cards: 64, onRead: () => { now += 350 } })
    const started = now
    if (mode === 'automatic') {
      await sources.decisionPackets.updatePolicy('f'.repeat(32), { expected_version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: true } }, 'fixture-owner')
      await sources.preparation.replenish()
      expect(posts).toHaveLength(1)
      expect((await sources.preparation.status()).jobs).toContainEqual(expect.objectContaining({ card_id: cardId, state: 'dispatched' }))
    } else {
      const snapshot = await sources.preparedReviews.snapshot()
      expect(snapshot.pending).toContainEqual(expect.objectContaining({ card_id: cardId, state: 'Blocked', reasons: expect.arrayContaining(['Complete cached decision history is unavailable']) }))
      expect(snapshot.source_failures).toContainEqual(expect.objectContaining({ card_id: cardId, reasons: expect.arrayContaining(['Complete cached decision history is unavailable']) }))
      expect(snapshot.coverage).toBe('unknown')
      expect(snapshot.counts).toMatchObject({ ready: null, leased: null, needs_repreparation: null, to_prepare: null, requests: null })
      expect(posts).toEqual([])
    }
    expect(now - started).toBeGreaterThan(44_000)
    expect(reads.filter(read => read.path === '/v1/comments')).toHaveLength(64)
    expect(sources.preparationEvidence(cardId).reasons).toContain('Complete cached decision history is unavailable')
    expect(reconcile).not.toHaveBeenCalled()
    expect(sources.leases.status(cardId)).toBeNull()
  }, 20_000)
}
