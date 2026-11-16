import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { ReconciliationMcp, type PresentationReaders } from '../mcp'
import { CardLeases, leaseDuration } from '../cardLeases'
import { currentWillRequests, oldestOpenRequestSince } from '../claimPolicy'
import { releasePull } from '../../../shared/releases'
import { waitLine } from '../../../shared/waitingForPolicy'
import { buildQueue, claimCardReadiness } from '../queue'
import { needsWill } from '../needsWill'
import { SceneReconciler } from '../scene'
import type { WorkCard } from '../workReader'
import { decisionItems } from '../../../shared/reconciliationQueue'
import { ReconciliationSources } from '../index'
import { CardContextReader, type CardContextRead } from '../cardContext'
import { hasQueue } from '../../../shared/reconciliationQueue'
import { claimCardReadiness } from '../queue'

const roots: string[] = [], clients: Client[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const secIds = ['40d50ce6d422814dac1dca0111512c71', '40d50ce6d422819abdc4c77fbc99cffe']
const parked = 'Parked in Backlog per Will. No active decision or approval requested until reprioritized.'
function card(id = 'a'.repeat(32), values: Record<string, unknown> = {}): WorkCard {
  const base = structuredClone(fixtureSources().intentions.data!.cards[0]!)
  return { ...base, id, properties: Object.fromEntries(Object.entries({ Name: 'Owner decision', Owner: 'Will', Status: 'Waiting For', 'Waiting For': 'Will: Approve the security exception', 'Waiting For Type': 'Actor', 'Waiting For ID': 'Will',
    'Will action': ['Decision'], 'Next action': 'Approve the security exception', ...values }).map(([name, value]) =>
    [name, { id: name, type: 'rich_text', value, hasMore: false }])) }
}
async function fixture(cards: WorkCard[], claimHistory?: PresentationReaders['claimHistory']) {
  const root = await mkdtemp(join(tmpdir(), 'claim-actionable-')); roots.push(root)
  let now = Date.now()
  const leases = new CardLeases(root, () => now)
  const snapshot = fixtureSources()
  snapshot.fleet = []
  snapshot.intentions.data!.cards = structuredClone(cards)
  const queue = buildQueue(snapshot)
  const contexts = new Map(cards.map(card => [card.id, { outcome: 'available' as const, blocks: [] }]))
  queue.needsWill = needsWill(queue, new SceneReconciler().reconcile(snapshot), contexts, null, new Map())
  const current = new Map(cards.map(card => [card.id, card]))
  const currentCard = vi.fn(async (id: string) => {
    const found = current.get(id)
    if (!found) throw new Error('Unavailable')
    return structuredClone(found)
  })
  const workViews = vi.fn(async () => queue)
  const mcp = new ReconciliationMcp({ leases, queue: async () => queue, workViews, currentCard, claimHistory,
    getWork: async input => ({ outcome: 'available', card: { id: (input as { card_id: string }).card_id } }),
    scene: async () => new SceneReconciler().reconcile(snapshot), card: async () => ({}), workerLinkReport: async () => ({}) as never,
  } satisfies PresentationReaders, root)
  async function connect() {
    const client = new Client({ name: 'claim-actionable-test', version: '1' }); clients.push(client)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await mcp.createServer('Test owner').connect(serverTransport)
    await client.connect(clientTransport)
    return async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }> }
      return JSON.parse(result.content[0]!.text)
    }
  }
  const call = await connect()
  return { leases, queue, current, currentCard, workViews, call, connect, advance: () => { now += leaseDuration } }
}
const claim = (operation_id: string) => ({ operation_id })
const propertyAsks = [
  ['41950ce6d42281d7bf0de08d4e39b9e9', 'Decision'],
  ['41550ce6d422818eb238d870dad40a3f', 'Do'],
  ['41a50ce6d42281c3a9e3ee1cc6463b57', 'Merge'],
  ['41950ce6d42281e0b79ccfe2a76af710', 'Elevated command'],
] as const
function propertyAsk(id: string = propertyAsks[0][0], action: string = 'Decision', values: Record<string, unknown> = {}) {
  return card(id, { Status: 'Waiting For', 'Will action': [action], 'Next action': '',
    'Waiting For': 'Will: choose the next step', 'Waiting For Type': 'Actor', 'Waiting For ID': 'Will', ...values })
}

