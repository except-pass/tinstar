import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReconciliationSources, handleReconciliationRequest } from '../index'
import { WorkReader } from '../workReader'
import { CreationReceipts } from '../workflowReceipts'
import { CardContextReader } from '../cardContext'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'

afterEach(() => vi.restoreAllMocks())
it('serves canonical review rows through HTTP without waiting on the full operational queue or history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-display-'))
  const source = fixtureSources().intentions
  source.observedAt = new Date().toISOString(); source.expiresAt = new Date(Date.now() + 120_000).toISOString()
  const card = source.data!.cards[0]!
  card.properties.Status!.value = 'Ready for Review'; card.properties.Owner!.value = 'Firstmate'
  source.data!.cards = [card, card]
  const query = vi.spyOn(WorkReader.prototype, 'query').mockResolvedValue(source)
  const network = vi.fn<typeof fetch>(() => { throw new Error('Display must not fetch history') })
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, network, undefined, root)
  const heavy = vi.spyOn(sources, 'queue').mockImplementation(() => new Promise(() => {}))
  const recovery = vi.spyOn(sources.workflow, 'reconcileReviews').mockImplementation(() => new Promise(() => {}))
  await new CreationReceipts(root).putReview('review:pending', 'input', card.id, { original: {}, desired: {}, note: 'pending', actor: 'Firstmate' })
  const server = createServer((req, res) => { void handleReconciliationRequest(sources, req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/queue?view=reviews&refresh=1`)
    const body = await response.json()
    expect(body.data.reviews.items.map((item: { cardId: string }) => item.cardId)).toEqual([card.id])
    expect(body.data.reviews.complete).toBe(true)
    expect(body.data.warnings).toEqual([expect.stringContaining('unconfirmed')])
    expect(query).toHaveBeenCalledWith({}, true)
    expect(heavy).not.toHaveBeenCalled(); expect(recovery).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
    source.status = 'stale'; source.coverage = 'partial'
    expect((await sources.reviews()).reviews).toMatchObject({ complete: false, warning: expect.any(String) })
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
it('cached comment access does not wait for in-flight history and invalidation removes resolved evidence', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve }))
  const reader = new CardContextReader({ dataSourceId: 'board', token: 'fixture' }, fetcher)
  const read = reader.commentDetails('a'.repeat(32))
  expect(reader.cachedComments('a'.repeat(32))).toBeUndefined()
  finish(Response.json({ results: [], has_more: false }))
  await read
  expect(reader.cachedComments('a'.repeat(32))?.outcome).toBe('available')
  reader.invalidate('a'.repeat(32))
  expect(reader.cachedComments('a'.repeat(32))).toBeUndefined()
})
