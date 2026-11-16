import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CardLeases } from '../cardLeases'
import { DecisionPackets } from '../decisionPackets'
import { DecisionPreparation, prepSecretName, webhookMissing, type PrepCandidate } from '../decisionPrep'
import { PreparedReviews } from '../preparedReviews'
import { ReconciliationMcp } from '../mcp'
import { preparedDecisionFixture } from '../../../../test-fixtures/reconciliation/preparedDecision'
import type { DecisionPacket } from '../../../shared/decisionPacket'

const roots: string[] = []
const servers: Server[] = []
let now = Date.parse('2026-11-16T12:00:00Z')
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  now = Date.parse('2026-11-16T12:00:00Z')
})

function candidate(packet: DecisionPacket, overrides: Partial<PrepCandidate> = {}): PrepCandidate {
  return { card_id: packet.binding.card_id, request_id: packet.binding.request_id, source_revision: packet.binding.source_revision,
    card_url: `https://www.notion.so/${packet.binding.card_id}`, card_status: 'Waiting For', answered: false, leased: false, reasons: [], rank: 0, ...overrides }
}

async function harness(options: { configured?: boolean; coverage?: 'complete' | 'unknown'; status?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'decision-prep-')); roots.push(root)
  const fixture = preparedDecisionFixture(now)
  const secondId = 'b'.repeat(32)
  const second = JSON.parse(JSON.stringify(fixture.packet).replaceAll(fixture.cardId, secondId)) as DecisionPacket
  const rows = [candidate(fixture.packet), candidate(second, { rank: 1 })]
  let coverage = options.coverage ?? 'complete'
  const posts: Array<{ body: unknown; authorized: boolean }> = []
  const key = 'isolated-prep-sender'
  const stub = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      posts.push({ body: JSON.parse(Buffer.concat(chunks).toString() || '{}'), authorized: req.headers.authorization === `Bearer ${key}` })
      res.writeHead(options.status ?? 202); res.end('accepted')
    })
  })
  servers.push(stub)
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve))
  const port = (stub.address() as { port: number }).port
  const bundle = options.configured === false ? null : JSON.stringify({ url: `http://127.0.0.1:${port}/job`, key })
  const leases = new CardLeases(root, () => now)
  const packets = new DecisionPackets(leases, () => now)
  const prep = new DecisionPreparation(packets, 'board', { candidates: () => rows, coverage: () => coverage }, card => card === secondId ? { ...fixture.evidence, card_id: secondId, requests: fixture.evidence.requests.map(request => ({ ...request, binding: request.binding ? { ...second.binding } : null })) } : fixture.evidence, async name => name === prepSecretName ? bundle : null, () => now)
  return { root, fixture, second, secondId, rows, posts, key, packets, leases, prep, setCoverage: (value: 'complete' | 'unknown') => { coverage = value }, turnOn: (target = 10, workers = 3) => packets.updatePolicy('board', { expected_version: 0, values: { target_ready: target, max_preparers: workers, automatic_replenishment: true } }, 'Will') }
}

it('says the webhook is not configured and still serves policy without posting', async () => {
  const { prep, packets, posts } = await harness({ configured: false })
  await prep.replenish()
  expect(await prep.prepareNow('Will', { card_id: 'a'.repeat(32), request_id: 'preview-question', reason: 'Exercise one decision' })).toMatchObject({ outcome: 'not-configured', explanation: webhookMissing })
  expect(posts).toEqual([])
  expect(await packets.readPolicy('board')).toMatchObject({ values: { automatic_replenishment: false } })
  expect(await prep.status()).toMatchObject({ configured: false, preparer: 'Tinstar Decision Prep', explanation: webhookMissing })
})

it('serves a snapshot from known configuration while a slow secret lookup is pending', async () => {
  const { packets, fixture } = await harness()
  let complete!: (value: string | null) => void
  const pending = new Promise<string | null>(resolve => { complete = resolve })
  const prep = new DecisionPreparation(packets, 'board', { candidates: () => [], coverage: () => 'complete' }, () => fixture.evidence, () => pending)
  const reviews = new PreparedReviews(packets, 'board', () => fixture.evidence, () => ({ card_ids: [], coverage: 'complete', requests: 0 }))
  reviews.reportPreparation = () => prep.status(true)
  try {
    const snapshot = await reviews.snapshot()
    expect(snapshot.runner).toMatchObject({ configured: false, explanation: 'Checking preparer configuration.' })
  } finally { complete(null) }
  expect((await prep.status()).explanation).toBe(webhookMissing)
})