it.each(propertyAsks)('claims property ask %s (%s) without a request record, including while history loads', async (id, action) => {
  const f = await fixture([propertyAsk(id, action)])
  for (const complete of [true, false]) {
    f.queue.needsWill![0]!.proposalHistoryComplete = complete
    expect(f.queue.needsWill![0]!.requests).toEqual([])
    const result = await f.call('claim_next_card', claim(`property-${complete}`))
    expect(result).toMatchObject({ outcome: 'claimed', lease: { card_id: id }, readiness: 'ready-now',
      readiness_reasons: expect.arrayContaining([expect.stringContaining('Will property ask')]) })
    await f.call('release_claim', { lease_token: result.lease_token, reason: 'Property claim checked' })
  }
})

it.each(['Done', 'archived', 'in_trash', 'future', 'answered', 'owner', 'status', 'tag', 'wait', 'type', 'actor-id'])('skips a %s property ask', async mode => {
  const f = await fixture([propertyAsk()]), current = f.current.get(propertyAsks[0][0])!
  f.queue.needsWill![0]!.proposalHistoryComplete = false
  if (mode === 'archived' || mode === 'in_trash') current[mode] = true
  else if (mode === 'future') current.properties['Start Date'] = { id: 'start', type: 'date', value: { start: '2099-01-01' }, hasMore: false }
  else if (mode === 'answered') f.queue.needsWill![0]!.requests.push({ id: 'answered', cardId: current.id, action: 'Decision',
    preserveAction: false, options: undefined, requestedFrom: 'Will', question: 'Choose the next step', since: null, sourceId: 'answer', answered: true })
  else {
    const [key, value] = ({ Done: ['Status', 'Done'], owner: ['Owner', 'Firstmate'], status: ['Status', 'Backlog'],
      tag: ['Will action', ['Approval']], wait: ['Waiting For', 'Review pending'], type: ['Waiting For Type', 'Event'],
      'actor-id': ['Waiting For ID', 'Firstmate'] } as Record<string, [string, unknown]>)[mode]!
    current.properties[key]!.value = value
  }
  expect(await f.call('claim_next_card', claim(mode))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status(current.id)).toBeNull()
})

it('does not resurrect an answered structured request with complete history and a concrete Next action', async () => {
  const f = await fixture([card()])
  f.queue.needsWill![0]!.requests.push({ id: 'answered', cardId: 'a'.repeat(32), action: 'Decision', preserveAction: false,
    options: undefined, requestedFrom: 'Will', question: 'Approve the security exception', since: null, sourceId: 'answer', answered: true })
  expect(await f.call('claim_next_card', claim('answered-record'))).toMatchObject({ outcome: 'no-unclaimed-card' })
})

it('fences a source write while reading a property ask', async () => {
  const f = await fixture([propertyAsk()])
  f.queue.needsWill![0]!.proposalHistoryComplete = false
  f.currentCard.mockImplementationOnce(async id => {
    const before = structuredClone(f.current.get(id)!)
    await f.leases.mutate(id, async () => { f.current.get(id)!.properties.Status!.value = 'Done' })
    return before
  })
  expect(await f.call('claim_next_card', claim('property-write-race'))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status(propertyAsks[0][0])).toBeNull()
})

