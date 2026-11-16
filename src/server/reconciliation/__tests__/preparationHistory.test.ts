import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CardContextReader } from '../cardContext'
import { ReconciliationMcp } from '../mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { preparedDecisionFixture } from '../../../../test-fixtures/reconciliation/preparedDecision'
import { preparationHistoryFixture } from '../../../../test-fixtures/reconciliation/preparationHistory'

const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup(options: Parameters<typeof preparationHistoryFixture>[2] = {}) {
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
  return { ...fixture, root, posts, reconcile }
}

async function loadedSnapshot(sources: Awaited<ReturnType<typeof setup>>['sources']) {
  await sources.preparedReviews.snapshot()
  await vi.waitFor(async () => expect((await sources.preparedReviews.snapshot()).history.every(row => row.state !== 'loading')).toBe(true), { timeout: 15_000, interval: 250 })
  return sources.preparedReviews.snapshot()
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
  await loadedSnapshot(sources)
  await vi.waitFor(() => expect(posts).toHaveLength(1))
  expect(posts).toHaveLength(1)
  expect(reconcile).not.toHaveBeenCalled()
}, 20_000)

it('warms cold claim history through MCP without blocking and claims only after history loads', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const details = vi.spyOn(CardContextReader.prototype, 'decisionDetails')
  const { sources, root, cardIds, reconcile } = await setup({ cards: 64, beforeRead: async url => {
    if (url.pathname.includes('/blocks/') || url.pathname === '/v1/comments') await gate
  } })
  expect(details).not.toHaveBeenCalled()
  const mcp = new ReconciliationMcp(sources, root)
  const server = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const client = new Client({ name: 'desk-claim-regression', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const started = performance.now()
    const raw = await Promise.race([client.callTool({ name: 'claim_next_card', arguments: { operation_id: 'desk-open-claim' } }), new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Claim waited for Desk history')), 1900); timer.unref()
    })])
    expect(performance.now() - started).toBeLessThan(2000)
    const result = JSON.parse((raw.content as Array<{ text: string }>)[0]!.text)
    expect(result).toMatchObject({ outcome: 'no-unclaimed-card', warnings: expect.arrayContaining([expect.stringContaining('publication history is unavailable')]) })
    expect(cardIds.every(id => sources.leases.status(id) === null)).toBe(true)
    expect(details).toHaveBeenCalledTimes(2)
    const blocked = await sources.preparedReviews.snapshot()
    expect(blocked.history.every(row => row.state === 'loading')).toBe(true)
    expect(blocked.counts.ready).toBeNull()
    expect(details).toHaveBeenCalledTimes(2)
    release()
    await vi.waitFor(async () => {
      const queue = await sources.claimQueue()
      expect(queue.needsWill?.length).toBeGreaterThan(0)
      expect(queue.needsWill?.every(item => item.proposalHistoryComplete)).toBe(true)
    }, { timeout: 15_000, interval: 100 })
    const recovered = await client.callTool({ name: 'claim_next_card', arguments: { operation_id: 'history-loaded-claim' } })
    const claimed = JSON.parse((recovered.content as Array<{ text: string }>)[0]!.text)
    expect(claimed).toMatchObject({ outcome: 'claimed', lease: { card_id: expect.any(String) }, card: { outcome: 'available' } })
    expect(reconcile).not.toHaveBeenCalled()
    await client.callTool({ name: 'release_claim', arguments: { lease_token: claimed.lease_token, reason: 'Isolated regression complete' } })
  } finally { release(); await client.close() }
}, 20_000)

