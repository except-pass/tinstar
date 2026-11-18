import { createServer, type RequestListener } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReconciliationSources } from '..'
import { DecisionDeskApi } from '../decisionDeskApi'
import { ReconciliationMcp } from '../mcp'
import { NotionApi } from '../notionApi'
import { deskAnswerMarker } from '../decisionEvidence'
import type { PacketContents } from '../../../shared/decisionPacket'
import type { PreparedClaimResult } from '../preparedReviews'

const board = 'f'.repeat(32)
const id = (i: number) => i.toString(16).padStart(32, '0')
const text = (content: string) => content ? [{ text: { content } }] : []
const select = (name: string) => ({ type: 'select', select: name ? { name } : null })
const rich = (value: string) => ({ type: 'rich_text', rich_text: text(value) })
const tags = (value: string) => ({ type: 'multi_select', multi_select: value ? [{ name: value }] : [] })
const statuses = ['Waiting For', 'In Progress', 'Queued', 'Todo', 'Backlog', 'Archived', 'Done']
type Property = ReturnType<typeof select | typeof tags | typeof rich> | { type: 'status'; status: { name: string } }

function page(n: number, { owner = 'Firstmate', status = 'In Progress', tag = '', wait = '', waitingId = '' } = {}) {
  const properties: Record<string, Property> = {
    Name: rich(`Throwaway card ${n}`), Status: { type: 'status', status: { name: status } },
    Owner: select(owner), 'Will action': tags(tag), 'Waiting For': rich(wait),
    'Waiting For ID': rich(waitingId), 'Waiting For Type': select(waitingId ? 'Actor' : ''),
    'Next check-in': rich('unchanged'),
  }
  return { object: 'page', id: id(n), parent: { data_source_id: board },
    last_edited_time: '2025-01-01T00:00:00Z', properties, comments: [] as string[], body: ['Review this isolated fixture.'] }
}

const contents: PacketContents = {
  summary: 'A fixture packet prepared from a card without any request record.',
  options: [
    { label: 'Approve the fixture', next: { owner: 'Firstmate', status: 'Queued' } },
    { label: 'Keep reviewing', next: { status: 'Waiting For', waiting_for: 'Alice: Look at the evidence', waiting_for_type: 'Actor', waiting_for_id: 'Alice' } },
    { label: 'Record only' },
  ],
  recommendation: 'Approve the fixture.',
  links: [{ label: 'Fixture evidence', url: 'https://example.com/fixture' }],
}

function listen(handler: RequestListener) {
  const server = createServer(handler)
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      close: () => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections() }) })
  }))
}
const fixtures: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of fixtures.splice(0).reverse()) await cleanup()
})