it.each(['loading', 'answered-comment', 'answered-body'])('uses the property census with %s history and retains known answers', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'claim-property-census-')); roots.push(root)
  const ask = propertyAsk(), snapshot = fixtureSources()
  snapshot.fleet = []; snapshot.intentions.data!.cards = [ask]
  const context: CardContextRead = { outcome: 'available', blocks: [
    { id: 'request', type: 'paragraph', text: 'Requested from: Will\nQuestion: Choose the next step\nTin Star request: {"id":"decision","action":"Decision"}' },
    { id: 'answer', type: 'paragraph', text: 'Tin Star answer: "decision"' },
  ] }
  vi.spyOn(CardContextReader.prototype, 'details').mockImplementation(() => new Promise(() => {}))
  vi.spyOn(CardContextReader.prototype, 'cachedComments').mockReturnValue(mode === 'answered-comment' ? context : undefined)
  vi.spyOn(CardContextReader.prototype, 'cachedClaimBlocks').mockReturnValue(mode === 'loading' ? [] : context.blocks)
  vi.spyOn(CardContextReader.prototype, 'cachedDecisionHistory').mockReturnValue(mode === 'answered-body' ? {
    context, observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30_000).toISOString(),
  } : undefined)
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, fetch, undefined, root)
  vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
  const queue = await sources.claimQueue()
  expect(hasQueue(queue)).toBe(true)
  if (!hasQueue(queue)) throw new Error('Expected property census')
  const item = queue.needsWill![0]!
  if (mode === 'loading') {
    expect(item.proposalHistoryComplete).toBe(false)
    expect(item.readiness).not.toBe('ready-now')
    expect(claimCardReadiness(item, ask)).toMatchObject({ readiness: 'ready-now' })
  } else {
    expect(item.requests).toContainEqual(expect.objectContaining({ id: 'decision', answered: true }))
    expect(claimCardReadiness(item, ask)).toBeNull()
  }
})

it.each(propertyAsks)('also supports an explicit claim of property ask %s (%s)', async (id, action) => {
  const f = await fixture([propertyAsk(id, action)])
  expect(await f.call('claim_card', { ...claim(`exact-${action}`), card_id: id })).toMatchObject({ outcome: 'claimed', lease: { card_id: id } })
})

it('skips both reported parked SEC cards, even when the stale queue still lists a freshly Done card', async () => {
  const f = await fixture([...secIds.map(id => card(id, { Status: 'Backlog', 'Next action': parked })), card()])
  f.current.get(secIds[1]!)!.properties.Status!.value = 'Done'
  expect(await f.call('claim_next_card', claim('skip-sec'))).toMatchObject({ outcome: 'claimed', lease: { card_id: 'a'.repeat(32) }, readiness: 'ready-now' })
  for (const id of secIds) expect(f.leases.status(id)).toBeNull()
})

it('excludes legacy Backlog approval asks until they have the strict owner fields', async () => {
  const approval = card('b'.repeat(32), { Owner: 'Firstmate', Status: 'Backlog', 'Will action': ['Approval'] })
  const f = await fixture([approval])
  expect(await f.call('claim_next_card', claim('approval'))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.currentCard).not.toHaveBeenCalled()
})

it('accepts a current concrete owner request from complete request history on a structured Will ask', async () => {
  const f = await fixture([card('a'.repeat(32), { 'Next action': '' })])
  const row = f.queue.needsWill![0]!
  row.requests = [{ id: 'approval', cardId: 'a'.repeat(32), action: 'Decision', preserveAction: false, options: undefined, requestedFrom: 'Will',
    question: 'Approve the security exception?', since: new Date().toISOString(), sourceId: 'request-note', answered: false }]
  row.action = 'Approve the security exception?'
  expect(await f.call('claim_next_card', claim('history-approval'))).toMatchObject({ outcome: 'claimed', readiness: 'ready-now' })
})