it('posts one job per eligible decision, dedupes the revision, and skips leased, answered, and Todo work', async () => {
  const { prep, posts, key, rows, fixture, turnOn, leases } = await harness()
  await prep.replenish()
  expect(posts).toEqual([])
  await turnOn(10, 1)
  rows[1]!.card_status = 'Todo'
  await prep.replenish()
  expect(posts).toHaveLength(1)
  expect(posts[0]!.authorized).toBe(true)
  expect(posts[0]!.body).toEqual({ request_id: fixture.packet.binding.request_id, card_url: `https://www.notion.so/${fixture.cardId}`, publish: { tool: 'publish_prepared_packet', job_id: expect.any(String) } })
  expect(JSON.stringify(posts.map(post => post.body))).not.toContain(key)
  await prep.replenish()
  expect(posts).toHaveLength(1)
  rows[0]!.answered = true
  rows[0]!.source_revision = 'next-revision'
  await prep.replenish()
  expect(posts).toHaveLength(1)
  rows[0]!.answered = false
  rows[0]!.leased = true
  await prep.replenish()
  expect(posts).toHaveLength(1)
  rows[0]!.leased = false
  await leases.claim([fixture.cardId], 'reviewer', 'Reviewer', 'hold-card')
  await prep.replenish()
  expect(posts).toHaveLength(1)
  expect((await prep.prepareNow('Will', { card_id: rows[1]!.card_id, request_id: rows[1]!.request_id, reason: 'Try the Todo card' })).explanation).toContain('Todo')
  expect(posts).toHaveLength(1)
})

it('fills only below the ready target and stops at the preparer cap', async () => {
  const { prep, posts, packets, fixture, rows, turnOn } = await harness()
  await packets.publish(fixture.packet, fixture.evidence, 'fixture', 'already-ready')
  await turnOn(1, 3)
  await prep.replenish()
  expect(posts).toEqual([])
  await packets.updatePolicy('board', { expected_version: 1, values: { target_ready: 2, max_preparers: 1, automatic_replenishment: true } }, 'Will')
  rows[0]!.source_revision = 'not-the-ready-revision'
  await prep.replenish()
  expect(posts).toHaveLength(1)
  expect(posts[0]!.body).toMatchObject({ request_id: rows[0]!.request_id })
})

it('prepare now dispatches one audited job while automatic replenishment is off', async () => {
  const { prep, posts, packets, fixture, setCoverage } = await harness()
  setCoverage('unknown')
  await packets.updatePolicy('board', { expected_version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: true } }, 'Will')
  await prep.replenish()
  expect(posts).toEqual([])
  await packets.updatePolicy('board', { expected_version: 1, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: false } }, 'Will')
  const prepared = await prep.prepareNow('Will', { card_id: fixture.cardId, request_id: fixture.packet.binding.request_id, reason: 'Exercise one decision' })
  expect(prepared).toMatchObject({ outcome: 'dispatched', state: 'dispatched' })
  expect(posts).toHaveLength(1)
  const again = await prep.prepareNow('Will', { card_id: fixture.cardId, request_id: fixture.packet.binding.request_id, reason: 'Exercise one decision again' })
  expect(again).toMatchObject({ outcome: 'already-preparing', job_id: prepared.job_id })
  expect(posts).toHaveLength(1)
  const events = await packets.events()
  expect(events.some(event => event.type === 'prepare-now')).toBe(true)
  expect(JSON.stringify(events)).not.toContain('isolated-prep-sender')
})

it('records webhook failures without the sender key and replenishes beyond three attempts', async () => {
  const { prep, posts, fixture, rows, turnOn } = await harness({ status: 500 })
  rows[1]!.card_status = 'Todo'
  await turnOn()
  await prep.replenish()
  await prep.replenish()
  await prep.replenish()
  await prep.replenish()
  expect(posts).toHaveLength(4)
  expect((await prep.status()).explanation).toContain('HTTP 500')
  expect(JSON.stringify(await prep.status())).not.toContain('isolated-prep-sender')
  const manual = await prep.prepareNow('Will', { card_id: fixture.cardId, request_id: fixture.packet.binding.request_id, reason: 'Retry this decision explicitly' })
  expect(manual.outcome).toBe('failed')
  expect(posts).toHaveLength(5)
})

