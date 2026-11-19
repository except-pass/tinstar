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
import { decisionRequests } from '../../../shared/workflowRequests'
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

const requestIdFor = (card: { id: string }) => `request-${card.id.slice(-4)}`
function withOpenRequest(card: ReturnType<typeof page>, action = 'Decision') {
  const property = card.properties['Will action']
  if (property?.type === 'multi_select' && !property.multi_select.some(item => item.name === action)) property.multi_select.push({ name: action })
  card.comments.push(`Requested from: Will\nQuestion: Decide on this fixture?\nTin Star request: ${JSON.stringify({ id: requestIdFor(card), action, preserve_action: false })}`)
  return card
}
const answerComments = (card: { comments: string[] }) => card.comments.filter(comment => comment.includes(deskAnswerMarker))

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

async function setup(cards: ReturnType<typeof page>[], autoPublish = true, firstPatchFailure?: 'lost' | 'rejected', loseWebhookAckAt?: number) {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-decision-loop-'))
  fixtures.push(() => rm(root, { recursive: true, force: true }))
  const published: unknown[] = []
  const jobs: Array<{ card_url: string; source_question: string; source_revision: string; publish: { tool: string; job_id: string } }> = []
  const createdTimes = new Map<string, string>()
  const cardReads: string[] = []
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
      if (jobs.length === loseWebhookAckAt) { res.destroy(); return }
      if (autoPublish) published.push(await tool(job.publish.tool, { job_id: job.publish.job_id, packet: contents }))
      res.writeHead(202).end()
    } catch { res.writeHead(500).end() }
  })
  fixtures.push(webhook.close)
  let rejectComment = false
  let beforeBodyRead: (() => Promise<void>) | undefined
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
    if (method === 'GET') cardReads.push(url.pathname)
    if (method !== 'GET') writes.push({ card: card.id, type: method, token: new Headers(init?.headers).get('Authorization') })
    if (url.pathname === '/v1/comments') {
      if (method === 'POST' && rejectComment) {
        rejectComment = false
        return new Response(null, { status: 400 })
      }
      if (method === 'POST') card.comments.push(body.rich_text.map((item: { text: { content: string } }) => item.text.content).join(''))
      return Response.json({ results: card.comments.map((entry, index) => ({ id: `comment-${index}`, created_time: createdTimes.get(entry), created_by: { id: 'fixture-writer' }, rich_text: text(entry) })), has_more: false })
    }
    if (url.pathname.endsWith('/children')) {
      const pause = beforeBodyRead
      beforeBodyRead = undefined
      await pause?.()
      return Response.json({
        results: card.body.map((entry, index) => ({ id: `block-${index}`, created_time: createdTimes.get(entry), type: 'paragraph', paragraph: { rich_text: text(entry) } })),
        has_more: false,
      })
    }
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
  let sendingEnabled = true
  const restartSources = () => new ReconciliationSources({ warnings: [], fleet: [], notion: { token: 'integration-writer', dataSourceId: board } },
    provider, new NotionApi(provider, 0), root, async () => sendingEnabled ? JSON.stringify({ url: webhook.url, key: 'fixture-webhook-key' }) : null)
  const sources = restartSources()
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
  return { sources, jobs, tool, connect, published, writes, web, createdTimes, cardReads, restartSources, rejectNextComment: () => { rejectComment = true }, pauseNextBodyRead: (pause: () => Promise<void>) => { beforeBodyRead = pause }, disableSending: () => { sendingEnabled = false } }
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
    await sources.preparation.replenish()
    const before = await web('snapshot')
    expect(before.data.ready).toHaveLength(1)
    const oldPacket = before.data.ready[0].id
    if (sibling) expect(await tool('update_work', { card_id: card.id, operation_id: 'publish-sibling', kind: 'request_decision',
      request_id: 'fixture-sibling', requested_from: 'Will', question: 'Review the sibling fixture?' })).toMatchObject({ outcome: 'saved' })

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
    const context = await sources.card(card.id)
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
      expect(jobs[1]!.source_question).toBe(kind === 'supersede_decision' ? replacement.question : 'Review the sibling fixture?')
      expect(after.data.ready).toHaveLength(1)
      expect(after.data.ready[0].id).not.toBe(oldPacket)
    }
  })

  it('omits redacted replacement IDs from answer choices while accepting the exact ID', async () => {
    const card = page(1)
    card.properties.Area = select('Engineering')
    const { sources, tool } = await setup([card])
    const requestId = 'fixture-original'
    const replacementId = 'secret_rotation_approval_stage'
    expect(await tool('update_work', { card_id: card.id, operation_id: 'publish-fixture', kind: 'request_decision',
      request_id: requestId, requested_from: 'Will', question: 'Review the original?' })).toMatchObject({ outcome: 'saved' })
    expect(await tool('update_work', { card_id: card.id, operation_id: 'supersede-fixture', kind: 'supersede_decision',
      request_id: requestId, reason: 'Corrected scope',
      replacement: { request_id: replacementId, requested_from: 'Will', question: 'Review the replacement?' },
    })).toMatchObject({ outcome: 'saved' })

    const context = await sources.card(card.id)
    expect(context.answerSources).toEqual({ excluded: ['comment-0', 'comment-1'], replacements: [] })
    expect(JSON.stringify(context)).not.toContain(replacementId)
    expect(await tool('update_work', { card_id: card.id, operation_id: 'answer-replacement', kind: 'answer_decision',
      request_id: replacementId, answer: 'Approved', next: { owner: 'Firstmate', status: 'Queued' },
    })).toMatchObject({ outcome: 'saved' })
  })

  it('pushes batches of ten and claims, reads and answers ten throwaway cards through ChatGPT', async () => {
    const cards = Array.from({ length: 22 }, (_, n) => withOpenRequest(page(n + 1,
      n % 3 === 0 ? { tag: 'Decision' } : n % 3 === 1 ? { owner: 'Will' } : { status: 'Waiting For', waitingId: 'Will', wait: 'Will: Decide' })))
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
      expect(answerComments(card)).toEqual([expect.stringContaining(`Will chose: Approve the fixture\n\n${answer}\n${deskAnswerMarker}`)])
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
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
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
    expect(answerComments(card)).toEqual([expect.stringContaining(`${attribution}: Approve the fixture\n\n${answer}\n${deskAnswerMarker}`)])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ notes: [expect.stringContaining(`${attribution}: Approve the fixture`)] }))
  })

  it('keeps exactly ten jobs outstanding across refill ticks while callbacks are slow', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cards = Array.from({ length: 50 }, (_, n) => withOpenRequest(page(n + 1, { owner: 'Will' })))
    const { sources, jobs, web, cardReads } = await setup(cards, false)
    await sources.preparation.replenish()
    const monitored = new Set<string>()
    for (let tick = 0; tick < 5; tick++) {
      cardReads.length = 0
      now += 5_000
      await sources.preparation.replenish()
      const pages = cardReads.filter(path => path.startsWith('/v1/pages/'))
      expect(pages).toHaveLength(2)
      pages.forEach(path => monitored.add(path))
    }
    expect(monitored.size).toBe(10)
    expect(jobs).toHaveLength(10)
    expect((await web('snapshot')).data.counts).toMatchObject({ ready: 0, preparing: 10 })
  })

  it('tops up nine jobs around a stalled callback and reuses its slot at expiry', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cards = Array.from({ length: 20 }, (_, n) => withOpenRequest(page(n + 1, { owner: 'Will' })))
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

  it.each(['Will', 'Alice'])('skips another open request for %s and sends only the remaining labeled legacy question', async recipient => {
    const card = page(1, { tag: 'Decision' })
    card.properties['Next action'] = rich('Deploy the current build')
    card.properties['Will action'] = { type: 'multi_select', multi_select: [{ name: 'Decision' }, { name: 'Review' }] }
    const newer = `Requested from: ${recipient}\nQuestion: Should we pause?\nTin Star request: {"id":"newer","action":"Review"}`
    const older = 'Requested from: Will\nQuestion: Should we cancel?\nInternal only: unrelated private notes\nTin Star request: {"id":"older","action":"Decision"}'
    card.comments.push(newer, older)
    const { sources, jobs } = await setup([card], false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(0)

    card.comments.push('Tin Star answer: "newer"')
    await sources.preparation.replenish()
    expect(jobs.map(job => job.source_question)).toEqual(['Should we cancel?'])
  })

  it('publishes a scrubbed webhook job through its callback and makes it Ready', async () => {
    const card = page(1, { tag: 'Decision' })
    card.properties['Next action'] = rich('Deploy the current build')
    const { sources, jobs, published, tool, web } = await setup([card])
    expect(await tool('update_work', { card_id: card.id, operation_id: 'ask-about-rollout', kind: 'request_decision',
      request_id: 'rollout', requested_from: 'Will', question: 'Please decide the following:\nShould we cancel the rollout with token=fixture-private-token still active?' }))
      .toMatchObject({ outcome: 'saved' })
    await sources.preparation.replenish()
    expect(jobs).toEqual([{
      card_url: expect.stringContaining(card.id),
      source_question: 'Please decide the following:\nShould we cancel the rollout with token=[credential omitted] still active?',
      source_revision: expect.any(String),
      publish: { tool: 'publish_prepared_packet', job_id: expect.any(String) },
    }])
    expect(decisionRequests(card.comments.map((text, index) => ({ id: String(index), text })))[0]?.question)
      .toBe('Please decide the following:')
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
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
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
    expect(card.comments.filter(comment => !comment.includes('Tin Star request:'))).toEqual(['A new fact changes which option is best.'])
    await tool('release_prepared_decision', { operation_id: 'release-stale', lease_token: held.lease_token })
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)
    card.body.push('Changed body during preparation.')
    expect(await tool('publish_prepared_packet', { job_id: jobs[1]!.publish.job_id, packet: contents }))
      .toMatchObject({ outcome: 'operation-conflict', message: expect.stringContaining('card changed') })
  })

  it.each(['comment', 'body'] as const)('requires a new %s request after a browser answer', async location => {
    const card = withOpenRequest(page(1, { owner: 'Will', tag: 'Decision' })), other = withOpenRequest(page(2, { tag: 'Decision' }))
    const { sources, jobs, tool, web, createdTimes } = await setup([card, other], false)
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
      Status: { status: { name: 'In Progress' } }, 'Waiting For': { rich_text: [] },
      'Waiting For Type': { select: null }, 'Waiting For ID': { rich_text: [] } })
    const kept = card.comments.find(comment => comment.startsWith('Will chose:'))
    expect(kept?.split('\n')[0]).toBe('Will chose: Keep reviewing')
    expect(kept).toContain('\n\nLeave this with Alice.\nThank you.')
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

    card.properties.Status = { type: 'status', status: { name: 'In Progress' } }
    card.body.push('An unrelated edit does not reopen the decision.')
    await sources.snapshot(true)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)

    const request = 'Requested from: Will\nQuestion: Decide on the new request?\nTin Star request: {"id":"second-request","action":"Decision"}'
    if (location === 'body') {
      createdTimes.set(kept!, '2025-01-02T00:00:00Z')
      const older = request.replace('second-request', 'older-request')
      createdTimes.set(older, '2025-01-01T00:00:00Z')
      card.body.push(older)
      await sources.preparation.replenish()
      expect(jobs).toHaveLength(2)
      createdTimes.set(request, '2025-01-03T00:00:00Z')
      card.body.push(request)
    } else {
      card.comments.push(request)
    }
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(3)
    expect(await tool('publish_prepared_packet', { job_id: jobs[2]!.publish.job_id, packet: contents })).toMatchObject({ outcome: 'published' })
    expect((await web('submit', answer)).data).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.comments.filter(comment => comment.startsWith('Will chose:'))).toHaveLength(1)
    const reopened = await web('claim', { operation_id: 'reopened', review_session_token, card_id: card.id })
    expect(reopened.data).toMatchObject({ outcome: 'claimed' })
    expect((await web('submit', { ...answer, operation_id: 'second-answer', lease_token: reopened.data.lease_token })).data)
      .toMatchObject({ outcome: 'recorded-empty' })
    expect(card.comments.filter(comment => comment.startsWith('Will chose:'))).toHaveLength(2)
  })

  it('keeps Alice assigned when Will answers a tag-only card waiting on deployment', async () => {
    const card = withOpenRequest(page(1, { owner: 'Alice', tag: 'Decision', status: 'Waiting For', waitingId: 'deploy', wait: 'Deployment pending' }))
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
    expect(answerComments(card)).toHaveLength(1)
  })

  it.each(['retry', 'released retry', 'released refill'] as const)('completes a saved answer through %s and retains independent waits', async recovery => {
    const will = waitLine({ type: 'Actor', id: 'Will', dependency: 'Approve the release',
      unblocks_when: 'Will decides', follow_up_by: 'Firstmate' })
    const deploy = waitLine({ type: 'Event', id: 'deploy', dependency: 'Production deployment',
      unblocks_when: 'Deployment completes', follow_up_by: 'Firstmate' })
    const willPrimary = recovery === 'retry'
    const card = withOpenRequest(page(1, { owner: 'Firstmate', status: 'Waiting For', waitingId: willPrimary ? 'Will' : 'deploy',
      wait: (willPrimary ? [will, deploy] : [deploy, will]).join('\n') }))
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
    const answerIndex = card.comments.findIndex(comment => comment.startsWith('Firstmate chose on Will\'s behalf:'))
    const expectedNote = card.comments[answerIndex]!
    expect(expectedNote).toMatch(/^Firstmate chose on Will's behalf: /)
    const legacyNote = expectedNote.replace(/^Firstmate chose on Will's behalf:/, 'Will chose:')
    card.comments[answerIndex] = legacyNote
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
    expect(card.comments).toEqual([expect.stringContaining('Tin Star request:'), legacyNote])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ notes: [expectedNote] }))
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH', 'PATCH'])
    expect(sources.leases.status(card.id)).toBeNull()
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
  })

  it.each(['retry', 'refill'] as const)('recovers a tag-only Firstmate card through %s', async recovery => {
    const card = withOpenRequest(page(1, { owner: 'Firstmate', tag: 'Decision' }))
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
    expect(answerComments(card)).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH', 'PATCH'])
  })

  it.each(['retry', 'refill'] as const)('preserves a later assignment during %s recovery', async recovery => {
    const card = withOpenRequest(page(1, { owner: 'Will', tag: 'Decision', status: 'Waiting For', waitingId: 'Will', wait: 'Will: Decide' }))
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
    expect(answerComments(card)).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH'])
  })

  it('preserves a replacement Merge tag when recovering a saved Decision answer', async () => {
    const card = withOpenRequest(page(1, { owner: 'Firstmate', tag: 'Decision' }))
    const { sources, tool, writes } = await setup([card], true, 'rejected')
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'claim-decision-tag', card_id: card.id })
    const answer = { operation_id: 'answer-decision-tag', lease_token: held.lease_token, option_id: '1', answer: 'Proceed.' }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'save-unconfirmed' })
    card.properties['Will action'] = tags('Merge')
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(card.properties['Will action']).toEqual(tags('Merge'))
    expect(answerComments(card)).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH'])
  })

  it.each(['closed', 'new discussion'] as const)('preserves a saved answer and leaves properties alone after %s', async change => {
    const card = withOpenRequest(page(1, { owner: 'Will', tag: 'Decision' }))
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
    const card = withOpenRequest(page(1, { owner: 'Will', tag: 'Decision' }))
    const { sources, tool, writes } = await setup([card], true, 'lost')
    await sources.preparation.replenish()
    const held = await tool('claim_card', { operation_id: 'before-interrupted-write', card_id: card.id })
    const answer = { operation_id: 'interrupted-write', lease_token: held.lease_token, option_id: '1', answer: 'Keep my answer exactly.' }
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'save-unconfirmed' })
    expect(answerComments(card)).toHaveLength(1)
    expect(sources.leases.pendingWrites()).toHaveLength(1)
    now += 61 * 60_000
    await sources.recoverSourceWrites()
    expect(await tool('claim_card', { operation_id: 'competing-chat', card_id: card.id })).not.toHaveProperty('lease')
    expect(await tool('submit_prepared_decision', answer)).toMatchObject({ outcome: 'recorded-empty' })
    expect(answerComments(card)).toHaveLength(1)
    expect(writes.map(write => write.type)).toEqual(['POST', 'PATCH'])
    expect(sources.leases.pendingWrites()).toHaveLength(0)
    expect(sources.leases.status(card.id)).toBeNull()
  })

  it('does not send a Will-owned card that has no open decision request', async () => {
    const card = page(1, { owner: 'Will', tag: 'Decision' })
    const { sources, jobs } = await setup([card])
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(0)
    expect(await sources.preparation.status()).toMatchObject({ jobs: [] })
  })

  it.each(['Waiting for Prod Release', 'Delegated to person', 'Done', 'Archived'])('does not send a %s card that has an open decision request', async status => {
    const blocked = withOpenRequest(page(1, { owner: 'Will', tag: 'Decision', status }))
    const open = withOpenRequest(page(2, { owner: 'Will', tag: 'Decision' }))
    const { sources, jobs } = await setup([blocked, open])
    await sources.preparation.replenish()
    expect(jobs.map(job => job.card_url)).toEqual([expect.stringContaining(open.id)])
    expect(jobs.some(job => job.card_url.includes(blocked.id))).toBe(false)
  })

  it('requires a decision request record even for explicit review and merge asks', async () => {
    const review = page(1, { owner: 'Will', status: 'Ready for Review' })
    const merge = page(2, { tag: 'Merge' })
    const decision = withOpenRequest(page(3, { tag: 'Decision' }))
    const sha = 'a'.repeat(40)
    const pull = 'https://github.com/except-pass/tinstar/pull/100'
    const submission = { submission_key: 'review-fixture', deliverable_id: 'fixture', summary: 'Review the fixture',
      pulls: [{ url: pull, head: sha }], deployment_id: 'deployment', deployed_sha: sha,
      live_url: 'https://example.test', instructions: 'Review the fixture',
      proof: { kind: 'non-ui', tested_sha: sha, passed: true, receipt: 'https://example.test/receipt', alternative: 'Unit tests' },
      remaining_scope: [] }
    review.comments.push(`Date: 2025-01-01\nBy: Firstmate\nTin Star review submission: ${JSON.stringify(submission)}`)
    merge.properties.Link = rich(pull)
    merge.properties['Next action'] = rich('Merge this PR')
    const { sources, jobs } = await setup([review, merge, decision], false)
    const readPulls = vi.fn(async () => null)
    const readPullReadiness = vi.fn(async () => new Map([[pull, {
      status: 'fresh' as const, state: 'open' as const, observedAt: null, expiresAt: null,
      head: null, draft: false, checks: 'unknown' as const, mergeability: 'unknown' as const,
    }]]))
    sources.readPulls = readPulls
    sources.readPullReadiness = readPullReadiness
    await sources.preparation.replenish()
    expect(jobs.map(job => job.card_url)).toEqual([expect.stringContaining(decision.id)])
    expect(readPulls).not.toHaveBeenCalled()
    expect(readPullReadiness).not.toHaveBeenCalled()
  })

  it('rejects a callback when a Desk answer closes its request without changing the revision', async () => {
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources, jobs, tool } = await setup([card], false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
    card.comments.push(`Will chose: Approve\n${deskAnswerMarker}fixture-answer`)
    expect(await tool('publish_prepared_packet', { job_id: jobs[0]!.publish.job_id, packet: contents }))
      .toMatchObject({ outcome: 'operation-conflict', message: expect.stringContaining('no longer an open owner decision') })
  })

  it.each(['[TEST-driven development] Approve rollout?', ' [TEST] rollout', '[test] rollout'])(
    'dispatches and publishes a request titled %s', async title => {
      const card = withOpenRequest(page(1, { tag: 'Decision' }))
      card.properties.Name = rich(title)
      const { sources, jobs, published } = await setup([card])
      await sources.preparation.replenish()
      expect(jobs).toHaveLength(1)
      expect(published).toEqual([expect.objectContaining({ outcome: 'published' })])
    },
  )

  it.each(['Tin Star prepared packet:', 'Tin Star operation: ["waiting-on-main",'])(
    'rejects publication with two open requests even when a request quotes %s', async marker => {
      const card = withOpenRequest(page(1, { tag: 'Decision' }))
      const { sources, jobs, tool } = await setup([card], false)
      await sources.preparation.replenish()
      expect(jobs).toHaveLength(1)
      expect(await tool('update_work', { card_id: card.id, operation_id: 'second-request', kind: 'request_decision',
        request_id: 'second-request', requested_from: 'Will', question: `Should we rename the ${marker} marker?` }))
        .toMatchObject({ outcome: 'saved' })
      expect(await tool('publish_prepared_packet', { job_id: jobs[0]!.publish.job_id, packet: contents }))
        .toMatchObject({ outcome: 'operation-conflict', message: expect.stringContaining('no longer an open owner decision') })
    },
  )

  it('ignores marker text in ordinary comments when validating a callback', async () => {
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources, jobs, tool } = await setup([card], false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
    card.comments.push('The Tin Star prepared packet: marker was mentioned.',
      'The Tin Star operation: ["waiting-on-main", marker was also mentioned.')
    expect(await tool('publish_prepared_packet', { job_id: jobs[0]!.publish.job_id, packet: contents }))
      .toMatchObject({ outcome: 'published' })
  })

  it('counts a lost acknowledgement toward capacity and retires it when the card becomes ineligible', async () => {
    const cards = Array.from({ length: 11 }, (_, n) => withOpenRequest(page(n + 1, { tag: 'Decision' })))
    const { sources, jobs, tool, web } = await setup(cards, false, undefined, 1)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(10)
    const unacknowledged = jobs[0]!
    const card = cards.find(candidate => unacknowledged.card_url.includes(candidate.id))!
    expect((await web('snapshot')).data).toMatchObject({
      counts: { preparing: 10 },
      pending: expect.arrayContaining([expect.objectContaining({ card_id: card.id, state: 'Preparing' })]),
    })
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(10)

    const originalStatus = card.properties.Status!
    card.properties.Status = { type: 'status', status: { name: 'Waiting for Prod Release' } }
    for (let tick = 0; tick < 5; tick++) {
      await sources.preparation.replenish()
      if ((await sources.preparation.status()).jobs.some(job => job.id === unacknowledged.publish.job_id && job.state === 'stopped')) break
    }
    expect((await sources.preparation.status()).jobs).toContainEqual(expect.objectContaining({
      id: unacknowledged.publish.job_id, state: 'stopped',
    }))
    card.properties.Status = originalStatus
    expect(await tool('publish_prepared_packet', { job_id: unacknowledged.publish.job_id, packet: contents }))
      .toMatchObject({ outcome: 'operation-conflict', message: 'The preparation job stopped' })
  })

  it('retires outstanding jobs while sending is disabled', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources, jobs, tool, disableSending } = await setup([card], false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
    disableSending()
    now += 30_000
    const originalStatus = card.properties.Status!
    card.properties.Status = { type: 'status', status: { name: 'Waiting for Prod Release' } }
    await sources.preparation.replenish()
    expect(await sources.preparation.status()).toMatchObject({ configured: false, preparing: 0, jobs: [{ state: 'stopped' }] })
    expect(jobs).toHaveLength(1)

    card.properties.Status = originalStatus
    expect(await tool('publish_prepared_packet', { job_id: jobs[0]!.publish.job_id, packet: contents }))
      .toMatchObject({ outcome: 'operation-conflict', message: 'The preparation job stopped' })
  })

  it.each(['refill', 'callback'])('retires a moved-card job without reading its history during %s', async path => {
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources, jobs, cardReads } = await setup([card], false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
    const publication = { job_id: jobs[0]!.publish.job_id, packet: contents }

    card.parent.data_source_id = id(999)
    cardReads.length = 0
    if (path === 'refill') await sources.preparation.replenish()
    else await expect(sources.preparation.publish(publication)).rejects.toThrow('Notion card identity or source changed')
    expect(cardReads).toEqual([`/v1/pages/${card.id}`])
    expect((await sources.preparation.status()).jobs[0]?.state).toBe('stopped')

    card.parent.data_source_id = board
    await expect(sources.preparation.publish(publication)).rejects.toThrow('The preparation job stopped')
    expect(jobs).toHaveLength(1)
  })

  it('rereads current comments for publication while monitoring an older history', async () => {
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources, jobs, pauseNextBodyRead } = await setup([card], false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
    const bodyStarted = Promise.withResolvers<void>()
    const releaseBody = Promise.withResolvers<void>()
    pauseNextBodyRead(() => {
      bodyStarted.resolve()
      return releaseBody.promise
    })
    const monitoring = sources.preparation.replenish()
    await bodyStarted.promise
    card.comments.push(`Will chose: Approve\n${deskAnswerMarker}fixture-answer`)
    const publication = sources.preparation.publish({ job_id: jobs[0]!.publish.job_id, packet: contents })
    const rejection = expect(publication).rejects.toThrow('This card is no longer an open owner decision')
    try {
      await vi.waitFor(async () => expect((await sources.preparation.status()).jobs[0]?.state).toBe('stopped'))
      await rejection
    } finally {
      releaseBody.resolve()
      await Promise.allSettled([monitoring, rejection])
    }
  })

  it.each(['publication', 'workflow edit', 'partial review'])('keeps a superseded monitor from restoring the Desk revision after %s', async action => {
    const card = withOpenRequest(page(1, { tag: 'Decision', status: action === 'partial review' ? 'In review' : 'In Progress' }))
    card.properties.Area = select('Engineering')
    const { sources, jobs, tool, web, pauseNextBodyRead, rejectNextComment } = await setup([card], false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
    const bodyStarted = Promise.withResolvers<void>()
    const releaseBody = Promise.withResolvers<void>()
    pauseNextBodyRead(() => {
      bodyStarted.resolve()
      return releaseBody.promise
    })
    const monitoring = sources.preparation.replenish()
    await bodyStarted.promise
    try {
      if (action === 'publication') {
        card.comments.push('New evidence changes the decision.')
        await expect(sources.preparation.publish({ job_id: jobs[0]!.publish.job_id, packet: contents }))
          .rejects.toThrow('The card changed while preparing it')
      } else if (action === 'partial review') {
        rejectNextComment()
        expect(await tool('update_work', { card_id: card.id, operation_id: 'review-during-monitor', kind: 'accept_review',
          submission_key: `legacy:${card.id}:${card.last_edited_time}`, feedback: 'Accepted', remaining_scope: [], scope_complete: true }))
          .toMatchObject({ outcome: 'partially-saved', saved_fields: expect.arrayContaining(['Status']) })
        expect(card.properties.Status).toMatchObject({ status: { name: 'Done' } })
      } else {
        expect(await tool('update_work', { card_id: card.id, operation_id: 'complete-during-monitor', kind: 'complete',
          disposition: 'Decision no longer needed', evidence: 'Fixture closed' }))
          .toMatchObject({ outcome: 'saved' })
      }
    } finally {
      releaseBody.resolve()
      await monitoring
    }

    expect((await web('snapshot')).data.pending).toEqual(action === 'publication'
      ? [expect.objectContaining({ card_id: card.id, state: 'Queued' })]
      : [])
  })

  it('publishes while a retirement-only history read is pending', async () => {
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources } = await setup([card], false)
    const work = await sources.currentCard(card.id)
    const open = decisionCardSource(work, [{ id: 'ask', type: 'comment', text: card.comments[0]! }])
    const monitorStarted = Promise.withResolvers<void>()
    const releaseMonitor = Promise.withResolvers<void>()
    let backgroundReads = 0
    const push = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const prep = new DecisionPreparation(sources.decisionPackets, {
      refreshQueue: async () => [work],
      read: async (_id, background) => {
        if (background && ++backgroundReads > 1) {
          monitorStarted.resolve()
          await releaseMonitor.promise
          return { ...open, prepEligible: false }
        }
        return open
      },
      exclusive: (id, perform) => sources.workflow.exclusive(id, perform),
    }, async () => JSON.stringify({ url: 'https://example.test/webhook', key: 'fixture' }), push)
    await prep.replenish()
    const { publish: { job_id } } = JSON.parse(String(push.mock.calls[0]?.[1]?.body))
    const monitoring = prep.replenish()
    await monitorStarted.promise
    const publication = prep.publish({ job_id, packet: contents })
    try {
      await vi.waitFor(async () => expect((await prep.status()).jobs[0]?.state).toBe('published'))
      await expect(publication).resolves.toMatchObject({ outcome: 'published' })
    } finally {
      releaseMonitor.resolve()
      await Promise.allSettled([monitoring, publication])
    }
    expect((await prep.status()).jobs[0]?.state).toBe('published')
  })

  it.each(['comment', 'paragraph'])('preserves the legacy revision when identical %s text is reposted', async type => {
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources } = await setup([card], false)
    const work = await sources.currentCard(card.id)
    const request = { id: 'original', type, text: card.comments[0]! }
    const original = decisionCardSource(work, [request])
    const reposted = decisionCardSource(work, [{ ...request, id: 'reposted' }])
    expect(original.prepEligible).toBe(true)
    expect(reposted.prepEligible).toBe(true)
    expect(reposted.revision).toBe(original.revision)
  })

  it('does not reread stopped job history after restart with sending disabled', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources, jobs, cardReads, disableSending, restartSources } = await setup([card], false)
    await sources.preparation.replenish()
    now += 15 * 60_000
    await sources.preparation.replenish()
    now += 15 * 60_000
    await sources.preparation.replenish()
    disableSending()
    const restarted = restartSources()
    const readsBeforeRestart = cardReads.length
    await restarted.preparation.replenish()
    expect((await restarted.preparedReviews.snapshot()).pending).toEqual([
      expect.objectContaining({ card_id: card.id, state: 'Queued' }),
    ])
    expect((await restarted.preparation.status()).jobs[0]?.state).toBe('stopped')
    expect(cardReads).toHaveLength(readsBeforeRestart)
    expect(jobs).toHaveLength(2)
  })

  it.each(['live', 'expired', 'stopped'] as const)('shows %s jobs older than the runner history limit', async state => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources, jobs, tool, web, cardReads, disableSending } = await setup([card], false)
    await sources.preparation.replenish()
    if (state !== 'live') {
      now += 15 * 60_000
      if (state === 'expired') disableSending()
      await sources.preparation.replenish()
      if (state === 'stopped') {
        now += 15 * 60_000
        await sources.preparation.replenish()
      }
    }
    now += 1_000
    await sources.leases.writeStorage(db => {
      const insert = db.prepare("INSERT INTO decision_card_prep (id,scope,card,revision,state,at) VALUES (?,?,?,?,'published',?)")
      for (let n = 0; n < 100; n++) insert.run(`history-${n}`, sources.decisionPackets.scope, id(n + 2), 'old', now)
    })

    const readsBeforeSnapshot = cardReads.length
    const snapshot = (await web('snapshot')).data
    expect(cardReads).toHaveLength(readsBeforeSnapshot)
    expect(jobs).toHaveLength(state === 'stopped' ? 2 : 1)
    expect(snapshot.runner.jobs).toHaveLength(100)
    expect(snapshot.runner.jobs.some((job: { id: string }) => job.id === jobs[0]!.publish.job_id)).toBe(false)
    expect(snapshot.counts.preparing).toBe(state === 'live' ? 1 : 0)
    const label = state === 'live' ? 'Preparing' : state === 'expired' ? 'Retrying' : 'Preparation stopped after two sends without a packet'
    expect(snapshot.pending).toEqual([expect.objectContaining({ card_id: card.id, state: label })])

    expect(await tool('update_work', { card_id: card.id, operation_id: 'revise-request', kind: 'request_decision',
      request_id: 'revised', requested_from: 'Will', question: 'Decide on the revised request?' }))
      .toMatchObject({ outcome: 'saved' })
    const readsAfterEdit = cardReads.length
    expect((await web('snapshot')).data.pending).toEqual([expect.objectContaining({ card_id: card.id, state: 'Queued' })])
    expect(cardReads).toHaveLength(readsAfterEdit)
  })

  it.each([true, false])('honors the final callback deadline after a lost acknowledgement, timely=%s', async timely => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const card = withOpenRequest(page(1, { tag: 'Decision' }))
    const { sources, jobs, tool, web } = await setup([card], false, undefined, 2)
    await sources.preparation.replenish()
    now += 15 * 60_000
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)
    expect((await sources.preparation.status()).jobs).toContainEqual(expect.objectContaining({
      id: jobs[0]!.publish.job_id, state: 'expired',
    }))
    now += (timely ? 14 : 15) * 60_000
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)
    const originalStatus = card.properties.Status!
    if (!timely) card.properties.Status = { type: 'status', status: { name: 'Waiting for Prod Release' } }
    expect(await tool('publish_prepared_packet', { job_id: jobs[1]!.publish.job_id, packet: contents }))
      .toMatchObject(timely ? { outcome: 'published' } : { outcome: 'operation-conflict', message: expect.stringContaining('expired') })
    if (!timely) {
      card.properties.Status = originalStatus
      expect((await web('snapshot')).data.pending).toEqual([
        expect.objectContaining({ card_id: card.id, state: 'Preparation stopped after two sends without a packet' }),
      ])
    }
  })

  it('skips property-excluded cards before spending dispatch read slots', async () => {
    const fixtures = Array.from({ length: 10 }, (_, i) => withOpenRequest(page(i + 1, { owner: 'Will' })))
    for (const card of fixtures) card.properties.Name = rich('[TEST] excluded fixture')
    const eligible = withOpenRequest(page(11, { owner: 'Will' }))
    const { sources, jobs, cardReads } = await setup([...fixtures, eligible], false)

    await sources.preparation.replenish()
    expect(jobs.map(job => job.card_url)).toEqual([expect.stringContaining(eligible.id)])
    expect(cardReads.filter(path => path.startsWith('/v1/pages/'))).toEqual([`/v1/pages/${eligible.id}`])
  })

  it('does not send a test card or a synthetic card', async () => {
    const named = withOpenRequest(page(1, { owner: 'Will', tag: 'Decision' }))
    named.properties.Name = rich('[TEST] fixture card')
    const { sources, jobs } = await setup([named])
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(0)

    const live = await sources.currentCard(named.id)
    const synthetic = { ...live, id: id(2), source: { provider: 'jira' as const, instanceId: 'fixture', collectionId: '10638', itemId: '1', displayKey: 'TSSPIKE-1', synthetic: true as const } }
    synthetic.properties.Name = { ...synthetic.properties.Name!, value: 'Open owner decision' }
    const push = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const prep = new DecisionPreparation(sources.decisionPackets, {
      refreshQueue: async () => [synthetic],
      read: async () => decisionCardSource(synthetic, [{ id: 'ask', type: 'comment', text: named.comments[0]! }]),
      exclusive: (card, perform) => sources.workflow.exclusive(card, perform),
    }, async () => JSON.stringify({ url: 'https://example.test/webhook', key: 'fixture' }), push)
    await prep.replenish()
    expect(push).not.toHaveBeenCalled()
  })

  it('sends a card with an open decision request, stops after two sends, and sends again when the revision changes', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const card = withOpenRequest(page(1, { owner: 'Will', tag: 'Decision' }))
    const { sources, jobs } = await setup([card], false)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
    now += 15 * 60_000
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)
    now += 15 * 60_000
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(2)
    expect((await sources.preparation.status()).jobs).toContainEqual(expect.objectContaining({ id: jobs[1]!.publish.job_id, state: 'stopped' }))
    card.body.push('The request evidence changed.')
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(3)
  })

  it('reads a candidate after an in-progress withdrawal releases its card lock', async () => {
    const withdrawing = withOpenRequest(page(1, { tag: 'Decision' }))
    const sibling = withOpenRequest(page(2, { tag: 'Decision' }))
    const { sources } = await setup([withdrawing, sibling], false)
    const cards = await Promise.all([withdrawing, sibling].map(card => sources.currentCard(card.id)))
    const release = Promise.withResolvers<void>()
    const otherRead = Promise.withResolvers<void>()
    let withdrawn = false
    const withdrawal = sources.workflow.exclusive(withdrawing.id, async () => {
      await release.promise
      withdrawn = true
    })
    const push = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const prep = new DecisionPreparation(sources.decisionPackets, {
      refreshQueue: async () => cards,
      read: async id => {
        const first = id === withdrawing.id
        if (!first) {
          otherRead.resolve()
          await withdrawal
        }
        const fixture = first ? withdrawing : sibling
        const notes = first && withdrawn ? [] : [{ id: 'request', type: 'comment', text: fixture.comments[0]! }]
        return decisionCardSource(cards[first ? 0 : 1]!, notes)
      },
      exclusive: (id, perform) => sources.workflow.exclusive(id, perform),
    }, async () => JSON.stringify({ url: 'https://example.test/webhook', key: 'fixture' }), push)
    const refilling = prep.replenish()
    await otherRead.promise
    release.resolve()
    await refilling
    expect(push).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(push.mock.calls[0]?.[1]?.body)).card_url).toContain(sibling.id)
  })

  it('never sends an answered request and drops the job that was already queued', async () => {
    const waiting = withOpenRequest(page(1, { owner: 'Will', tag: 'Decision' }))
    const answered = withOpenRequest(page(2, { owner: 'Will', tag: 'Decision' }))
    answered.comments.push(`Tin Star answer: ${JSON.stringify(requestIdFor(answered))}`)
    const { sources, jobs } = await setup([waiting, answered], false)
    await sources.preparation.replenish()
    expect(jobs.map(job => job.card_url)).toEqual([expect.stringContaining(waiting.id)])
    waiting.comments.push(`Tin Star answer: ${JSON.stringify(requestIdFor(waiting))}`)
    await sources.preparation.replenish()
    expect(jobs).toHaveLength(1)
    expect((await sources.preparation.status()).jobs).toEqual([expect.objectContaining({ card: waiting.id, state: 'stopped' })])
  })
})