it('treats waiting for Will approval as the current request while retaining real prerequisites', async () => {
  const f = await fixture([card('a'.repeat(32), { 'Waiting For': 'Will: approve the security exception' })])
  const first = await f.call('claim_next_card', claim('owner-wait'))
  expect(first).toMatchObject({ outcome: 'claimed', readiness: 'ready-now' })
  await f.call('release_claim', { lease_token: first.lease_token, reason: 'Request reviewed' })
  f.current.get('a'.repeat(32))!.properties['Waiting For']!.value = 'Will: approve after the security review'
  expect(await f.call('claim_next_card', claim('real-prerequisite'))).toMatchObject({ outcome: 'no-unclaimed-card' })
})

it.each(['Done', 'Archived', 'archived', 'in_trash', 'no-action', 'no-request', 'future-date', 'future-condition', 'owner-removed'])('rejects fresh exact-card %s despite a ready cached queue', async change => {
  const f = await fixture([card()]), current = f.current.get('a'.repeat(32))!
  if (change === 'archived' || change === 'in_trash') current[change] = true
  else if (change === 'no-action') current.properties['Next action']!.value = ''
  else if (change === 'no-request') current.properties['Next action']!.value = 'No active approval requested'
  else if (change === 'future-date') current.properties['Start Date'] = { id: 'start', type: 'date', value: { start: '2099-01-01' }, hasMore: false }
  else if (change === 'future-condition') current.properties['Next action']!.value = 'Approve after the review completes'
  else if (change === 'owner-removed') { current.properties.Owner!.value = 'Clawson'; current.properties['Will action']!.value = [] }
  else current.properties.Status!.value = change
  expect(await f.call('claim_next_card', claim(change))).toMatchObject({ outcome: 'no-unclaimed-card', queue: 'needs-will' })
  expect(f.leases.status(current.id)).toBeNull()
})

it.each(['stale', 'unknown', 'expired', 'history', 'future'])('reports no actionable card with %s evidence and preserves coverage limitations', async mode => {
  const f = await fixture([card()])
  if (mode === 'history') { f.queue.needsWill![0]!.proposalHistoryComplete = false; f.queue.needsWill![0]!.readiness = 'needs-readiness-verification'; f.queue.needsWill![0]!.reasons = ['Publication history is incomplete; refresh before choosing'] }
  else if (mode === 'future') { f.queue.needsWill![0]!.sources.push({ ...f.queue.needsWill![0]!.sources[0]!, kind: 'firstmate', readiness: 'future-or-conditional' }); f.queue.needsWill![0]!.readiness = 'future-or-conditional' }
  else if (mode === 'expired') f.queue.coverage.intentions.expiresAt = new Date(Date.now() - 1).toISOString()
  else { f.queue.coverage.intentions.status = mode as 'stale' | 'unknown'; f.queue.coverage.intentions.coverage = 'unknown' }
  const result = await f.call('claim_next_card', claim(mode))
  expect(result).toMatchObject({ outcome: 'no-unclaimed-card', coverage: f.queue.coverage, warnings: f.queue.warnings })
  expect(result.message).toContain('covered queue')
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})

it('skips an ineligible row before an eligible row while keeping queue order', async () => {
  const f = await fixture([card('a'.repeat(32)), card('b'.repeat(32)), card('c'.repeat(32))])
  f.current.get('a'.repeat(32))!.properties['Next action']!.value = parked
  const result = await f.call('claim_next_card', claim('ordered'))
  expect(result.lease.card_id).toBe('b'.repeat(32))
  expect(f.currentCard.mock.calls.map(([id]) => id)).toEqual(['a'.repeat(32), 'b'.repeat(32)])
})

it('reports unknown exact-card evidence rather than treating a failed read as no request', async () => {
  const f = await fixture([card()])
  f.currentCard.mockRejectedValueOnce(new Error('Provider unavailable'))
  const result = await f.call('claim_next_card', claim('unknown-exact'))
  expect(result).toMatchObject({ outcome: 'no-unclaimed-card', coverage: f.queue.coverage })
  expect(result.warnings.join(' ')).toContain('Fresh exact-card eligibility is unknown')
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})