it('publishes a valid packet to Ready and keeps an invalid packet out of Ready without claiming or answering', async () => {
  const { prep, fixture, leases, packets, root } = await harness()
  const prepared = await prep.prepareNow('Will', { card_id: fixture.cardId, request_id: fixture.packet.binding.request_id, reason: 'Publish proof' })
  const mismatch = structuredClone(fixture.packet)
  mismatch.binding.request_id = 'other-request'
  await expect(prep.publish({ job_id: prepared.job_id, operation_id: 'packet-mismatch', packet: mismatch })).rejects.toThrow('does not match')
  expect(await packets.ids()).toEqual([])
  const invalid = structuredClone(fixture.packet)
  invalid.question = 'A different question than the source?'
  const blocked = await prep.publish({ job_id: prepared.job_id, operation_id: 'packet-invalid', packet: invalid })
  expect(blocked).toMatchObject({ outcome: 'not-ready', ready: false })
  expect(blocked.reasons.join(' ')).toMatch(/question/i)
  expect(leases.status(fixture.cardId)).toBeNull()
  const published = await prep.publish({ job_id: prepared.job_id, operation_id: 'packet-valid', packet: fixture.packet })
  expect(published).toMatchObject({ outcome: 'ready', ready: true, replayed: false })
  expect(await packets.read(published.packet_id, fixture.evidence)).toMatchObject({ ready: true, prepared_by: 'Tinstar Decision Prep' })
  expect(leases.status(fixture.cardId)).toBeNull()
  const mcp = new ReconciliationMcp({ leases, preparation: prep, scene: async () => { throw new Error('publish must not read a scene') }, card: async () => { throw new Error('publish must not read a card') }, queue: async () => { throw new Error('publish must not read the queue') }, workerLinkReport: async () => { throw new Error('unused') } }, root)
  const server = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const token = (await readFile(join(root, 'mcp-token'), 'utf8')).trim()
  const client = new Client({ name: 'prep-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('publish_prepared_packet')
    const replay = JSON.parse(((await client.callTool({ name: 'publish_prepared_packet', arguments: { job_id: prepared.job_id, operation_id: 'packet-valid', packet: fixture.packet } })) as { content: Array<{ text: string }> }).content[0]!.text)
    expect(replay).toMatchObject({ outcome: 'ready', ready: true, replayed: true })
    expect(leases.status(fixture.cardId)).toBeNull()
  } finally { await client.close() }
})

it.each(['accepted', 'rejected', 'lost'] as const)('preserves publication before webhook completion: %s', async completion => {
  const { packets, fixture, rows } = await harness()
  const prep = new DecisionPreparation(packets, 'board', { candidates: () => rows, coverage: () => 'complete' },
    () => fixture.evidence, async () => JSON.stringify({ url: 'https://prep.example/job', key: 'test' }), () => now,
    async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      await prep.publish({ job_id: body.publish.job_id, operation_id: 'early-publish', packet: fixture.packet })
      if (completion === 'lost') throw new Error('Response lost')
      return new Response('', { status: completion === 'accepted' ? 202 : 500 })
    })
  const result = await prep.prepareNow('Will', { card_id: fixture.cardId, request_id: fixture.packet.binding.request_id, reason: 'Prepare' })
  expect(result).toMatchObject({ outcome: 'published', state: 'published' })
  expect(await prep.status()).toMatchObject({ preparing: 0, jobs: [{ state: 'published' }] })
  expect(await prep.publish({ job_id: result.job_id, operation_id: 'retry-publish', packet: fixture.packet })).toMatchObject({ ready: true, replayed: true })
})