async function setup(cards: ReturnType<typeof page>[], autoPublish = true, losePatch = false) {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-decision-loop-'))
  fixtures.push(() => rm(root, { recursive: true, force: true }))
  const published: unknown[] = []
  const jobs: Array<{ card_url: string; publish: { job_id: string; tool: string } }> = []
  const writes: Array<{ card: string; type: string; token: string | null }> = []
  type Call = (name: string, args: Record<string, unknown>) => Promise<any>
  let tool: Call
  const webhook = await listen(async (req, res) => {
    try {
      expect(req.method).toBe('POST')
      expect(req.headers.authorization).toBe('Bearer fixture-webhook-key')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof jobs)[number]
      jobs.push(job)
      if (autoPublish) published.push(await tool(job.publish.tool, { job_id: job.publish.job_id, packet: contents }))
      res.writeHead(202).end()
    } catch { res.writeHead(500).end() }
  })
  fixtures.push(webhook.close)
  const provider: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin === webhook.url) return fetch(input, init)
    expect(url.origin).toBe('https://api.notion.com')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (url.pathname.endsWith('/query')) return Response.json({ results: cards, has_more: false })
    if (url.pathname === `/v1/data_sources/${board}`) return Response.json({
      object: 'data_source', properties: {
        Name: rich(''), Owner: select(''), Status: { type: 'status', status: { options: statuses.map(name => ({ name })) } },
      },
    })
    const cardId = url.searchParams.get('block_id') ?? body.parent?.page_id ?? url.pathname.split('/')[3]
    const card = cards.find(row => row.id === cardId)
    if (!card) return new Response(null, { status: 404 })
    if (method !== 'GET') writes.push({ card: card.id, type: method, token: new Headers(init?.headers).get('Authorization') })
    if (url.pathname === '/v1/comments') {
      if (method === 'POST') card.comments.push(body.rich_text.map((item: { text: { content: string } }) => item.text.content).join(''))
      return Response.json({ results: card.comments.map((entry, index) => ({ id: `comment-${index}`, rich_text: text(entry) })), has_more: false })
    }
    if (url.pathname.endsWith('/children')) return Response.json({
      results: card.body.map((entry, index) => ({ id: `block-${index}`, type: 'paragraph', paragraph: { rich_text: text(entry) } })),
      has_more: false,
    })
    if (method === 'PATCH') {
      for (const [name, change] of Object.entries(body.properties)) Object.assign(card.properties[name]!, change)
      if (losePatch) { losePatch = false; throw new TypeError('Response lost after applying the properties') }
    }
    return Response.json(card)
  }
  const sources = new ReconciliationSources({ warnings: [], fleet: [], notion: { token: 'integration-writer', dataSourceId: board } },
    provider, new NotionApi(provider, 0), root, async () => JSON.stringify({ url: webhook.url, key: 'fixture-webhook-key' }))
  const mcp = new ReconciliationMcp(sources, root)
  const connect = async () => {
    const server = mcp.createServer('owner-chatgpt')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'fixture', version: '1' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    fixtures.push(async () => { await client.close(); await server.close() })
    const call: Call = async (name, args) => {
      const raw = await client.callTool({ name, arguments: args })
      if (!Array.isArray(raw.content) || raw.content[0]?.type !== 'text') throw new Error(`Missing text result for ${name}`)
      return JSON.parse(raw.content[0].text)
    }
    return call
  }
  tool = await connect()
  const api = new DecisionDeskApi(sources.decisionPackets, async req => req.headers['tailscale-user-login'] === 'will@example.test',
    sources.preparedReviews, sources.preparedSubmissions)
  const browser = await listen((req, res) => { void api.handle(req, res) })
  fixtures.push(browser.close)
  const web = async (path: string, body?: unknown, authorized = true) => {
    const res = await fetch(`${browser.url}/api/reconciliation/decision-desk/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-tinstar-ui': '1', ...(authorized ? { 'tailscale-user-login': 'will@example.test' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return res.json()
  }
  return { sources, jobs, tool, connect, published, writes, web }
}

describe('prepared-card loop', () => {
  it('pushes batches of ten and claims, reads and answers ten throwaway cards through ChatGPT', async () => {
    const cards = Array.from({ length: 22 }, (_, n) => page(n + 1,
      n % 3 === 0 ? { tag: 'Decision' } : n % 3 === 1 ? { owner: 'Will' } : { status: 'Waiting For', waitingId: 'Will', wait: 'Will: Decide' }))
    const deferred = statuses.slice(-4).map((status, n) => page(100 + n, { status, owner: 'Will', tag: 'Decision' }))
    const { sources, jobs, tool, connect, published, writes, web } = await setup([...cards, ...deferred])
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(10)
    expect(published).toHaveLength(10)
    expect(published).toEqual(Array(10).fill(expect.objectContaining({ outcome: 'published' })))
    expect((await web('snapshot')).data.counts.ready).toBe(10)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(10)

    const other = await connect()
    let held: PreparedClaimResult = await tool('claim_next_card', { operation_id: 'first' })
    expect(await other('claim_card', { operation_id: 'conflict', card_id: held.lease!.card_id })).toMatchObject({ code: 'card-held' })
    expect(await other('claim_card', { operation_id: 'unprepared', card_id: id(99) })).toMatchObject({ outcome: 'no-prepared-decisions' })
    expect(await other('claim_card', { operation_id: 'deferred', card_id: deferred[0]!.id })).toMatchObject({ outcome: 'no-prepared-decisions' })

    const answered = new Set<string>()
    for (let i = 0; i < 10; i++) {
      expect(held).toMatchObject({ outcome: 'claimed', packet: { packet: { summary: contents.summary, recommendation: contents.recommendation,
        options: [{ id: '1' }, { id: '2' }, { id: '3' }].map(option => expect.objectContaining(option)) } } })
      const card = cards.find(card => card.id === held.lease!.card_id)!
      expect(answered.has(card.id)).toBe(false)
      answered.add(card.id)
      const answer = `  Approve throwaway card ${i + 1}.\nOnly this fixture.  `
      const input = { operation_id: `answer-${i}`, lease_token: held.lease_token, answer, option_id: '1' }
      const result = await tool('submit_prepared_decision', input)
      expect(result.outcome).toBe(i < 9 ? 'recorded' : 'recorded-empty')
      expect((await tool('submit_prepared_decision', input)).outcome).toBe(result.outcome)
      expect(card.comments).toEqual([expect.stringContaining(`Will chose: Approve the fixture\n\n${answer}\n${deskAnswerMarker}`)])
      expect(card.properties).toMatchObject({ Owner: { select: { name: 'Firstmate' } }, Status: { status: { name: 'Queued' } },
        'Will action': { multi_select: [] }, 'Waiting For': { rich_text: [] }, 'Waiting For Type': { select: null },
        'Next check-in': { rich_text: text('unchanged') } })
      held = result.next
    }
    expect(answered.size).toBe(10)
    expect(writes).toHaveLength(20)
    expect(writes.every(write => write.token === 'Bearer integration-writer')).toBe(true)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(20)
    expect(new Set(jobs.map(job => job.card_url)).size).toBe(20)
    expect((await web('snapshot')).data.counts.ready).toBe(10)
  }, 20_000)

  it('names missing publication fields, keeps packets across time, and invalidates changed card content', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const card = page(1, { tag: 'Decision' })
    const { sources, jobs, tool } = await setup([card], false)
    await sources.preparation.replenish()
    const job_id = jobs[0]!.publish.job_id
    expect(await tool('publish_prepared_packet', { job_id, packet: { ...contents, summary: undefined } }))
      .toMatchObject({ outcome: 'not-saved', issue_paths: ['packet.summary'] })
    expect(await tool('publish_prepared_packet', { job_id, packet: contents })).toMatchObject({ outcome: 'published' })
    now += 90 * 86_400_000
    card.last_edited_time = new Date(now).toISOString()
    const held = await tool('claim_prepared_decision', { operation_id: 'after-90-days', card_id: card.id })
    expect(held).toMatchObject({ outcome: 'claimed', packet: { packet: { card_id: card.id } } })
    card.comments.push('A new fact changes which option is best.')
    expect(await tool('submit_prepared_decision', { operation_id: 'stale-answer', lease_token: held.lease_token, answer: 'Do it', option_id: '1' }))
      .toMatchObject({ outcome: 'packet-invalidated' })
    expect(card.comments).toEqual(['A new fact changes which option is best.'])
    await tool('release_prepared_decision', { operation_id: 'release-stale', lease_token: held.lease_token })
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)
    card.body.push('Changed body during preparation.')
    expect(await tool('publish_prepared_packet', { job_id: jobs[1]!.publish.job_id, packet: contents }))
      .toMatchObject({ outcome: 'operation-conflict', message: expect.stringContaining('card changed') })
  })

  it('uses the same scoped answer over the browser API and does not offer an answered Will-owned card again', async () => {
    const card = page(1, { owner: 'Will', tag: 'Decision' }), other = page(2, { tag: 'Decision' })
    const { sources, jobs, tool, web } = await setup([card, other])
    await sources.preparation.replenish()
    expect(await web('snapshot', undefined, false)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const session = await web('sessions', { operation_id: 'browser-open', label: 'Fixture review' })
    const review_session_token = session.data.review_session_token
    const held = await web('claim', { operation_id: 'scope', review_session_token, card_id: card.id })
    expect(held.data).toMatchObject({ outcome: 'claimed', packet: { packet: { card_id: card.id } } })
    const decision = await web('submit', { operation_id: 'browser-answer', review_session_token, lease_token: held.data.lease_token,
      option_id: '2', answer: 'Leave this with Alice.\nThank you.' })
    expect(decision.data).toMatchObject({ outcome: 'recorded-empty', next: { outcome: 'no-prepared-decisions' } })
    expect(card.properties).toMatchObject({ Owner: { select: { name: 'Will' } }, 'Will action': { multi_select: [] },
      Status: { status: { name: 'Waiting For' } }, 'Waiting For': { rich_text: text('Alice: Look at the evidence') },
      'Waiting For Type': { select: { name: 'Actor' } }, 'Waiting For ID': { rich_text: text('Alice') } })
    expect(card.comments).toHaveLength(1)
    expect(card.comments[0]).toContain('Will chose: Keep reviewing\n\nLeave this with Alice.\nThank you.')
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)
    expect(await tool('claim_card', { operation_id: 'answered', card_id: card.id })).toMatchObject({ outcome: 'no-prepared-decisions' })
    expect(await tool('claim_next_prepared_decision', { operation_id: 'other-chat' })).toMatchObject({ outcome: 'claimed', lease: { card_id: other.id } })
  })

  it('resumes an uncertain answer on the same lease after timeout without duplicating the comment or PATCH', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const card = page(1, { owner: 'Will', tag: 'Decision' })
    const { sources, tool, writes } = await setup([card], true, true)
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'before-interrupted-write', card_id: card.id })
    const answer = { operation_id: 'interrupted-write', lease_token: held.lease_token, option_id: '1', answer: 'Keep my answer exactly.' }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'save-unconfirmed' })
    expect(card.comments).toHaveLength(1)
    expect(sources.leases.pendingWrites()).toHaveLength(1)
    now += 61 * 60_000
    await sources.recoverSourceWrites()
    expect(await tool('claim_card', { operation_id: 'competing-chat', card_id: card.id })).not.toHaveProperty('lease')
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.comments).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH'])
    expect(sources.leases.pendingWrites()).toHaveLength(0)
    expect(sources.leases.status(card.id)).toBeNull()
  })
})
