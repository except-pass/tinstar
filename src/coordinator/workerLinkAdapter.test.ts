import { describe, expect, it, vi } from 'vitest'
import { fixtureId, fixtureSources } from '../../test-fixtures/reconciliation/scenes'
import { parseDispatchProvenance } from '../server/reconciliation/dispatchProvenance'
import { FIRST_MATE_TASKS, readWorkerLinks, workerLinkRecord, type WorkerLink } from '../server/reconciliation/workerLinks'
import { reconcileScene } from '../server/reconciliation/scene'
import { notionLinkTransport, runWorkerLinkAdapter, type AdapterAudit } from './workerLinkAdapter'

const now = Date.parse('2026-11-05T12:00:00Z'), a = fixtureId(1), b = fixtureId(2), board = fixtureId(999)
const secret = 'fake-write-token-DO-NOT-LOG'
const link = (task_id = 'linked-worker', first_observed_spawn_gen = 'attempt-1'): WorkerLink => ({ fm_home: '/fixture/hulk', task_id, first_observed_spawn_gen })
function source(twoCards = false) {
  const input = fixtureSources({ now })
  input.fleet = [input.fleet[1]!]
  const home = input.fleet[0]!
  home.observation.data!.tasks = [home.observation.data!.tasks[0]!]
  home.observation.data!.backlog = []
  const task = home.observation.data!.tasks[0]!
  task.dispatchProvenance = parseDispatchProvenance([`card: ${a}`])
  input.intentions.data!.cards = input.intentions.data!.cards.filter(c => c.id === a)
  input.intentions.data!.cards[0]!.properties[FIRST_MATE_TASKS]!.value = workerLinkRecord([]).json
  if (twoCards) {
    const other = structuredClone(input.intentions.data!.cards[0]!)
    other.id = b
    input.intentions.data!.cards.push(other)
    home.observation.data!.tasks.push({ ...structuredClone(task), identity: { ...task.identity, task_id: 'second' },
      cardReferences: [{ pageId: b, basis: 'explicit', source: 'task.notion_page_id' }], dispatchProvenance: parseDispatchProvenance([`card: ${b}`]) })
  }
  return input
}
function fakeNotion(initial: WorkerLink[] = []) {
  const properties = new Map<string, unknown[]>([[a, workerLinkRecord(initial).properties[FIRST_MATE_TASKS].rich_text], [b, []]])
  const patches: Array<{ id: string; body: { properties: Record<string, unknown> }; time: number }> = []
  const requests: Array<{ url: string; method: string }> = []
  let clock = now, failReadback = false, rateLimits = 0, failPatch = false
  const delays: number[] = []
  const timing = { now: () => clock, sleep: async (ms: number) => { delays.push(ms); clock += ms } }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname, id = path.split('/')[3]!
    const method = init?.method ?? 'GET'
    requests.push({ url: String(url), method })
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`)
    if (method === 'PATCH') {
      if (failPatch) throw new Error(secret)
      const body = JSON.parse(init!.body as string)
      patches.push({ id, body, time: clock })
      if (rateLimits-- > 0) return new Response(secret, { status: 429, headers: { 'Retry-After': '2' } })
      properties.set(id, body.properties[FIRST_MATE_TASKS].rich_text)
      return Response.json({ object: 'page' })
    }
    if (path.includes('/properties/')) {
      if (failReadback && patches.length) return Response.json({ object: 'list', results: [], has_more: false })
      return Response.json({ object: 'list', results: (properties.get(id) ?? []).map(rich_text => ({ object: 'property_item', type: 'rich_text', rich_text })), has_more: false })
    }
    return Response.json({ object: 'page', id, parent: { type: 'data_source_id', data_source_id: board }, archived: false, in_trash: false,
      properties: { Status: { type: 'status', status: { name: 'In Progress' } }, [FIRST_MATE_TASKS]: { id: 'links', type: 'rich_text', rich_text: [] } } })
  })
  return { properties, patches, requests, timing, delays, fetcher, setFailReadback: () => { failReadback = true },
    setRateLimits: (n: number) => { rateLimits = n }, setFailPatch: () => { failPatch = true } }
}
async function run(input = source(), fake = fakeNotion(), options = {}) {
  const audit: AdapterAudit[] = []
  const result = await runWorkerLinkAdapter(input, { apply: true, maxCards: 5, now: fake.timing.now,
    transport: notionLinkTransport(secret, board, fake.fetcher, fake.timing), audit: async entry => { audit.push(entry) }, ...options })
  return { result, audit, fake }
}

describe('authorized coordinator adapter with fake Notion', () => {
  it('defaults to report-only and makes no transport calls', async () => {
    const fake = fakeNotion()
    const { result, audit } = await run(source(), fake, { apply: false })
    expect(result.mode).toBe('report-only')
    expect(audit).toContainEqual(expect.objectContaining({ cardId: a, result: 'planned', identities: [link()] }))
    expect(fake.fetcher).not.toHaveBeenCalled()
  })
  it.each([undefined, 0, 6, 1.5, NaN])('requires an explicit bounded max-cards (%s)', async maxCards => {
    await expect(run(source(), fakeNotion(), { maxCards })).rejects.toThrow('--max-cards')
  })
  it('round-trips two workers on one card, preserves a concurrent sibling, and refresh confirms edges', async () => {
    const input = source(), task = input.fleet[0]!.observation.data!.tasks[0]!
    input.fleet[0]!.observation.data!.tasks.push({ ...structuredClone(task), identity: { ...task.identity, task_id: 'helper' } })
    const sibling = link('preexisting', 'original-generation'), fake = fakeNotion([sibling])
    const { result, audit } = await run(input, fake)
    expect(result.stopped).toBe(false)
    expect(fake.patches).toHaveLength(1)
    expect(Object.keys(fake.patches[0]!.body)).toEqual(['properties'])
    expect(Object.keys(fake.patches[0]!.body.properties)).toEqual([FIRST_MATE_TASKS])
    const readback = readWorkerLinks({ type: 'rich_text', rich_text: fake.properties.get(a) })
    expect(readback).toEqual({ status: 'valid', tasks: [sibling, link('helper'), link()] })
    expect(audit.map(e => e.result)).toEqual(['write-planned', 'verified'])
    expect(audit[1]!.beforeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(audit[1]!.afterHash).not.toBe(audit[1]!.beforeHash)
    input.intentions.data!.cards[0]!.properties[FIRST_MATE_TASKS]!.workerLinks = readback
    const scene = reconcileScene(input, now)
    expect(scene.claims.filter(c => c.verification === 'confirmed' && c.state === 'current').map(c => c.identity.task_id).sort()).toEqual(['helper', 'linked-worker'])
    await run(input, fake)
    expect(fake.patches).toHaveLength(1)
  })
  it('rereads before merging and no-ops if a prior invocation already wrote the entry', async () => {
    const fake = fakeNotion([link()])
    const { audit } = await run(source(), fake)
    expect(fake.patches).toHaveLength(0)
    expect(audit.map(e => e.result)).toEqual(['no-op'])
    const repeated = await run(source(), fake)
    expect(repeated.audit.map(e => e.result)).toEqual(['no-op'])
    expect(fake.patches).toHaveLength(0)
  })
  it('idempotently reruns after writing with an unchanged source snapshot', async () => {
    const input = source(), fake = fakeNotion()
    await run(input, fake)
    const { audit } = await run(input, fake)
    expect(audit.map(e => e.result)).toEqual(['no-op'])
    expect(fake.patches).toHaveLength(1)
  })
  it('initializes a genuinely blank full property only during explicit apply', async () => {
    const fake = fakeNotion()
    fake.properties.set(a, [])
    const { result } = await run(source(), fake)
    expect(result.stopped).toBe(false)
    expect(fake.patches).toHaveLength(1)
  })
  it.each(['malformed', 'unknown-schema', 'unreadable-item', 'oversize-item', 'changed-generation', 'duplicate-entry'])(
    'never overwrites %s returned by the full prewrite read', async condition => {
      const fake = fakeNotion()
      let chunks: unknown[] = []
      if (condition === 'malformed') chunks = [{ text: { content: '{' } }]
      if (condition === 'unknown-schema') chunks = [{ text: { content: '{"schema":"future","tasks":[]}' } }]
      if (condition === 'unreadable-item') chunks = [{}]
      if (condition === 'oversize-item') chunks = [{ text: { content: 'x'.repeat(2001) } }]
      if (condition === 'changed-generation') chunks = workerLinkRecord([link('linked-worker', 'old')]).properties[FIRST_MATE_TASKS].rich_text
      if (condition === 'duplicate-entry') chunks = [{ text: { content: JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks: [link(), link()] }) } }]
      fake.properties.set(a, chunks)
      const { result, audit } = await run(source(), fake)
      expect(result.stopped).toBe(true)
      expect(fake.patches).toHaveLength(0)
      expect(audit.at(-1)).toMatchObject({ result: 'stop-prewrite-conflict', investigationKey: JSON.stringify(['card', a]) })
    })
  it('stops the whole batch on readback mismatch, without blindly replaying', async () => {
    const fake = fakeNotion()
    fake.setFailReadback()
    const { result, audit } = await run(source(true), fake)
    expect(result.stopped).toBe(true)
    expect(fake.patches).toHaveLength(1)
    expect(fake.requests.some(r => r.url.includes(b))).toBe(false)
    expect(audit.at(-1)!.result).toBe('stop-uncertain-write')
  })
  it('does not leak transport errors, tokens or raw prose into output/audit', async () => {
    const fake = fakeNotion()
    fake.setFailPatch()
    const { result, audit } = await run(source(true), fake)
    expect(result.stopped).toBe(true)
    expect(JSON.stringify({ result, audit })).not.toContain(secret)
    expect(JSON.stringify(audit)).not.toContain('Fixture source state')
    expect(fake.fetcher).toHaveBeenCalled()
  })
  it('honors Retry-After and spaces PATCH attempts by at least one second', async () => {
    const fake = fakeNotion()
    fake.setRateLimits(1)
    const { result } = await run(source(true), fake)
    expect(result.stopped).toBe(false)
    expect(fake.patches).toHaveLength(3)
    expect(fake.patches[1]!.time - fake.patches[0]!.time).toBeGreaterThanOrEqual(2000)
    expect(fake.patches[2]!.time - fake.patches[1]!.time).toBeGreaterThanOrEqual(1000)
  })
  it.each(['home', 'notion'] as const)('stops retries when %s coverage expires during Retry-After', async coverage => {
    const input = source(true), fake = fakeNotion()
    const observation = coverage === 'home' ? input.fleet[0]!.observation : input.intentions
    observation.expiresAt = new Date(now + 1000).toISOString()
    fake.setRateLimits(1)
    const { result } = await run(input, fake)
    expect(result.stopped).toBe(true)
    expect(fake.patches.map(p => p.id)).toEqual([a])
  })
  it.each(['home', 'notion'] as const)('stops a paced PATCH when %s coverage expires', async coverage => {
    const input = source(true), fake = fakeNotion()
    const observation = coverage === 'home' ? input.fleet[0]!.observation : input.intentions
    observation.expiresAt = new Date(now + 500).toISOString()
    const { result, audit } = await run(input, fake)
    expect(result.stopped).toBe(true)
    expect(fake.patches.map(p => p.id)).toEqual([a])
    expect(audit.at(-1)?.result).toBe('stop-prewrite-conflict')
  })
  it('reads every rich-text page and keeps encoded property ids intact', async () => {
    const fake = fakeNotion([link('sibling', 'x'.repeat(2200))])
    const raw = fake.fetcher.getMockImplementation()!
    const chunks = fake.properties.get(a)!
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/properties/')) {
        expect(new URL(String(url)).pathname).toContain('/properties/f%5C%5C%3Ap')
        const second = new URL(String(url)).searchParams.has('start_cursor')
        return Response.json({ object: 'list', results: [{ type: 'rich_text', rich_text: chunks[second ? 1 : 0] }],
          has_more: !second, next_cursor: second ? null : 'next' })
      }
      const response = await raw(url, init)
      const page = await response.json()
      page.properties[FIRST_MATE_TASKS].id = 'f%5C%5C%3Ap'
      return Response.json(page)
    })
    const result = await notionLinkTransport(secret, board, fetcher, fake.timing).read(a)
    expect(result.links).toEqual({ status: 'valid', tasks: [link('sibling', 'x'.repeat(2200))] })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it.each(['truncated', 'wrong-type', 'missing-property', 'wrong-board', 'archived', 'unreadable', 'oversized-total'])(
    'refuses full-property/card failure %s before writing', async condition => {
      const fake = fakeNotion()
      const raw = fake.fetcher.getMockImplementation()!
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).includes('/properties/')) {
          if (condition === 'truncated') return Response.json({ object: 'list', results: [], has_more: true })
          if (condition === 'unreadable') return Response.json({ object: 'list', results: [{ type: 'relation' }], has_more: false })
          if (condition === 'oversized-total') return Response.json({ object: 'list', results: Array.from({ length: 101 }, () => ({ type: 'rich_text', rich_text: { plain_text: ' ' } })), has_more: false })
        }
        const response = await raw(url, init)
        const page = await response.json()
        if (condition === 'wrong-type') page.properties[FIRST_MATE_TASKS].type = 'select'
        if (condition === 'missing-property') delete page.properties[FIRST_MATE_TASKS]
        if (condition === 'wrong-board') page.parent.data_source_id = fixtureId(777)
        if (condition === 'archived') page.archived = true
        return Response.json(page)
      })
      const { result } = await run(source(), fake, { transport: notionLinkTransport(secret, board, fetcher, fake.timing) })
      expect(result.stopped).toBe(true)
      expect(fake.patches).toHaveLength(0)
    })
  it('stops a later card when source coverage expires during this invocation', async () => {
    const fake = fakeNotion()
    let audited = false
    const { result } = await run(source(true), fake, { audit: async (entry: AdapterAudit) => {
      if (entry.result === 'verified' && !audited) { audited = true; await fake.timing.sleep(61_000) }
    } })
    expect(result.stopped).toBe(true)
    expect(fake.patches.map(p => p.id)).toEqual([a])
  })
  it('enforces the ten-worker bound without dropping siblings or partially applying a card', async () => {
    const input = source(), task = input.fleet[0]!.observation.data!.tasks[0]!
    input.fleet[0]!.observation.data!.tasks = Array.from({ length: 11 }, (_, i) => ({ ...structuredClone(task), identity: { ...task.identity, task_id: `worker-${i}` } }))
    const { fake, audit } = await run(input)
    expect(fake.patches).toHaveLength(0)
    expect(audit.at(-1)?.result).toBe('batch-limit')
  })
  it('rejects the complete merged record if adding a worker exceeds Notion limits', async () => {
    const fake = fakeNotion([link('old', 'x'.repeat(199800))])
    const { result } = await run(source(), fake)
    expect(result.stopped).toBe(true)
    expect(fake.patches).toHaveLength(0)
  })
  it('bounds 429 retries and stops the batch when exhausted', async () => {
    const fake = fakeNotion()
    fake.setRateLimits(10)
    const { result } = await run(source(true), fake)
    expect(result.stopped).toBe(true)
    expect(fake.patches).toHaveLength(3)
    expect(fake.patches.every(p => p.id === a)).toBe(true)
  })
  it('honors card filters and the explicit card batch limit', async () => {
    const fake = fakeNotion()
    const filtered = await run(source(true), fake, { cards: [b] })
    expect(fake.patches.map(p => p.id)).toEqual([b])
    expect(filtered.audit.some(e => e.cardId === a && e.result === 'filtered')).toBe(true)
    const bounded = await run(source(true), fakeNotion(), { maxCards: 1 })
    expect(bounded.fake.patches.map(p => p.id)).toEqual([a])
    expect(bounded.audit.some(e => e.cardId === b && e.result === 'batch-limit')).toBe(true)
  })
  it('requires the audit append to succeed before writing', async () => {
    const fake = fakeNotion()
    await expect(run(source(), fake, { audit: async () => { throw new Error('disk full') } })).rejects.toThrow('disk full')
    expect(fake.patches).toHaveLength(0)
  })
  it.each([
    'checks green: PR ready for review',
    'checks green: PR ready for review (still monitoring for merge/close)',
    'checks green: PR held for merge (ci monitor ended)',
    'run passed: PR open',
    'run passed: PR open · pr=https://github.com/except-pass/tinstar/pull/292',
  ])('plans a done worker with an open review pull request (%s)', async detail => {
    const input = source(), task = input.fleet[0]!.observation.data!.tasks[0]!
    task.lastEventText = 'done [at=1]: checks green'
    task.current_state.state = 'done'
    task.current_state.detail = detail
    task.pr.url = 'https://github.com/except-pass/tinstar/pull/292'
    const { result } = await run(input, fakeNotion(), { apply: false })
    expect(result.report.homes[0]?.tiers['eligible auto-write']).toEqual([expect.objectContaining({
      proposals: [expect.objectContaining({ cardId: a, fm_home: '/fixture/hulk', task_id: 'linked-worker', spawn_gen: 'attempt-1', strength: 'dispatch-ledger' })],
    })])
    expect(result.plannedWrites).toHaveLength(1)
    expect(result.decisions).toContainEqual(expect.objectContaining({ cardId: a, result: 'planned', identities: [link()] }))
  })
  it.each([
    ['run passed: PR merged', 'https://github.com/except-pass/tinstar/pull/292'],
    ['checks green: PR merged (ci monitor ended)', 'https://github.com/except-pass/tinstar/pull/292'],
    ['run passed: PR closed', 'https://github.com/except-pass/tinstar/pull/292'],
    ['run completed', null],
    ['checks green: PR ready for review', null],
  ])('does not plan a done worker for pull disposition %j', async (detail, url) => {
    const input = source(), task = input.fleet[0]!.observation.data!.tasks[0]!
    task.lastEventText = 'done [at=1]: checks green'
    task.current_state.state = 'done'
    task.current_state.detail = detail
    task.pr.url = url
    task.backlog.title = 'checks green: PR ready for review'
    const { result } = await run(input, fakeNotion(), { apply: false })
    expect(result.report.homes[0]?.tiers['eligible auto-write']).toEqual([])
    expect(result.plannedWrites).toEqual([])
  })
  it('keeps a done secondmate with an open pull request out of the write', async () => {
    const input = source(), task = input.fleet[0]!.observation.data!.tasks[0]!
    task.lastEventText = 'done [at=1]: checks green'
    task.current_state.state = 'done'
    task.current_state.detail = 'checks green: PR ready for review'
    task.pr.url = 'https://github.com/except-pass/tinstar/pull/292'
    task.kind = 'secondmate'
    const { result } = await run(input, fakeNotion(), { apply: false })
    expect(result.report.homes[0]?.tiers['eligible auto-write']).toEqual([])
    expect(result.plannedWrites).toEqual([])
  })
  it('routes repeated malformed dispatch lines with the same investigation key', async () => {
    const input = source(), task = input.fleet[0]!.observation.data!.tasks[0]!
    task.dispatchProvenance = parseDispatchProvenance(['card: malformed'])
    const first = await run(input), second = await run(input)
    expect(first.audit[0]!.investigationKey).toEqual(second.audit[0]!.investigationKey)
    expect(first.audit[0]!.result).toBe('conflicts')
    expect(first.fake.patches).toHaveLength(0)
  })
})