it('projects the latest current-revision attempt without overriding ready or leased decisions', async () => {
  const { prep, packets, leases, fixture, rows } = await harness({ status: 500 })
  const reviews = new PreparedReviews(packets, 'board', () => fixture.evidence,
    () => ({ card_ids: [fixture.cardId], coverage: 'complete', requests: 1 }), () => now)
  reviews.reportPreparation = () => prep.status()
  const request = { card_id: fixture.cardId, request_id: fixture.packet.binding.request_id, reason: 'Prepare' }
  await prep.prepareNow('Will', request)
  expect((await reviews.snapshot()).pending[0]).toMatchObject({ state: 'Failed' })
  rows[0]!.source_revision = 'old-revision'
  for (let i = 0; i < 9; i++) await prep.prepareNow('Will', request)
  expect((await reviews.snapshot()).pending[0]).toMatchObject({ state: 'Failed' })
  fixture.evidence.requests[0]!.binding!.source_revision = 'unattempted-revision'
  expect((await reviews.snapshot()).pending[0]).toMatchObject({ state: 'Queued' })
  expect((await reviews.snapshot()).counts.to_prepare).toBe(1)
  fixture.evidence.requests[0]!.binding!.source_revision = fixture.packet.binding.source_revision
  rows[0]!.source_revision = fixture.packet.binding.source_revision
  await packets.publish(fixture.packet, fixture.evidence, 'fixture', 'ready-after-failure')
  expect((await reviews.snapshot()).pending[0]).toMatchObject({ state: 'Ready' })
  await leases.claim([fixture.cardId], 'reviewer', 'Reviewer', 'claim-ready')
  expect((await reviews.snapshot()).pending[0]).toMatchObject({ state: 'Leased' })
})

it('allows explicit preparation after rejected packets and closes expired blocked attempts', async () => {
  const { prep, packets, fixture, posts } = await harness()
  const reviews = new PreparedReviews(packets, 'board', () => fixture.evidence,
    () => ({ card_ids: [fixture.cardId], coverage: 'complete', requests: 1 }), () => now)
  reviews.reportPreparation = () => prep.status()
  const request = { card_id: fixture.cardId, request_id: fixture.packet.binding.request_id, reason: 'Retry rejected packet' }
  const first = await prep.prepareNow('Will', request)
  const invalid = structuredClone(fixture.packet)
  invalid.question = 'Different source question?'
  await prep.publish({ job_id: first.job_id, operation_id: 'rejected-first', packet: invalid })
  expect((await reviews.snapshot()).pending[0]).toMatchObject({ state: 'Failed' })
  fixture.evidence.reasons.push('Source unavailable')
  expect((await reviews.snapshot()).pending[0]).toMatchObject({ state: 'Blocked' })
  fixture.evidence.reasons.pop()
  const retry = await prep.prepareNow('Will', request)
  expect(retry).toMatchObject({ outcome: 'dispatched' })
  expect(posts).toHaveLength(2)
  await prep.publish({ job_id: retry.job_id, operation_id: 'rejected-retry', packet: invalid })
  now += 11 * 60_000
  await expect(prep.publish({ job_id: retry.job_id, operation_id: 'expired-correction', packet: fixture.packet })).rejects.toThrow('expired')
  expect((await prep.status()).jobs.filter(job => job.state === 'blocked')).toHaveLength(0)
  const fresh = await prep.prepareNow('Will', request)
  expect(fresh).toMatchObject({ outcome: 'dispatched' })
  expect(posts).toHaveLength(3)
  expect(await packets.readPolicy('board')).toMatchObject({ values: { automatic_replenishment: false } })
})

it('prevents a superseded blocked attempt from replacing its successful retry', async () => {
  const { prep, packets, fixture } = await harness()
  const request = { card_id: fixture.cardId, request_id: fixture.packet.binding.request_id, reason: 'Prepare retry' }
  const first = await prep.prepareNow('Will', request)
  const invalid = structuredClone(fixture.packet)
  invalid.question = 'Different source question?'
  await prep.publish({ job_id: first.job_id, operation_id: 'blocked-predecessor', packet: invalid })
  const retry = await prep.prepareNow('Will', request)
  expect((await prep.status()).jobs.find(job => job.id === first.job_id)).toMatchObject({ state: 'cancelled' })
  const published = await prep.publish({ job_id: retry.job_id, operation_id: 'successful-retry', packet: fixture.packet })
  const before = await packets.ids()
  await expect(prep.publish({ job_id: first.job_id, operation_id: 'late-invalid', packet: invalid })).rejects.toThrow('not open')
  await expect(prep.publish({ job_id: first.job_id, operation_id: 'late-valid', packet: fixture.packet })).rejects.toThrow('not open')
  expect(await packets.ids()).toEqual(before)
  expect(await packets.read(published.packet_id, fixture.evidence)).toMatchObject({ ready: true })
  expect(await prep.publish({ job_id: retry.job_id, operation_id: 'successful-retry', packet: fixture.packet })).toMatchObject({ ready: true, replayed: true })
})
