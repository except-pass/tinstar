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
import { DecisionPreparation } from '../decisionPrep'
import { actionableDecisionCard, decisionCardSource, deskAnswerMarker } from '../decisionEvidence'
import { jiraCardPrefix } from '../../../shared/workIdentity'
import { waitLine } from '../../../shared/waitingForPolicy'
import type { PacketContents } from '../../../shared/decisionPacket'
import type { PreparedClaimResult } from '../preparedReviews'

const board = 'f'.repeat(32)
const id = (i: number) => i.toString(16).padStart(32, '0')
const text = (content: string) => content ? [{ text: { content } }] : []
const select = (name: string) => ({ type: 'select' as const, select: name ? { name } : null })
const rich = (value: string) => ({ type: 'rich_text' as const, rich_text: text(value) })
const tags = (value: string) => ({ type: 'multi_select' as const, multi_select: value ? [{ name: value }] : [] })
const statuses = ['Waiting For', 'In Progress', 'Queued', 'Waiting for Prod Release', 'Todo', 'Backlog', 'Archived', 'Done']
type Property = ReturnType<typeof select | typeof tags | typeof rich> | { type: 'status'; status: { name: string } }

function page(n: number, { owner = 'Firstmate', status = 'In Progress', tag = '', wait = '', waitingId = '' } = {}) {
  const properties: Record<string, Property> = {
    Name: rich(`Throwaway card ${n}`), Status: { type: 'status', status: { name: status } },
    Owner: select(owner), 'Will action': tags(tag), 'Waiting For': rich(wait),
    'Waiting For ID': rich(waitingId), 'Waiting For Type': select(waitingId ? 'Actor' : ''),
    'Next check-in': rich('unchanged'),
    'Last touched by': rich(''),
  }
  return { object: 'page', id: id(n), parent: { data_source_id: board },
    last_edited_time: '2025-01-01T00:00:00Z', properties, comments: [] as string[], body: ['Review this isolated fixture.'] }
}

