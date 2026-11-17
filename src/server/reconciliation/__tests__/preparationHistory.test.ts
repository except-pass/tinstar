import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CardContextReader } from '../cardContext'
import { ReconciliationMcp } from '../mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { preparedDecisionFixture } from '../../../../test-fixtures/reconciliation/preparedDecision'
import { preparationHistoryFixture } from '../../../../test-fixtures/reconciliation/preparationHistory'
import { mainWaitCandidates } from '../waitingOnMain'
import { validateDecisionPacket } from '../../../shared/decisionPacket'
import { decisionMarker, receiptMarker } from '../workflowContent'

const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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

function structuredAnswerComment(requestId: string, createdAt: string, withReceipt = false) {
  const answer = 'Defer this request.'
  const next = { owner: 'Firstmate', status: 'Queued' }
  const lines = [
    'Operation: answer_decision',
    decisionMarker(requestId),
    `Tin Star answer: ${JSON.stringify(requestId)}`,
    `Answer: ${answer}`,
    `Next owner: ${next.owner}`,
    `Next status: ${next.status}`,
    `Tin Star answer data: ${JSON.stringify({ request_id: requestId, answer, next })}`,
  ]
  if (withReceipt) lines.push(receiptMarker('owner-chatgpt', 'later-owner-answer'))
  return { id: 'later-owner-answer', created_time: createdAt, rich_text: [{ plain_text: lines.join('\n') }] }
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

it.each(['Todo', 'Backlog', 'Archived', 'Done'])('defers open requests on %s cards and restores them when active', async deferred => {
  let status = 'Waiting For'
  const f = await setup({ wrapFetch: transport => async (input, init) => {
    const response = await transport(input, init)
    const path = new URL(String(input)).pathname
    if (!path.endsWith('/query') && !path.includes('/v1/pages/')) return response
    const body = await response.json()
    for (const page of body.results ?? [body]) {
      page.properties.Status.status.name = status
      page.last_edited_time = new Date(Date.now() - 5 * 3600_000).toISOString()
    }
    return Response.json(body)
  } })
  const prepare = () => f.sources.preparation.prepareNow('fixture-owner', { card_id: f.cardId, request_id: f.requestId, reason: 'Prepare only active work' })
  const first = await prepare()
  expect(first.outcome).toBe('dispatched')
  const packet = preparedDecisionFixture().packet, request = f.sources.preparationEvidence(f.cardId).requests[0]!
  packet.binding = request.binding!
  packet.dependencies = request.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  expect(await f.sources.preparation.publish({ job_id: first.job_id, operation_id: 'ready-before-defer', packet })).toMatchObject({ ready: true })

  const client = new Client({ name: 'deferred-claim-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await new ReconciliationMcp(f.sources, f.root).createServer('Fixture owner').connect(serverTransport)
  await client.connect(clientTransport)
  const claimNext = async (operation_id: string) => {
    const result = await client.callTool({ name: 'claim_next_card', arguments: { operation_id } }) as { content: Array<{ text: string }> }
    return JSON.parse(result.content[0]!.text)
  }
  try {
    status = deferred
    const paused = await f.sources.snapshot(true)
    const queue = await f.sources.queue()
    expect(queue.items.some(item => item.cardIds.includes(f.cardId) && item.sources.some(source => source.kind === 'firstmate'))).toBe(true)
    expect(queue.needsWill?.some(item => item.cardIds.includes(f.cardId))).toBe(false)
    expect(mainWaitCandidates(paused).items).not.toContainEqual(expect.objectContaining({ key: f.cardId }))
    expect(await prepare()).toMatchObject({ outcome: 'ineligible' })
    await f.sources.decisionPackets.updatePolicy('f'.repeat(32), { expected_version: 0, values: { target_ready: 20, max_preparers: 4, automatic_replenishment: true } }, 'fixture-owner')
    await f.sources.preparation.replenish()
    expect(f.posts).toHaveLength(1)
    expect(await f.sources.preparation.priorityCards()).not.toContain(f.cardId)
    expect(await loadedSnapshot(f.sources)).toMatchObject({ ready: [], pending: [], counts: { requests: 0, to_prepare: 0 } })
    expect(await f.sources.preparedReviews.claim('fixture-owner', 'Fixture owner', { operation_id: 'deferred-desk-claim', card_id: f.cardId })).toMatchObject({ outcome: 'no-decision-requests' })
    expect((await f.sources.claimQueue()).needsWill).toEqual([])
    expect(await claimNext('deferred')).toMatchObject({ outcome: 'no-unclaimed-card' })

    status = 'Waiting For'
    const active = await f.sources.snapshot(true)
    expect(mainWaitCandidates(active).items).toContainEqual(expect.objectContaining({ key: f.cardId, audience: 'owner' }))
    expect((await loadedSnapshot(f.sources)).ready).toEqual([expect.objectContaining({ card_id: f.cardId })])
    expect(await claimNext('active-again')).toMatchObject({ outcome: 'claimed', lease: { card_id: f.cardId } })
    expect(f.posts).toHaveLength(1)
  } finally { await client.close() }
}, 20_000)

it('keeps preparation across Tin Star housekeeping, then invalidates a substantive comment without recording an answer', async () => {
  let added = false, changed = false
  const checkInId = 'appointment'
  const f = await setup({ wrapFetch: transport => async (input, init) => {
    const response = await transport(input, init)
    if (!added || new URL(String(input)).pathname !== '/v1/comments') return response
    const body = await response.json()
    body.results.push(
      { id: 'check-in', rich_text: [{ plain_text: `Date: ${new Date().toISOString()}\n  Check-in request :  ${checkInId}  \nBy: Firstmate\nProgress: Still collecting the prepared evidence.\nEvidence: Verified the local log.\nBlocker/owner: none\nNext action: Read the current source.\nNext check-in: ${new Date().toISOString()}\nAppointment: provisional\n${receiptMarker('Firstmate', 'check-in')}` }] },
      { id: 'reminder', rich_text: [{ plain_text: `Waiting on you for 4h: existing decision.\n${receiptMarker('waiting-on-main', 'reminder')}` }] },
      { id: 'packet-note', rich_text: [{ plain_text: 'Prepared packet (Tinstar Decision Prep)\nBackground: Advisory preview only.' }] },
    )
    if (changed) body.results.push({ id: 'owner-prose', created_by: { name: 'owner-chatgpt' }, rich_text: [{ plain_text: 'Date: 2026-11-17T23:00:00Z\nBy: Firstmate\nProgress: Checked the new preview.\nEvidence: The preview would now write production data. Defer it.\nBlocker/owner: none\nNext action: Recheck production isolation.\nNext check-in: 2026-11-18T23:00:00Z\nAppointment: provisional' }] })
    return Response.json(body)
  } })
  f.sources.checkInRequestIds = async id => new Set(id === f.cardId ? [checkInId] : [])
  const prepare = () => f.sources.preparation.prepareNow('fixture-owner', { card_id: f.cardId, request_id: f.requestId, reason: 'Prepare decision once' })
  const first = await prepare()
  const packet = preparedDecisionFixture().packet, before = f.sources.preparationEvidence(f.cardId).requests[0]!
  packet.binding = before.binding!
  packet.dependencies = before.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  expect(await f.sources.preparation.publish({ job_id: first.job_id, operation_id: 'stable-packet', packet })).toMatchObject({ ready: true })
  added = true
  await f.sources.updateContext(f.cardId)
  expect((await loadedSnapshot(f.sources)).ready).toHaveLength(1)
  const after = f.sources.preparationEvidence(f.cardId).requests[0]!
  expect(after.answered).toBe(false)
  expect(after.binding?.source_revision).toBe(before.binding?.source_revision)
  expect((await prepare()).outcome).toBe('already-ready')
  expect(f.posts).toHaveLength(1)
  changed = true
  await f.sources.updateContext(f.cardId)
  expect((await loadedSnapshot(f.sources)).ready).toEqual([])
  const current = f.sources.preparationEvidence(f.cardId).requests[0]!
  expect(current.answered).toBe(false)
  expect(current.binding?.source_revision).not.toBe(before.binding?.source_revision)
  const existingPackets = await f.sources.decisionPackets.ids()
  await f.sources.preparation.importComments(f.cardId, [{ id: 'late-packet', type: 'comment',
    text: `Prepared packet (Tinstar Decision Prep)\nDecision: ${f.requestId} · Prep job ${first.job_id}\nBackground: Previous assumptions.` }])
  expect(await f.sources.decisionPackets.ids()).toEqual(existingPackets)
  expect(await prepare()).toMatchObject({ outcome: 'dispatched' })
  expect(f.posts).toHaveLength(2)
}, 20_000)

it.each(['sole', 'shared'] as const)('saves a prepared answer with a %s wait', async scenario => {
  const shared = scenario === 'shared'
  const { sources, cardId, requestId } = await setup({ independentRequest: shared, waitPadding: '  ' })
  const job = await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Prepare this request' })
  const packet = preparedDecisionFixture().packet
  const request = sources.preparationEvidence(cardId).requests.find(row => row.binding?.request_id === requestId)!
  packet.binding = request.binding!
  packet.dependencies = request.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  expect(await sources.preparation.publish({ job_id: job.job_id, operation_id: 'shared-wait-packet', packet })).toMatchObject({ ready: true })
  const claim = await sources.preparedReviews.claim('fixture-owner', 'Fixture owner', { operation_id: 'shared-wait-claim', card_id: cardId })
  expect(claim.outcome).toBe('claimed')
  expect(claim.shared_wait).toBe(shared ? true : undefined)
  expect(claim.resolve_wait).toBe(scenario === 'sole' ? 'Will: Choose the bounded preview route?' : undefined)
  const saved = await sources.preparedSubmissions.submit('fixture-owner', 'Fixture owner', 'Fixture owner', {
    operation_id: 'shared-wait-answer', lease_token: claim.lease_token, packet_id: claim.packet!.id,
    packet_version: claim.packet!.version, request_id: requestId, option_id: packet.recommended_option_id,
    next: { owner: packet.authorization.next_owner, status: packet.authorization.next_status },
    ...(claim.resolve_wait ? { resolve_wait: ` ${claim.resolve_wait} ` } : {}),
  })
  expect(saved.outcome).toMatch(/^recorded/)
  const card = (await sources.snapshot(true)).intentions.data!.cards.find(card => card.id === cardId)!
  expect(card.properties.Status?.value).toBe(scenario === 'sole' ? 'Queued' : 'Waiting For')
  expect(card.properties['Waiting For']?.value).toBe(shared ? 'Will: Choose the bounded preview route?  ' : '')
  expect((await sources.workflow.preparedHistory(cardId)).some(note => note.text.includes('Existing wait retained for independent requests.'))).toBe(shared)
}, 20_000)

it('preserves inactive legacy prose when the normal wait transition rejects it', async () => {
  const { sources, cardId, requestId } = await setup({ independentRequest: true, cardStatus: 'Queued', inactiveWait: 'An old dependency note' })
  const saved = await sources.workflow.answerPrepared({
    kind: 'answer_decision', card_id: cardId, request_id: requestId, operation_id: 'new-prepared-wait',
    answer: 'Approve the preview', option_id: 'preview',
    next: { owner: 'Firstmate', status: 'Waiting For', wait: { type: 'Actor', id: 'Will', dependency: 'Approve the current preview',
      unblocks_when: 'Owner approval arrives', follow_up_by: 'Firstmate', next_check_in: new Date(Date.now() + 30 * 60_000).toISOString() } },
  }, 'Fixture owner')
  expect(saved).toMatchObject({ outcome: 'not-saved', code: 'wait-invalid' })
  const card = (await sources.snapshot(true)).intentions.data!.cards.find(card => card.id === cardId)!
  expect(card.properties.Status?.value).toBe('Queued')
  expect(card.properties['Waiting For']?.value).toBe('An old dependency note')
})

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

it('claims through MCP while cold history remains blocked and preserves Desk preparation requirements', async () => {
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
    expect(result).toMatchObject({ outcome: 'claimed', warnings: expect.arrayContaining([expect.stringContaining('publication history is unavailable')]) })
    expect(cardIds.filter(id => sources.leases.status(id) !== null)).toEqual([result.lease.card_id])
    await client.callTool({ name: 'release_claim', arguments: { lease_token: result.lease_token, reason: 'Cold-history claim verified' } })
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
    expect(freshReads).toHaveLength(15)
    expect(freshReads.every(read => read.path === `/v1/pages/${cardId}` || read.path === `/v1/blocks/${cardId}/children` || read.path === '/v1/comments')).toBe(true)
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

it('keeps one published packet Ready through fresh property/history cycles without another dispatch, then blocks a changed card', async () => {
  let changed = false, time = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(time)
  const { sources, cardId, requestId, posts, reads } = await setup({ cards: 52, wrapFetch: transport => async (input, init) => {
    const response = await transport(input, init)
    if (changed && String(input).includes('/v1/pages/')) {
      const page = await response.json()
      page.properties.Name = { type: 'title', title: [{ plain_text: 'A materially changed source card' }] }
      return Response.json(page)
    }
    return response
  } })
  await loadedSnapshot(sources)
  const job = await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Repeated refresh proof' })
  const packet = preparedDecisionFixture().packet
  const request = sources.preparationEvidence(cardId).requests[0]!
  packet.binding = request.binding!
  packet.dependencies = request.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  const published = await sources.preparation.publish({ job_id: job.job_id, operation_id: 'refresh-cycle-packet', packet })
  expect(published.ready).toBe(true)
  await sources.decisionPackets.updatePolicy('f'.repeat(32), { expected_version: 0, values: { target_ready: 20, max_preparers: 4, automatic_replenishment: true } }, 'fixture-owner')
  const initialPropertyReads = reads.filter(read => read.path === `/v1/pages/${cardId}`).length
  for (let cycle = 0; cycle < 5; cycle++) {
    time += 16_000
    vi.setSystemTime(time)
    await sources.preparation.replenish()
    await loadedSnapshot(sources)
    expect((await sources.preparedReviews.snapshot()).ready).toEqual([expect.objectContaining({ id: published.packet_id, card_id: cardId })])
    expect(posts).toHaveLength(1)
  }
  expect(reads.filter(read => read.path === `/v1/pages/${cardId}`)).toHaveLength(initialPropertyReads + 5)
  expect(await sources.decisionPackets.ids()).toEqual([published.packet_id])
  changed = true; time += 16_000
  vi.setSystemTime(time)
  await sources.preparation.replenish()
  await loadedSnapshot(sources)
  expect((await sources.preparedReviews.snapshot()).ready).toEqual([])
  expect((await sources.decisionPackets.read(published.packet_id, sources.preparationEvidence(cardId)))!.reasons.join(' ')).toContain('Dependency changed')
  expect((await sources.preparation.status()).jobs.find(row => row.id === job.job_id)).toMatchObject({ state: 'superseded', published_at: expect.any(String), readiness: { ready: false } })
  expect(posts).toHaveLength(2)
  vi.useRealTimers()
}, 60_000)

it.each(['properties', 'comments', 'body'] as const)('retains Ready through transient %s renewal failures, then blocks past the bound with the source reason', async failure => {
  let unavailable = false
  let time = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(time)
  const { sources, cardId, requestId, posts } = await setup({ wrapFetch: transport => async (input, init) => {
    const path = new URL(String(input)).pathname
    if (unavailable && (failure === 'properties' ? path.includes('/v1/pages/') : failure === 'comments' ? path === '/v1/comments' : path.includes('/v1/blocks/'))) return Response.json({}, { status: 503 })
    return transport(input, init)
  } })
  const job = await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Source failure proof' })
  const packet = preparedDecisionFixture().packet, request = sources.preparationEvidence(cardId).requests[0]!
  packet.binding = request.binding!
  packet.dependencies = request.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  const published = await sources.preparation.publish({ job_id: job.job_id, operation_id: 'source-failure-packet', packet })
  expect(published).toMatchObject({ ready: true })
  unavailable = true; time += 16_000; vi.setSystemTime(time)
  const transient = await loadedSnapshot(sources)
  expect(transient.ready).toEqual([expect.objectContaining({ id: published.packet_id })])
  expect(transient.history).toContainEqual(expect.objectContaining({ card_id: cardId, state: 'unavailable', message: expect.stringContaining('HTTP 503') }))
  for (const elapsed of [31_000, 61_000, 121_000]) {
    time += elapsed; vi.setSystemTime(time)
    await loadedSnapshot(sources)
  }
  const snapshot = await sources.preparedReviews.snapshot()
  expect(snapshot.ready).toEqual([])
  expect(snapshot.source_failures).toContainEqual({ card_id: cardId, reasons: expect.arrayContaining([expect.stringContaining('HTTP 503')]) })
  expect(snapshot.history).toContainEqual(expect.objectContaining({ card_id: cardId, state: 'unavailable', message: expect.any(String) }))
  expect((await sources.preparation.status()).jobs[0]).toMatchObject({ state: 'published', published_at: expect.any(String), readiness: { ready: false } })
  expect(posts).toHaveLength(1)
  unavailable = false
  await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Explicit recovery after outage' })
  expect((await sources.preparedReviews.snapshot()).ready).toEqual([expect.objectContaining({ id: published.packet_id })])
  expect(posts).toHaveLength(1)
}, 20_000)

it.each(['with receipt', 'without receipt'] as const)('registers a later structured answer (%s) from real history reads and never re-offers or re-prepares the request', async kind => {
  let time = Date.now(), ownerAt: string | undefined
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(time)
  const { sources, cardId, requestId, posts } = await setup({ wrapFetch: transport => async (input, init) => {
    const response = await transport(input, init)
    if (ownerAt && new URL(String(input)).pathname === '/v1/comments') {
      const body = await response.json()
      body.results.push(structuredAnswerComment(requestId, ownerAt, kind === 'with receipt'))
      return Response.json(body)
    }
    return response
  } })
  const job = await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Answer suppression proof' })
  const packet = preparedDecisionFixture().packet, request = sources.preparationEvidence(cardId).requests[0]!
  packet.binding = request.binding!
  packet.dependencies = request.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  expect(await sources.preparation.publish({ job_id: job.job_id, operation_id: 'owner-suppression-packet', packet })).toMatchObject({ ready: true })
  ownerAt = new Date(time + 1000).toISOString(); time += 16_000; vi.setSystemTime(time)
  const snapshot = await loadedSnapshot(sources)
  expect(sources.preparationEvidence(cardId).requests[0]!.answered).toBe(true)
  expect(snapshot).toMatchObject({ counts: { requests: 0, ready: 0, to_prepare: 0 }, ready: [], pending: [] })
  await sources.decisionPackets.updatePolicy('f'.repeat(32), { expected_version: 0, values: { target_ready: 20, max_preparers: 4, automatic_replenishment: true } }, 'fixture-owner')
  await sources.preparation.replenish()
  expect(await sources.preparation.prepareNow('fixture-owner', { card_id: cardId, request_id: requestId, reason: 'Do not repeat this answer' })).toMatchObject({ outcome: 'ineligible' })
  const session = await sources.preparedReviews.create('fixture-owner', { operation_id: 'answered-review-session', label: 'Answered source proof' })
  expect(await sources.preparedReviews.claim('fixture-owner', 'Fixture owner', { operation_id: 'do-not-reoffer', review_session_token: session.review_session_token })).toMatchObject({ outcome: 'no-decision-requests' })
  expect(posts).toHaveLength(1)
  expect((await sources.preparation.status()).jobs[0]).toMatchObject({ state: 'published', readiness: { ready: false } })
}, 20_000)

it('has zero Ready gaps in 1800 samples over 30 simulated minutes of paced slow renewals and transient failures, with admission off and Desk closed', async () => {
  const start = Date.now()
  let time = start, slow = false, commentReads = 0
  const waiting: Array<{ until: number; resolve(): void }> = []
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(time)
  const f = await setup({ wrapFetch: transport => async (input, init) => {
    const path = new URL(String(input)).pathname
    if (slow && (path.includes('/v1/pages/') || path.includes('/v1/blocks/') || path === '/v1/comments')) {
      // Some complete reads themselves outlive the 30-second source horizon.
      const delay = commentReads % 3 === 0 ? 35_000 : 22_000
      await new Promise<void>(resolve => waiting.push({ until: time + delay, resolve }))
      if (path === '/v1/comments' && ++commentReads % 7 === 0) return Response.json({}, { status: 503 })
    }
    return transport(input, init)
  } })
  const job = await f.sources.preparation.prepareNow('fixture-owner', { card_id: f.cardId, request_id: f.requestId, reason: 'Thirty-minute continuity proof' })
  const packet = preparedDecisionFixture().packet, request = f.sources.preparationEvidence(f.cardId).requests[0]!
  packet.binding = request.binding!
  packet.dependencies = request.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  const published = await f.sources.preparation.publish({ job_id: job.job_id, operation_id: 'thirty-minute-packet', packet })
  expect(published.ready).toBe(true)
  slow = true
  let samples = 0, gaps = 0, expiredSamples = 0
  try {
    for (let second = 1; second <= 30 * 60; second++) {
      time = start + second * 1000; vi.setSystemTime(time)
      for (const entry of waiting.filter(entry => entry.until <= time)) entry.resolve()
      for (let index = waiting.length - 1; index >= 0; index--) if (waiting[index]!.until <= time) waiting.splice(index, 1)
      // Publish the same fleet meaning with a fresh collector timestamp.
      if (second % 20 === 0) for (const source of f.config.fleet) {
        const wire = JSON.parse(await readFile(source.snapshotFile!, 'utf8'))
        wire.generated = new Date(time).toISOString()
        await writeFile(source.snapshotFile!, JSON.stringify(wire))
      }
      if (second % 5 === 0) await f.sources.preparation.replenish()
      await new Promise<void>(resolve => setImmediate(resolve))
      const evidence = f.sources.preparationEvidence(f.cardId)
      const current = await f.sources.decisionPackets.read(published.packet_id, evidence)
      samples++
      if (!current?.ready) gaps++
      const withoutRenewal = structuredClone(evidence)
      for (const row of withoutRenewal.requests) for (const dependency of row.dependencies) delete dependency.renewal_until
      if (!validateDecisionPacket(packet, withoutRenewal, time).valid) expiredSamples++
    }
    expect({ samples, gaps }).toEqual({ samples: 1800, gaps: 0 })
    expect(commentReads).toBeGreaterThan(30)
    expect(expiredSamples).toBeGreaterThan(0)
    expect((await f.sources.preparedReviews.snapshot()).ready).toEqual([expect.objectContaining({ id: published.packet_id })])
    expect(f.posts).toHaveLength(1)
    expect(await f.sources.decisionPackets.ids()).toEqual([published.packet_id])
    expect((await f.sources.decisionPackets.readPolicy('f'.repeat(32))).values.automatic_replenishment).toBe(false)
  } finally {
    slow = false
    for (const entry of waiting) entry.resolve()
    await loadedSnapshot(f.sources)
  }
}, 60_000)

it.each(['answer', 'card'] as const)('drops Ready for a positively observed %s change even when the same renewal has incomplete body history', async kind => {
  let failing = false, alternating = false, time = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(time)
  const f = await setup({ wrapFetch: transport => async (input, init) => {
    const path = new URL(String(input)).pathname
    if (failing && (alternating ? path === '/v1/comments' : path.includes('/v1/blocks/'))) return Response.json({}, { status: 503 })
    const response = await transport(input, init)
    if (failing && kind === 'card' && path.includes('/v1/pages/')) {
      const page = await response.json()
      page.properties.Name = { type: 'title', title: [{ plain_text: 'Changed while history is incomplete' }] }
      return Response.json(page)
    }
    if (failing && kind === 'answer' && path === '/v1/comments') {
      const body = await response.json()
      body.results.push(structuredAnswerComment(f.requestId, new Date(time).toISOString()))
      return Response.json(body)
    }
    return response
  } })
  const job = await f.sources.preparation.prepareNow('fixture-owner', { card_id: f.cardId, request_id: f.requestId, reason: 'Partial renewal answer proof' })
  const packet = preparedDecisionFixture().packet, request = f.sources.preparationEvidence(f.cardId).requests[0]!
  packet.binding = request.binding!
  packet.dependencies = request.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  const published = await f.sources.preparation.publish({ job_id: job.job_id, operation_id: 'partial-renewal-answer', packet })
  expect(published.ready).toBe(true)
  failing = true; time += 16_000; vi.setSystemTime(time)
  const snapshot = await loadedSnapshot(f.sources)
  expect(snapshot.ready).toEqual([])
  const evidence = f.sources.preparationEvidence(f.cardId)
  expect(evidence.requests[0]!.answered).toBe(kind === 'answer')
  expect((await f.sources.decisionPackets.read(published.packet_id, evidence))!.reasons.join(' ')).toContain(kind === 'answer' ? 'This source request already has an answer' : 'Dependency changed')
  alternating = true; time += 31_000; vi.setSystemTime(time)
  expect((await loadedSnapshot(f.sources)).ready).toEqual([])
  expect(f.sources.preparationEvidence(f.cardId).requests[0]!.answered).toBe(kind === 'answer')
  expect(f.posts).toHaveLength(1)
}, 20_000)

it('bounds retention while a renewal is still in flight', async () => {
  let time = Date.now(), delayed = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(time)
  const f = await setup({ beforeRead: async url => { if (delayed && url.pathname === '/v1/comments') await gate } })
  const job = await f.sources.preparation.prepareNow('fixture-owner', { card_id: f.cardId, request_id: f.requestId, reason: 'Stuck renewal bound' })
  const packet = preparedDecisionFixture().packet, request = f.sources.preparationEvidence(f.cardId).requests[0]!
  packet.binding = request.binding!
  packet.dependencies = request.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  expect(await f.sources.preparation.publish({ job_id: job.job_id, operation_id: 'stuck-renewal', packet })).toMatchObject({ ready: true })
  try {
    delayed = true; time += 16_000; vi.setSystemTime(time)
    expect((await f.sources.preparedReviews.snapshot()).ready).toHaveLength(1)
    time += 30_000; vi.setSystemTime(time)
    expect((await f.sources.preparedReviews.snapshot()).ready).toHaveLength(1)
    time += 180_000; vi.setSystemTime(time)
    const snapshot = await f.sources.preparedReviews.snapshot()
    expect(snapshot.ready).toEqual([])
    expect(snapshot.source_failures).toContainEqual({ card_id: f.cardId, reasons: expect.arrayContaining(['Source renewal exceeded the last-good evidence deadline.']) })
  } finally {
    delayed = false; release()
    await loadedSnapshot(f.sources)
  }
}, 20_000)