it.each([false, true])('excludes an answered source while preserving an independent request on the same card: %s', async independentRequest => {
  const { sources, root, cardId, posts, reads, reconcile } = await setup({ answered: true, independentRequest })
  await loadedSnapshot(sources)
  const queue = await sources.claimQueue()
  const answered = queue.needsWill!.find(item => item.sources.some(source => source.request?.id === 'preview-go'))!
  expect(answered.decisionResolution).toMatchObject({ state: 'pending', request_id: 'preview-question', source_anchor: expect.any(String) })
  if (independentRequest) {
    const open = queue.needsWill!.find(item => item.sources.some(source => source.request?.id === 'independent-go'))!
    expect(open).toBeDefined()
    expect(open.decisionResolution).toBeUndefined()
    expect(open.readiness).toBe('ready-now')
  }
  const delivery = sources.workflow.decisionDelivery
  const messages = delivery && vi.spyOn(delivery, 'messages').mockImplementation(() => new Promise(() => {}))
  const mcp = new ReconciliationMcp(sources, root)
  const server = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const client = new Client({ name: 'answered-claim-regression', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const started = performance.now()
    const raw = await Promise.race([client.callTool({ name: 'claim_next_card', arguments: { operation_id: 'answered-source-claim' } }), new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Claim waited for answer delivery')), 1900); timer.unref()
    })])
    expect(performance.now() - started).toBeLessThan(2000)
    const result = JSON.parse((raw.content as Array<{ text: string }>)[0]!.text)
    expect(result.outcome).toBe(independentRequest ? 'claimed' : 'no-unclaimed-card')
    if (independentRequest) {
      expect(result.lease.card_id).toBe(cardId)
      await client.callTool({ name: 'release_claim', arguments: { lease_token: result.lease_token, reason: 'Independent request verified' } })
    } else expect(sources.leases.status(cardId)).toBeNull()
    expect(reconcile).not.toHaveBeenCalled()
    if (messages) expect(messages).not.toHaveBeenCalled()
    expect(posts).toEqual([])
    expect(reads.filter(read => !read.path.endsWith('/query')).every(read => read.method === 'GET')).toBe(true)
  } finally { await client.close() }
}, 20_000)

it('loads history for the Preparation view and shows actual missing options per card', async () => {
  const { sources, cardId, removeOptions, reconcile } = await setup()
  removeOptions()
  const snapshot = await loadedSnapshot(sources)
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

it('recovers failed background history through snapshots with automatic preparation off', async () => {
  const { sources, cardId, denyComments, allowComments, reads, posts, reconcile } = await setup()
  denyComments()
  const failed = await loadedSnapshot(sources)
  expect(failed.history).toContainEqual(expect.objectContaining({ card_id: cardId, state: 'unavailable', retry_at: expect.any(String) }))
  const retryAt = Date.parse(failed.history.find(row => row.card_id === cardId)!.retry_at!)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(retryAt - 1)
  allowComments()
  const before = reads.length
  await sources.preparedReviews.snapshot()
  expect(reads).toHaveLength(before)
  clock.mockReturnValue(retryAt + 1)
  const recovered = await loadedSnapshot(sources)
  expect(recovered.history).toContainEqual(expect.objectContaining({ card_id: cardId, state: 'available', retry_at: null }))
  expect(recovered.source_failures).toEqual([])
  expect((await sources.decisionPackets.readPolicy('f'.repeat(32))).values.automatic_replenishment).toBe(false)
  expect(posts).toEqual([])
  expect(reconcile).not.toHaveBeenCalled()
  expect(sources.leases.status(cardId)).toBeNull()
}, 20_000)

it('shows a missing exact source binding without treating complete history as unavailable', async () => {
  const { sources, cardId, removeBinding, posts } = await setup()
  removeBinding()
  const snapshot = await loadedSnapshot(sources)
  expect(snapshot.source_failures).toContainEqual({ card_id: cardId, reasons: expect.arrayContaining(['Request has no exact First Mate source binding']) })
  expect(snapshot.source_failures.flatMap(row => row.reasons)).not.toContain('Complete cached decision history is unavailable')
  expect(posts).toEqual([])
}, 20_000)

it('explains queue cards whose complete history has no recorded decision request', async () => {
  const { sources, cardId, removeRequest, posts } = await setup()
  removeRequest()
  const snapshot = await loadedSnapshot(sources)
  expect(snapshot.source_failures).toEqual([{ card_id: cardId, reasons: ['No decision request is recorded in the complete card history'] }])
  expect(snapshot.pending).toEqual([])
  expect(posts).toEqual([])
}, 20_000)

it('returns a 64-card snapshot under two seconds while shared capped history reads remain blocked', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const details = vi.spyOn(CardContextReader.prototype, 'decisionDetails')
  const { sources, cardIds, reads, posts, reconcile } = await setup({ cards: 64, beforeRead: async url => {
    if (url.pathname.includes('/blocks/') || url.pathname === '/v1/comments') await gate
  } })
  try {
    const started = performance.now()
    const snapshot = await Promise.race([sources.preparedReviews.snapshot(), new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Snapshot waited for history')), 1900); timer.unref()
    })])
    expect(performance.now() - started).toBeLessThan(2000)
    expect(snapshot.history).toHaveLength(64)
    expect(snapshot.history.every(row => row.state === 'loading')).toBe(true)
    expect(snapshot.counts).toMatchObject({ ready: null, to_prepare: null, requests: null })
    await sources.preparedReviews.snapshot()
    await sources.preparedReviews.snapshot()
    expect(details).toHaveBeenCalledTimes(2)
    await sources.decisionPackets.updatePolicy('f'.repeat(32), { expected_version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: true } }, 'fixture-owner')
    await sources.preparation.replenish()
    expect(details).toHaveBeenCalledTimes(2)
    expect(posts).toEqual([])
    release()
    const loaded = await loadedSnapshot(sources)
    expect(loaded.history.every(row => row.state === 'available')).toBe(true)
    expect(details).toHaveBeenCalledTimes(64)
    const readCount = reads.length
    await sources.preparedReviews.snapshot()
    expect(reads).toHaveLength(readCount)
    expect(reads.filter(read => read.path === '/v1/comments')).toHaveLength(64)
    await sources.preparation.replenish()
    expect(posts).toHaveLength(1)
    expect(reconcile).not.toHaveBeenCalled()
    expect(cardIds.every(id => sources.leases.status(id) === null)).toBe(true)
  } finally { release() }
}, 20_000)