const contents: PacketContents = {
  summary: 'A fixture packet prepared from a card without any request record.',
  options: [
    { label: 'Approve the fixture' },
    { label: 'Keep reviewing' },
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

async function setup(cards: ReturnType<typeof page>[], autoPublish = true, firstPatchFailure?: 'lost' | 'rejected') {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-decision-loop-'))
  fixtures.push(() => rm(root, { recursive: true, force: true }))
  const published: unknown[] = []
  const jobs: Array<{ card_url: string; source_question: string; source_revision: string; publish: { tool: string; job_id: string } }> = []
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
    if (url.pathname === '/v1/users/me') return Response.json({ type: 'bot', id: 'fixture-writer' })
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
      return Response.json({ results: card.comments.map((entry, index) => ({ id: `comment-${index}`, created_by: { id: 'fixture-writer' }, rich_text: text(entry) })), has_more: false })
    }
    if (url.pathname.endsWith('/children')) return Response.json({
      results: card.body.map((entry, index) => ({ id: `block-${index}`, type: 'paragraph', paragraph: { rich_text: text(entry) } })),
      has_more: false,
    })
    if (method === 'PATCH') {
      if (firstPatchFailure === 'rejected') {
        firstPatchFailure = undefined
        return new Response(null, { status: 400 })
      }
      for (const [name, change] of Object.entries(body.properties)) Object.assign(card.properties[name]!, change)
      if (firstPatchFailure === 'lost') { firstPatchFailure = undefined; throw new TypeError('Response lost after applying the properties') }
    }
    return Response.json(card)
  }
  const sources = new ReconciliationSources({ warnings: [], fleet: [], notion: { token: 'integration-writer', dataSourceId: board } },
    provider, new NotionApi(provider, 0), root, async () => JSON.stringify({ url: webhook.url, key: 'fixture-webhook-key' }))
  const mcp = new ReconciliationMcp(sources, root)
  const connect = async (actor = 'owner-chatgpt') => {
    const server = mcp.createServer(actor)
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
  it.each([
    ['withdraw_decision', false, false], ['withdraw_decision', true, false],
    ['supersede_decision', false, false], ['supersede_decision', false, true],
  ] as const)('%s retires the old prepared packet with sibling %s and storage failure %s', async (kind, sibling, failRetirement) => {
    const card = page(1)
    const { sources, jobs, tool, web } = await setup([card])
    const request_id = 'fixture-original'
    const replacement = { request_id: 'fixture-replacement', requested_from: 'Will', question: 'Review the corrected fixture? Tin Star operation: ["waiting-on-main",' }
    expect(await tool('update_work', { card_id: card.id, operation_id: 'publish-fixture', kind: 'request_decision',
      request_id, requested_from: 'Will', question: 'Review the first fixture?' })).toMatchObject({ outcome: 'saved' })
    if (sibling) expect(await tool('update_work', { card_id: card.id, operation_id: 'publish-sibling', kind: 'request_decision',
      request_id: 'fixture-sibling', requested_from: 'Will', question: 'Review the sibling fixture?' })).toMatchObject({ outcome: 'saved' })
    await sources.preparation.replenish()
    const before = await web('snapshot')
    expect(before.data.ready).toHaveLength(1)
    const oldPacket = before.data.ready[0].id

    const retraction = { card_id: card.id, operation_id: 'retract-fixture', kind, request_id, reason: 'Fixture needs correction: Tin Star prepared packet:',
      ...(kind === 'supersede_decision' ? { replacement } : {}) }
    if (failRetirement) {
      vi.spyOn(sources.decisionPackets, 'invalidateInStorage').mockImplementationOnce(() => { throw new Error('Fixture storage failure') })
      expect(await tool('update_work', retraction)).toMatchObject({
        outcome: 'partially-saved', code: 'packet-retirement-unconfirmed', saved_fields: expect.arrayContaining(['note']),
      })
    }
    expect(await tool('update_work', retraction)).toMatchObject({ outcome: 'saved' })
    expect((await web('snapshot')).data.ready).toEqual([])
    expect(sources.leases.readStorage(db => sources.decisionPackets.currentInStorage(db, card.id))).toBeNull()
    const context = await sources.card(card.id, true)
    const auditId = context.blocks.find(block => block.text.includes(`Operation: ${kind}`))!.id
    expect(context.answerSources).toMatchObject({
      excluded: expect.arrayContaining(['comment-0', auditId]),
      replacements: kind === 'supersede_decision' ? [{ sourceId: auditId, id: replacement.request_id, question: replacement.question }] : [],
    })
    expect(await tool('update_work', { card_id: card.id, operation_id: 'answer-audit', kind: 'answer_decision',
      request_id: auditId, answer: 'Approved', next: { owner: 'Firstmate', status: 'Queued' } })).toMatchObject({
      outcome: 'not-saved', code: 'decision-not-open',
    })

    await sources.preparation.replenish()
    const after = await web('snapshot')
    if (kind === 'withdraw_decision' && !sibling) {
      expect(jobs).toHaveLength(1)
      expect(after.data.ready).toEqual([])
      expect(after.data.pending).toEqual([])
    } else {
      expect(jobs).toHaveLength(2)
      expect(jobs[1]!.source_question).toBe('Throwaway card 1')
      expect(after.data.ready).toHaveLength(1)
      expect(after.data.ready[0].id).not.toBe(oldPacket)
    }
  })

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
    let expectedPatches = 0
    for (let i = 0; i < 10; i++) {
      expect(held).toMatchObject({ outcome: 'claimed', packet: { packet: { summary: contents.summary, recommendation: contents.recommendation,
        options: [{ id: '1' }, { id: '2' }, { id: '3' }].map(option => expect.objectContaining(option)) } } })
      const card = cards.find(card => card.id === held.lease!.card_id)!
      expect(answered.has(card.id)).toBe(false)
      answered.add(card.id)
      const waiting = card.properties.Status?.type === 'status' && card.properties.Status.status.name === 'Waiting For'
      const previous = structuredClone(card.properties)
      if (waiting || previous['Will action']?.type === 'multi_select' && previous['Will action'].multi_select.length) expectedPatches++
      const answer = `  Approve throwaway card ${i + 1}.\nOnly this fixture.  `
      const input = { operation_id: `answer-${i}`, lease_token: held.lease_token, answer, option_id: '1' }
      const result = await tool('submit_prepared_decision', input)
      expect(result.outcome).toBe(i < 9 ? 'recorded' : 'recorded-empty')
      expect((await tool('submit_prepared_decision', input)).outcome).toBe(result.outcome)
      expect(card.comments).toEqual([expect.stringContaining(`Will chose: Approve the fixture\n\n${answer}\n${deskAnswerMarker}`)])
      expect(card.properties).toMatchObject({ Owner: waiting ? { select: { name: 'Firstmate' } } : previous.Owner,
        Status: waiting ? { status: { name: 'Queued' } } : previous.Status,
        'Will action': { multi_select: [] }, 'Waiting For': { rich_text: [] }, 'Waiting For Type': { select: null },
        'Next check-in': { rich_text: text('unchanged') } })
      held = result.next
    }
    expect(answered.size).toBe(10)
    expect(writes).toHaveLength(10 + expectedPatches)
    expect(writes.every(write => write.token === 'Bearer integration-writer')).toBe(true)
    let ready = 0
    for (let pass = 0; pass < 4 && ready < 10; pass++) {
      await sources.preparation.replenish()
      ready = (await web('snapshot')).data.counts.ready
    }
    expect(ready).toBeGreaterThanOrEqual(10)
    expect(new Set(jobs.map(job => job.card_url)).size).toBe(jobs.length)
  }, 40_000)

  it.each([
    ['owner-chatgpt', 'Will chose'],
    ['Firstmate', "Firstmate chose on Will's behalf"],
    ['Tin Star MCP', "Chosen on Will's behalf (not by Will)"],
    ['reviewer@example.test', "Chosen on Will's behalf (not by Will)"],
  ])('attributes a prepared answer submitted by %s', async (actor, attribution) => {
    const card = page(1, { tag: 'Decision' })
    const { sources, connect } = await setup([card])
    const notify = vi.fn(async () => {})
    sources.workflow.onChange = notify
    await sources.preparation.replenish()
    const caller = await connect(actor)
    const held = await caller('claim_card', { operation_id: 'attribution-claim', card_id: card.id })
    expect(held.outcome).toBe('claimed')
    const answer = 'Proceed with the fixture.'
    const input = { operation_id: 'attribution-answer', lease_token: held.lease_token, answer, option_id: '1' }
    expect(await caller('submit_prepared_decision', input)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.comments).toEqual([expect.stringContaining(`${attribution}: Approve the fixture\n\n${answer}\n${deskAnswerMarker}`)])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ notes: card.comments }))
  })

  it('keeps exactly ten jobs outstanding across refill ticks while callbacks are slow', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cards = Array.from({ length: 50 }, (_, n) => page(n + 1, { owner: 'Will' }))
    const { sources, jobs, web } = await setup(cards, false)
    await sources.preparation.replenish()
    for (let tick = 0; tick < 3; tick++) {
      now += 5_000
      await sources.preparation.replenish()
    }
    expect(jobs).toHaveLength(10)
    expect((await web('snapshot')).data.counts).toMatchObject({ ready: 0, preparing: 10 })
  })

  it('tops up nine jobs around a stalled callback and reuses its slot at expiry', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cards = Array.from({ length: 20 }, (_, n) => page(n + 1, { owner: 'Will' }))
    const { sources, tool, jobs } = await setup(cards, false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(10)
    for (const { publish } of jobs.slice(0, 9)) {
      expect(await tool(publish.tool, { job_id: publish.job_id, packet: contents })).toMatchObject({ outcome: 'published' })
    }
    now += 60_000
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(19)
    expect(new Set(jobs.map(job => job.card_url)).size).toBe(19)
    expect((await sources.preparation.status()).preparing).toBe(10)
    now += 13 * 60_000
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(19)
    now += 60_000
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(20)
    expect(jobs[19]!.card_url).toBe(jobs[9]!.card_url)
    expect(await tool('publish_prepared_packet', { job_id: jobs[9]!.publish.job_id, packet: contents }))
      .toMatchObject({ outcome: 'operation-conflict', message: expect.stringContaining('expired') })
  })

  it('publishes a scrubbed webhook job through its callback and makes it Ready', async () => {
    const card = page(1, { tag: 'Decision' })
    card.properties.Name = rich('Review token=fixture-private-token please')
    const { sources, jobs, published, web } = await setup([card])
    await sources.preparation.replenish()
    expect(jobs).toEqual([{
      card_url: expect.stringContaining(card.id),
      source_question: 'Review token=[credential omitted] please',
      source_revision: expect.any(String),
      publish: { tool: 'publish_prepared_packet', job_id: expect.any(String) },
    }])
    expect(jobs[0]!.source_revision).not.toBe(jobs[0]!.publish.job_id)
    expect(published).toEqual([{ outcome: 'published', job_id: jobs[0]!.publish.job_id, packet_id: expect.any(String) }])
    expect((await web('snapshot')).data).toMatchObject({ counts: { ready: 1 }, ready: [{ card_id: card.id }] })
  })

  it('keeps the Jira pilot out of preparation', async () => {
    const card = page(1, { tag: 'Decision' })
    const { sources } = await setup([card])
    const live = await sources.currentCard(card.id)
    const jira = { ...live, id: jiraCardPrefix + '1' }
    expect(actionableDecisionCard(jira)).toBe(false)
    const push = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const prep = new DecisionPreparation(sources.decisionPackets, {
      refreshQueue: async () => [jira],
      read: async () => decisionCardSource(jira, []),
      exclusive: (card, perform) => sources.workflow.exclusive(card, perform),
    }, async () => JSON.stringify({ url: 'https://example.test/webhook', key: 'fixture' }), push)
    await prep.replenish()
    expect(push).not.toHaveBeenCalled()
  })

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

  it('uses the fixed browser handoff and allows a new revision without replaying the old answer', async () => {
    const card = page(1, { owner: 'Will', tag: 'Decision', status: 'Waiting for Prod Release' }), other = page(2, { tag: 'Decision' })
    const { sources, jobs, tool, web } = await setup([card, other], false)
    await sources.preparation.replenish()
    for (const { publish } of jobs) {
      expect(await tool(publish.tool, { job_id: publish.job_id, packet: { ...contents,
        options: contents.options.map(option => ({ ...option, next: { status: 'Done', owner: 'Will' } })),
      } })).toMatchObject({ outcome: 'published' })
    }
    expect(await web('snapshot', undefined, false)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const session = await web('sessions', { operation_id: 'browser-open', label: 'Fixture review' })
    const review_session_token = session.data.review_session_token
    const held = await web('claim', { operation_id: 'scope', review_session_token, card_id: card.id })
    expect(held.data).toMatchObject({ outcome: 'claimed', packet: { packet: { card_id: card.id } } })
    expect(held.data.packet.packet.options[1]).toEqual({ id: '2', label: 'Keep reviewing' })
    const answer = { operation_id: 'browser-answer', review_session_token, lease_token: held.data.lease_token,
      option_id: '2', answer: 'Leave this with Alice.\nThank you.' }
    expect((await web('submit', answer)).data).toMatchObject({ outcome: 'recorded-empty', next: { outcome: 'no-prepared-decisions' } })
    expect(card.properties).toMatchObject({ Owner: { select: { name: 'Will' } }, 'Will action': { multi_select: [] },
      Status: { status: { name: 'Waiting for Prod Release' } }, 'Waiting For': { rich_text: [] },
      'Waiting For Type': { select: null }, 'Waiting For ID': { rich_text: [] } })
    expect(card.comments).toHaveLength(1)
    expect(card.comments[0]?.split('\n')[0]).toBe('Will chose: Keep reviewing')
    expect(card.comments[0]).toContain('\n\nLeave this with Alice.\nThank you.')
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)
    expect(await tool('claim_card', { operation_id: 'answered', card_id: card.id })).toMatchObject({ outcome: 'no-prepared-decisions' })
    expect(await tool('claim_next_prepared_decision', { operation_id: 'other-chat' })).toMatchObject({ outcome: 'claimed', lease: { card_id: other.id } })

    card.properties.Owner = select('Will')
    card.properties.Status = { type: 'status', status: { name: 'Waiting for Prod Release' } }
    card.properties['Will action'] = tags('Decision')
    await sources.snapshot(true)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)

    card.body.push('A second question requires a new decision.')
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(3)
    expect(await tool('publish_prepared_packet', { job_id: jobs[2]!.publish.job_id, packet: contents })).toMatchObject({ outcome: 'published' })
    expect((await web('submit', answer)).data).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.comments).toHaveLength(1)
    const reopened = await web('claim', { operation_id: 'reopened', review_session_token, card_id: card.id })
    expect(reopened.data).toMatchObject({ outcome: 'claimed' })
    expect((await web('submit', { ...answer, operation_id: 'second-answer', lease_token: reopened.data.lease_token })).data)
      .toMatchObject({ outcome: 'recorded-empty' })
    expect(card.comments).toHaveLength(2)
  })

  it('keeps Alice assigned when Will answers a tag-only card waiting on deployment', async () => {
    const card = page(1, { owner: 'Alice', tag: 'Decision', status: 'Waiting For', waitingId: 'deploy', wait: 'Deployment pending' })
    card.properties['Waiting For Type'] = select('Event')
    const { sources, tool } = await setup([card])
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'alice-claim', card_id: card.id })
    expect(held).toMatchObject({ outcome: 'claimed' })
    const properties = structuredClone(card.properties)
    properties['Will action'] = tags('')
    expect(await tool('submit_prepared_decision', { operation_id: 'alice-answer', lease_token: held.lease_token,
      option_id: '1', answer: 'Alice should continue after deployment.' })).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.properties).toEqual(properties)
    expect(card.comments).toHaveLength(1)
  })

  it.each(['retry', 'released retry', 'released refill'] as const)('completes a saved answer through %s and retains independent waits', async recovery => {
    const will = waitLine({ type: 'Actor', id: 'Will', dependency: 'Approve the release',
      unblocks_when: 'Will decides', follow_up_by: 'Firstmate' })
    const deploy = waitLine({ type: 'Event', id: 'deploy', dependency: 'Production deployment',
      unblocks_when: 'Deployment completes', follow_up_by: 'Firstmate' })
    const willPrimary = recovery === 'retry'
    const card = page(1, { owner: 'Firstmate', status: 'Waiting For', waitingId: willPrimary ? 'Will' : 'deploy',
      wait: (willPrimary ? [will, deploy] : [deploy, will]).join('\n') })
    card.properties['Waiting For Type'] = select(willPrimary ? 'Actor' : 'Event')
    const { sources, connect, writes, jobs } = await setup([card], true, 'rejected')
    const tool = await connect('Firstmate')
    const notify = vi.fn(async () => {})
    sources.workflow.onChange = notify
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'wait-claim', card_id: card.id })
    expect(held).toMatchObject({ outcome: 'claimed' })
    const answer = { operation_id: 'wait-answer', lease_token: held.lease_token, option_id: '1', answer: 'Proceed when deployed.' }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'save-unconfirmed' })
    expect(card.comments).toHaveLength(1)
    const expectedNote = card.comments[0]!
    expect(expectedNote).toMatch(/^Firstmate chose on Will's behalf: /)
    const legacyNote = expectedNote.replace(/^Firstmate chose on Will's behalf:/, 'Will chose:')
    card.comments[0] = legacyNote
    if (recovery !== 'retry') {
      expect(await sources.leases.ownerRelease(card.id, held.lease.generation, 'Release fixture lease')).toMatchObject({ outcome: 'released' })
      expect(await tool('claim_card', { operation_id: 'competing-wait', card_id: card.id })).not.toHaveProperty('packet')
    }

    if (recovery === 'released refill') {
      await sources.preparation.replenish()
    } else expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.properties).toMatchObject({ Owner: { select: { name: 'Firstmate' } }, Status: { status: { name: 'Waiting For' } },
      'Waiting For': { rich_text: text(deploy) }, 'Waiting For Type': { select: { name: 'Event' } },
      'Waiting For ID': { rich_text: text('deploy') } })
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.comments).toEqual([legacyNote])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ notes: [expectedNote] }))
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH', 'PATCH'])
    expect(sources.leases.status(card.id)).toBeNull()
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
  })

  it.each(['retry', 'refill'] as const)('recovers a tag-only Firstmate card through %s', async recovery => {
    const card = page(1, { owner: 'Firstmate', tag: 'Decision' })
    const { sources, tool, writes } = await setup([card], true, 'rejected')
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'tag-only-claim', card_id: card.id })
    const answer = { operation_id: 'tag-only-answer', lease_token: held.lease_token, option_id: '1', answer: 'Proceed.' }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'save-unconfirmed' })
    if (recovery === 'refill') {
      await sources.preparation.replenish()
      expect(card.properties['Will action']).toEqual(tags(''))
    }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.properties).toMatchObject({ Owner: select('Firstmate'), 'Will action': tags('') })
    expect(card.comments).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH', 'PATCH'])
  })

  it.each(['retry', 'refill'] as const)('preserves a later assignment during %s recovery', async recovery => {
    const card = page(1, { owner: 'Will', tag: 'Decision', status: 'Waiting For', waitingId: 'Will', wait: 'Will: Decide' })
    const { sources, tool, writes } = await setup([card], true, 'rejected')
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'claim-before-reassignment', card_id: card.id })
    const answer = { operation_id: 'answer-before-reassignment', lease_token: held.lease_token, option_id: '1', answer: 'Proceed.' }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'save-unconfirmed' })
    expect(await sources.leases.ownerRelease(card.id, held.lease.generation, 'Release fixture lease')).toMatchObject({ outcome: 'released' })
    card.properties.Owner = select('Alice')
    const properties = structuredClone(card.properties)
    if (recovery === 'refill') {
      await sources.preparation.replenish()
      expect((await sources.preparedSubmissions.metrics()).reviewed_today_utc).toBe(1)
    }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.properties).toEqual(properties)
    expect(card.comments).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH'])
  })

  it('preserves a replacement Merge tag when recovering a saved Decision answer', async () => {
    const card = page(1, { owner: 'Firstmate', tag: 'Decision' })
    const { sources, tool, writes } = await setup([card], true, 'rejected')
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'claim-decision-tag', card_id: card.id })
    const answer = { operation_id: 'answer-decision-tag', lease_token: held.lease_token, option_id: '1', answer: 'Proceed.' }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'save-unconfirmed' })
    card.properties['Will action'] = tags('Merge')
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.properties['Will action']).toEqual(tags('Merge'))
    expect(card.comments).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH'])
  })

  it.each(['closed', 'new discussion'] as const)('preserves a saved answer and leaves properties alone after %s', async change => {
    const card = page(1, { owner: 'Will', tag: 'Decision' })
    const { sources, tool, writes } = await setup([card], true, 'rejected')
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'claim-before-change', card_id: card.id })
    const answer = { operation_id: 'answer-before-change', lease_token: held.lease_token, option_id: '1', answer: 'Proceed on the original ask.' }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'save-unconfirmed' })
    if (change === 'closed') {
      await sources.leases.ownerRelease(card.id, held.lease.generation, 'Release fixture lease')
      card.properties.Status = { type: 'status', status: { name: 'Done' } }
    } else {
      card.comments.push('New information changes the decision.')
    }
    const properties = structuredClone(card.properties)
    if (change === 'closed') await sources.preparation.replenish()
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.properties).toEqual(properties)
    expect(card.comments.filter(comment => comment.includes(deskAnswerMarker))).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH'])
    expect(sources.leases.status(card.id)).toBeNull()
  })

  it('resumes an uncertain answer on the same lease after timeout without duplicating the comment or PATCH', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const card = page(1, { owner: 'Will', tag: 'Decision' })
    const { sources, tool, writes } = await setup([card], true, 'lost')
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