it.each(['stale', 'unknown', 'expired'])('skips %s source-local readiness even with fresh overall coverage', async mode => {
  const f = await fixture([card()]), source = f.queue.needsWill![0]!.sources[0]!
  if (mode === 'expired') source.expiresAt = new Date(Date.now() - 1).toISOString()
  else source.status = mode as 'stale' | 'unknown'
  expect(await f.call('claim_next_card', claim(mode))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})

it('keeps concurrent conversations exclusive and preserves retries, release/reclaim and 60-minute expiry', async () => {
  const f = await fixture([card(), card('b'.repeat(32))]), other = await f.connect()
  const [a, b] = await Promise.all([f.call('claim_next_card', claim('chat-a')), other('claim_next_card', claim('chat-b'))])
  expect(new Set([a.lease.card_id, b.lease.card_id]).size).toBe(2)
  expect(await f.call('claim_next_card', claim('chat-a'))).toMatchObject({ lease_token: a.lease_token, lease: a.lease })
  expect(await f.call('claim_next_card', { ...claim('repeat'), lease_token: a.lease_token })).toMatchObject({ outcome: 'held', lease_token: a.lease_token, lease: a.lease })
  expect(await f.call('claim_next_card', claim('none'))).toMatchObject({ outcome: 'no-unclaimed-card' })
  await f.call('release_claim', { lease_token: a.lease_token, reason: 'Done reviewing' })
  const reclaimed = await other('claim_next_card', claim('reclaim'))
  expect(reclaimed.lease.card_id).toBe(a.lease.card_id)
  expect(reclaimed.lease.generation).toBeGreaterThan(a.lease.generation)
  expect(await f.call('claim_next_card', claim('chat-a'))).toMatchObject({ code: 'claim-lost' })
  f.advance()
  expect(await other('claim_next_card', { ...claim('expired'), lease_token: reclaimed.lease_token })).toMatchObject({ code: 'claim-lost' })
  const expired = await f.call('claim_next_card', claim('new-generation'))
  expect(expired.lease.card_id).toBe('a'.repeat(32))
  expect(expired.lease.generation).toBeGreaterThan(reclaimed.lease.generation)
})

it('replays a lost response and resumes a held card when current queue evidence disappears', async () => {
  const f = await fixture([card()]), first = await f.call('claim_next_card', claim('first'))
  f.queue.needsWill = []
  expect(await f.call('claim_next_card', claim('first'))).toMatchObject({ lease_token: first.lease_token, lease: first.lease, readiness: 'unknown' })
  expect(await f.call('claim_next_card', { ...claim('held'), lease_token: first.lease_token })).toMatchObject({ outcome: 'held', lease: first.lease, readiness: 'unknown' })
})

it('rechecks eligibility inside allocation if coverage changes after preflight', async () => {
  const f = await fixture([card()]), original = f.leases.claim.bind(f.leases)
  vi.spyOn(f.leases, 'claim').mockImplementationOnce(async (...args) => {
    f.queue.coverage.intentions.status = 'stale'
    return original(...args)
  })
  expect(await f.call('claim_next_card', claim('atomic-check'))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})

it.each(['claim_next_card', 'claim_card'])('rejects a source write crossing the exact-card read before %s grants a lease', async tool => {
  const f = await fixture([card()])
  f.currentCard.mockImplementationOnce(async id => {
    const before = structuredClone(f.current.get(id)!)
    await f.leases.mutate(id, async () => { f.current.get(id)!.properties.Owner!.value = 'Firstmate' })
    return before
  })
  expect(await f.call(tool, { ...claim('write-race'), ...(tool === 'claim_card' ? { card_id: 'a'.repeat(32) } : {}) })).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})


it.each(['conditional', 'future', 'no-request'])('rejects a %s recorded request masked by a concrete Next action', async mode => {
  const f = await fixture([card('a'.repeat(32), { 'Next action': 'Implement security policy' })])
  f.queue.needsWill![0]!.requests = [{ id: 'decision', cardId: 'a'.repeat(32), action: 'Decision', preserveAction: true, options: undefined,
    requestedFrom: 'Will', question: mode === 'conditional' ? 'Approve the exception after the security review' :
      mode === 'no-request' ? 'No active decision requested' : 'Approve the exception?',
    since: mode === 'future' ? '2099-01-01' : new Date().toISOString(), sourceId: 'request-note', answered: false }]
  expect(await f.call('claim_next_card', claim(mode))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})

it.each(['candidate', 'sibling'])('fences a %s source write during request-history collection', async mode => {
  const f = await fixture([card('a'.repeat(32), { 'Next action': '' })])
  f.queue.needsWill![0]!.requests = [{ id: 'decision', cardId: 'a'.repeat(32), action: 'Decision', preserveAction: true, options: undefined,
    requestedFrom: 'Will', question: 'Approve the exception?', since: new Date().toISOString(), sourceId: 'request-note', answered: false }]
  f.workViews.mockImplementationOnce(async () => {
    const stale = structuredClone(f.queue)
    await f.leases.mutate(mode === 'candidate' ? 'a'.repeat(32) : 'b'.repeat(32), async () => {
      f.queue.needsWill![0]!.requests[0]!.answered = true
    })
    return stale
  })
  expect(await f.call('claim_next_card', claim(mode))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})

it.each(['Decision', 'Do', 'Elevated command'])('filters exact Will action %s before reading another card', async action => {
  const first = card('a'.repeat(32)), second = card('b'.repeat(32), { 'Will action': [action] })
  if (action === 'Decision') first.properties['Will action']!.value = ['Do']
  const f = await fixture([first, second])
  expect(await f.call('claim_next_card', { operation_id: `action-${action}`, will_action: action })).toMatchObject({ outcome: 'claimed', lease: { card_id: second.id } })
  expect(f.currentCard.mock.calls).toEqual([[second.id]])
})

it.each(['initiative', 'area', 'max_age_days'])('filters %s before fresh exact reads', async filter => {
  const f = await fixture([card('a'.repeat(32), { Initiative: 'Other', Area: 'Other' }), card('b'.repeat(32), { Initiative: ['initiative-id'], Area: 'Engineering' })])
  f.queue.needsWill![0]!.requestSince = new Date(Date.now() - 10 * 86400_000).toISOString()
  f.queue.needsWill![1]!.requestSince = new Date(Date.now() - 3600_000).toISOString()
  const args = filter === 'initiative' ? { initiative: 'initiative-id' } : filter === 'area' ? { area: 'Engineering' } : { max_age_days: 1 }
  expect(await f.call('claim_next_card', { operation_id: filter, ...args })).toMatchObject({ outcome: 'claimed', lease: { card_id: 'b'.repeat(32) } })
  expect(f.currentCard.mock.calls).toEqual([['b'.repeat(32)]])
})

it('intersects filters and excludes unknown request age without reading a card', async () => {
  const f = await fixture([card('a'.repeat(32), { Area: 'Engineering', Initiative: 'Tin Star' })])
  expect(await f.call('claim_next_card', { operation_id: 'unknown-age', area: 'Engineering', initiative: 'Tin Star', max_age_days: 3 })).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.currentCard).not.toHaveBeenCalled()
  expect(await f.call('claim_next_card', { operation_id: 'intersection', area: 'Other', initiative: 'Tin Star' })).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.currentCard).not.toHaveBeenCalled()
})

it.each([
  { Owner: 'Firstmate' }, { Status: 'Backlog' }, { 'Will action': [] }, { 'Will action': ['Approval'] },
  { 'Waiting For': 'Somebody mentioned Will' }, { 'Waiting For Type': 'Event' }, { 'Waiting For ID': 'Other' },
])('excludes malformed asks %j before fresh reads', async changed => {
  const f = await fixture([card('a'.repeat(32), changed)])
  expect(await f.call('claim_next_card', { operation_id: 'malformed' })).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.currentCard).not.toHaveBeenCalled()
})

it('filters Merge while retaining the existing verified PR readiness requirement', async () => {
  const other = card('a'.repeat(32)), merge = card('b'.repeat(32), { 'Will action': ['Merge'], 'Next action': 'Merge the reviewed security change', Link: 'https://github.com/except-pass/tinstar/pull/100' })
  const f = await fixture([other, merge])
  expect(await f.call('claim_next_card', { operation_id: 'unverified-merge', will_action: 'Merge' })).toMatchObject({ outcome: 'no-unclaimed-card' })
  const row = f.queue.needsWill!.find(item => item.cardIds.includes(merge.id))!
  row.readiness = 'ready-now'
  row.sources.forEach(source => { source.readiness = 'ready-now' })
  expect(await f.call('claim_next_card', { operation_id: 'verified-merge', will_action: 'Merge' })).toMatchObject({ outcome: 'claimed', lease: { card_id: merge.id } })
  expect(f.currentCard.mock.calls.flat()).not.toContain(other.id)
})


it.each([
  { Owner: 'Firstmate', Status: 'Backlog', 'Will action': [] },
  { Owner: 'Firstmate' },
  { Status: 'Backlog' },
  { 'Will action': ['Approval'] },
  { 'Waiting For': 'Will to approve the exception' },
  { 'Waiting For Type': 'Event' },
  { 'Waiting For ID': '' },
])('rejects new exact leases for malformed Needs Will fields %j', async values => {
  const current = card('a'.repeat(32), values)
  const f = await fixture([current])
  expect(await f.call('claim_card', { card_id: current.id, operation_id: 'malformed-exact' })).toMatchObject({ outcome: 'unavailable' })
  expect(f.leases.status(current.id)).toBeNull()
})

it('claims an exact strict ask and resumes its lease after workflow changes', async () => {
  const current = card()
  const f = await fixture([current])
  const first = await f.call('claim_card', { card_id: current.id, operation_id: 'strict-exact' })
  expect(first).toMatchObject({ outcome: 'claimed', lease: { card_id: current.id } })
  current.properties.Owner!.value = 'Firstmate'
  expect(await f.call('claim_card', { card_id: current.id, operation_id: 'resume-exact', lease_token: first.lease_token })).toMatchObject({ outcome: 'held', lease: { card_id: current.id } })
})


it('replays a lost exact claim response after strict fields change and permits release', async () => {
  const current = card(), f = await fixture([current])
  const args = { card_id: current.id, operation_id: 'lost-exact' }
  const first = await f.call('claim_card', args)
  current.properties.Owner!.value = 'Firstmate'
  const replay = await f.call('claim_card', args)
  expect(replay).toEqual(first)
  await f.call('release_claim', { lease_token: replay.lease_token, reason: 'Returned to mate' })
  expect(await f.call('claim_card', { card_id: current.id, operation_id: 'new-exact' })).toMatchObject({ outcome: 'unavailable', issues: ['Owner must be Will'], message: expect.stringContaining('owning mate must fix or retag') })
  expect(f.leases.status(current.id)).toBeNull()
})

it('uses only current-action open requests for age across request selection', () => {
  const notes = [
    { id: 'old', text: 'Requested from: Will\nQuestion: Implement?\nTin Star request: {"id":"old","action":"Do"}', createdAt: '2026-11-01T00:00:00Z' },
    { id: 'new', text: 'Requested from: Will\nQuestion: Approve?\nTin Star request: {"id":"new","action":"Decision"}', createdAt: '2026-11-16T00:00:00Z' },
  ]
  const requests = currentWillRequests(notes, ['Decision'])
  expect(requests.map(request => request.id)).toEqual(['new'])
  expect(oldestOpenRequestSince(requests)).toBe('2026-11-16T00:00:00Z')
})

it.each([false, true])('blocks independent waits with keyed request %s in projection and admission', async keyed => {
  const current = card(), f = await fixture([current])
  const row = f.queue.needsWill![0]!
  if (keyed) row.sources.push({ ...row.sources[0]!, kind: 'firstmate', responseAnchor: 'keyed', readiness: 'ready-now', action: 'Approve?' })
  current.properties['Waiting For']!.value = 'Will: Approve the exception\n' + waitLine({ type: 'Event', id: 'security', dependency: 'Security review', unblocks_when: 'Review complete', follow_up_by: 'Firstmate' })
  expect(claimCardReadiness(row, current)).toBeNull()
  const snapshot = fixtureSources()
  snapshot.fleet = []
  snapshot.intentions.data!.cards = [current]
  expect(buildQueue(snapshot).items.find(item => item.cardIds.includes(current.id))?.readiness).not.toBe('ready-now')
})


it.each([false, true])('preserves PR head conflict %s when refreshing request history', async conflict => {
  const current = card('a'.repeat(32), { 'Will action': ['Merge'], 'Next action': 'Merge the approved pull request', Link: 'https://github.com/acme/app/pull/7' })
  const f = await fixture([current], async () => ({ outcome: 'available', blocks: [] }))
  const snapshot = fixtureSources()
  snapshot.fleet = []
  snapshot.intentions.data!.cards = [current]
  const url = 'https://github.com/acme/app/pull/7'
  const identity = releasePull(url)!
  const readiness = new Map([[url, { status: 'fresh' as const, state: 'open' as const, head: 'A', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), draft: false, checks: 'passed' as const, mergeability: 'ready' as const }]])
  const inventory = { pulls: [{ ...identity, head: conflict ? 'B' : 'A', title: 'Approved change', author: 'owner', draft: false, base: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), observedAt: new Date().toISOString(), freshness: 'fresh' as const, links: [] }], repositories: [], warnings: [], associationsComplete: true }
  const queue = buildQueue(snapshot, readiness, Date.now(), inventory)
  f.queue.needsWill = needsWill(queue, new SceneReconciler().reconcile(snapshot), new Map(), inventory, readiness, true)
  const row = f.queue.needsWill.find(item => item.cardIds.includes(current.id))!
  expect(row.requestReadiness).toBe(conflict ? 'needs-readiness-verification' : 'ready-now')
  expect(await f.call('claim_next_card', claim('head-check'))).toMatchObject({ outcome: conflict ? 'no-unclaimed-card' : 'claimed' })
})


it('projects and freshly admits the current Decision age despite an older Do request', async () => {
  const current = card()
  const recent = new Date(Date.now() - 3600000).toISOString()
  const blocks = [
    { id: 'old', type: 'comment', text: 'Requested from: Will\nQuestion: Implement?\nTin Star request: {"id":"old","action":"Do"}', createdAt: new Date(Date.now() - 10 * 86400000).toISOString() },
    { id: 'new', type: 'comment', text: 'Requested from: Will\nQuestion: Approve?\nTin Star request: {"id":"new","action":"Decision"}', createdAt: recent },
  ]
  const history = { outcome: 'available' as const, blocks }
  const f = await fixture([current], async () => history)
  const snapshot = fixtureSources()
  snapshot.fleet = []
  snapshot.intentions.data!.cards = [current]
  f.queue.needsWill = needsWill(f.queue, new SceneReconciler().reconcile(snapshot), new Map([[current.id, history]]), null, new Map())
  expect(f.queue.needsWill[0]!.requestSince).toBe(recent)
  expect(await f.call('claim_next_card', { ...claim('current-age'), max_age_days: 1 })).toMatchObject({ outcome: 'claimed' })
})