it('reads only the Prepare now card and shares concurrent requests for it', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const details = vi.spyOn(CardContextReader.prototype, 'decisionDetails')
  const { sources, cardId, requestId, reads } = await setup({ cards: 64, beforeRead: async url => {
    if (url.pathname.includes('/blocks/') || url.pathname === '/v1/comments') await gate
  } })
  const input = { card_id: cardId, request_id: requestId, reason: 'Prepare one card' }
  const first = sources.preparation.prepareNow('fixture-owner', input)
  const second = sources.preparation.prepareNow('fixture-owner', input)
  await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1))
  release()
  expect((await first).outcome).toMatch(/dispatched|already-preparing/)
  expect((await second).outcome).toMatch(/dispatched|already-preparing/)
  expect(details).toHaveBeenCalledTimes(1)
  expect(reads.filter(read => read.path === '/v1/comments')).toHaveLength(1)
}, 20_000)

it.each(['comments', 'body'] as const)('loads a late %s request on a 13-page contract without treating code or nested specs as missing history', async historySurface => {
  const { sources, cardId, requestId, reads, posts } = await setup({ largeContract: true, historySurface, commentCount: 601 })
  const snapshot = await loadedSnapshot(sources)
  expect(snapshot.history).toContainEqual(expect.objectContaining({ card_id: cardId, state: 'available' }))
  expect(sources.preparationEvidence(cardId)).toMatchObject({ reasons: [], requests: [{ reasons: [], answered: false }] })
  expect(reads.filter(read => read.path === `/v1/blocks/${cardId}/children`)).toHaveLength(13)
  expect(reads.filter(read => read.path === '/v1/comments')).toHaveLength(7)
  expect(reads.some(read => read.path.includes('nested-spec'))).toBe(false)
  expect(await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Prepare large contract' })).toMatchObject({ outcome: 'dispatched' })
  expect(posts).toHaveLength(1)
  expect((await sources.decisionPackets.readPolicy('f'.repeat(32))).values.automatic_replenishment).toBe(false)
}, 20_000)

it('refreshes just an explicitly requested expired card after a sweep outlives the 30-second cache', async () => {
  const { sources, cardId, requestId, reads } = await setup({ cards: 46, largeContract: true })
  await loadedSnapshot(sources)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
  try {
    const before = reads.length
    expect(await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Fresh exact card after long sweep' })).toMatchObject({ outcome: 'dispatched' })
    const freshReads = reads.slice(before)
    expect(freshReads).toHaveLength(14)
    expect(freshReads.every(read => read.path === `/v1/blocks/${cardId}/children` || read.path === '/v1/comments')).toBe(true)
  } finally { clock.mockRestore() }
}, 20_000)

it.each(['firstmate', 'card-native'] as const)('prepares and answers a %s structured request through MCP on a large card', async kind => {
  const f = await setup({ largeContract: true, historySurface: 'none', cardStatus: 'Queued' })
  const mcp = new ReconciliationMcp(f.sources, f.root)
  const server = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const token = (await readFile(join(f.root, 'mcp-token'), 'utf8')).trim()
  const client = new Client({ name: 'large-card-publication-proof', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const call = async (name: string, args: Record<string, unknown>) => {
      const raw = await client.callTool({ name, arguments: args })
      return JSON.parse((raw.content as Array<{ text: string }>)[0]!.text)
    }
    const template = preparedDecisionFixture().packet
    expect(await call('update_work', { kind: 'request_decision', card_id: f.cardId, operation_id: 'large-card-request', request_id: f.requestId,
      question: template.question, requested_from: 'Will', action: 'Decision', options: template.binding.options,
      ...(kind === 'firstmate' ? { source_request: f.sourceRequest } : {}) })).toMatchObject({ outcome: 'saved' })
    expect(f.publishedNotes).toHaveLength(1)
    expect((await loadedSnapshot(f.sources)).pending).toContainEqual(expect.objectContaining({ card_id: f.cardId, request_id: f.requestId, state: 'Queued' }))
    const prepared = await f.sources.preparation.prepareNow('fixture-owner', { card_id: f.cardId, request_id: f.requestId, reason: 'Prepare published large-card request' })
    expect(prepared).toMatchObject({ outcome: 'dispatched' })
    expect(f.posts).toEqual([{ request_id: f.requestId, card_url: `https://www.notion.so/${f.cardId}`, publish: { tool: 'publish_prepared_packet', job_id: prepared.job_id } }])
    const evidence = f.sources.preparationEvidence(f.cardId), request = evidence.requests[0]!
    expect(evidence.reasons).toEqual([])
    expect(request.reasons).toEqual([])
    template.binding = request.binding!
    expect(template.binding.source_request).toEqual(kind === 'firstmate' ? f.sourceRequest : null)
    if (kind === 'card-native') expect(template.binding.source_spawn_gen).toBeNull()
    template.dependencies = request.dependencies.map(dependency => ({ kind: dependency.kind, key: dependency.key, revision: dependency.revision! }))
    expect(await call('publish_prepared_packet', { job_id: prepared.job_id, operation_id: 'large-card-packet', packet: template })).toMatchObject({ outcome: 'ready', ready: true })
    const snapshot = await f.sources.preparedReviews.snapshot()
    expect(snapshot.ready).toContainEqual(expect.objectContaining({ card_id: f.cardId, request_id: f.requestId }))
    expect(snapshot.pending).toContainEqual(expect.objectContaining({ card_id: f.cardId, state: 'Ready' }))
    expect((await f.sources.decisionPackets.readPolicy('f'.repeat(32))).values.automatic_replenishment).toBe(false)
    expect(f.sources.leases.status(f.cardId)).toBeNull()
    const session = await call('open_prepared_review_session', { operation_id: 'large-card-review', label: 'Isolated decision review' })
    const claim = await call('claim_next_prepared_decision', { operation_id: 'large-card-claim', review_session_token: session.review_session_token })
    expect(claim).toMatchObject({ outcome: 'claimed', packet: { packet: { binding: { request_id: f.requestId } } } })
    const answer = { operation_id: 'large-card-answer', review_session_token: session.review_session_token, lease_token: claim.lease_token,
      packet_id: claim.packet.id, packet_version: claim.packet.version, request_id: f.requestId, option_id: 'preview',
      next: { owner: template.authorization.next_owner, status: template.authorization.next_status } }
    const submitted = await call('submit_prepared_decision', answer)
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ outcome: 'recorded-empty' })
    const notes = f.publishedNotes.map(note => JSON.stringify(note.rich_text)).join('\n')
    expect(notes).toContain('Operation: answer_decision')
    expect(notes).toContain('Authorize preview only')
    expect((await loadedSnapshot(f.sources)).pending).not.toContainEqual(expect.objectContaining({ card_id: f.cardId, request_id: f.requestId }))
    const count = f.publishedNotes.length
    expect(await call('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(f.publishedNotes).toHaveLength(count)
  } finally { await client.close() }
}, 20_000)
