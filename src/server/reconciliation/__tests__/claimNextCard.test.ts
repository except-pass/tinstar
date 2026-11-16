import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { ReconciliationMcp, type PresentationReaders } from '../mcp'
import { CardLeases, leaseDuration } from '../cardLeases'
import { buildQueue } from '../queue'
import { needsWill } from '../needsWill'
import { SceneReconciler } from '../scene'
import type { WorkCard } from '../workReader'
import { decisionItems } from '../../../shared/reconciliationQueue'

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
  return { ...base, id, properties: Object.fromEntries(Object.entries({ Name: 'Owner decision', Owner: 'Will', Status: 'In Progress',
    'Will action': ['Decision'], 'Next action': 'Approve the security exception', ...values }).map(([name, value]) =>
    [name, { id: name, type: 'rich_text', value, hasMore: false }])) }
}
async function fixture(cards: WorkCard[]) {
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
  const mcp = new ReconciliationMcp({ leases, queue: async () => queue, workViews, currentCard,
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

it('skips both reported parked SEC cards, even when the stale queue still lists a freshly Done card', async () => {
  const f = await fixture([...secIds.map(id => card(id, { Status: 'Backlog', 'Next action': parked })), card()])
  f.current.get(secIds[1]!)!.properties.Status!.value = 'Done'
  expect(await f.call('claim_next_card', claim('skip-sec'))).toMatchObject({ outcome: 'claimed', lease: { card_id: 'a'.repeat(32) }, readiness: 'ready-now' })
  for (const id of secIds) expect(f.leases.status(id)).toBeNull()
})

it('claims a concrete approval on Backlog work without altering UI ordering or workflow status', async () => {
  const approval = card('b'.repeat(32), { Owner: 'Firstmate', Status: 'Backlog', 'Will action': ['Approval'] })
  const f = await fixture([approval])
  const before = structuredClone(f.current.get(approval.id)), ui = decisionItems(f.queue)
  const first = await f.call('claim_next_card', claim('approval'))
  expect(first).toMatchObject({ outcome: 'claimed', lease: { card_id: approval.id }, readiness: 'ready-now' })
  expect(first.readiness_reasons).not.toContain('Planned work or an agreed future start; no immediate owner decision')
  expect(await f.call('release_claim', { lease_token: first.lease_token, reason: 'Approval smoke complete' })).toMatchObject({ outcome: 'released' })
  expect(f.current.get(approval.id)).toEqual(before)
  expect(decisionItems(f.queue)).toEqual(ui)
  expect(f.queue.needsWill![0]!.readiness).toBe('future-or-conditional')
  expect(f.leases.status(approval.id)).toBeNull()
})

it('accepts a current concrete owner request from complete request history on Backlog work', async () => {
  const f = await fixture([card('a'.repeat(32), { Status: 'Backlog', 'Next action': '' })])
  const row = f.queue.needsWill![0]!
  row.requests = [{ id: 'approval', cardId: 'a'.repeat(32), action: 'Decision', preserveAction: false, options: undefined, requestedFrom: 'Will',
    question: 'Approve the security exception?', since: new Date().toISOString(), sourceId: 'request-note', answered: false }]
  row.action = 'Approve the security exception?'
  expect(await f.call('claim_next_card', claim('history-approval'))).toMatchObject({ outcome: 'claimed', readiness: 'ready-now' })
})

it('treats waiting for Will approval as the current request while retaining real prerequisites', async () => {
  const f = await fixture([card('a'.repeat(32), { Owner: 'Firstmate', Status: 'Backlog', 'Waiting For': 'Will to approve the security exception' })])
  const first = await f.call('claim_next_card', claim('owner-wait'))
  expect(first).toMatchObject({ outcome: 'claimed', readiness: 'ready-now' })
  await f.call('release_claim', { lease_token: first.lease_token, reason: 'Request reviewed' })
  f.current.get('a'.repeat(32))!.properties['Waiting For']!.value = 'Will to approve after the security review'
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

it('rejects a source write crossing the exact-card read before the atomic lease grant', async () => {
  const f = await fixture([card()])
  f.currentCard.mockImplementationOnce(async id => {
    const before = structuredClone(f.current.get(id)!)
    await f.leases.mutate(id, async () => { f.current.get(id)!.properties['Next action']!.value = parked })
    return before
  })
  expect(await f.call('claim_next_card', claim('write-race'))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})


it.each(['conditional', 'future', 'no-request'])('rejects a %s recorded request masked by a concrete Next action', async mode => {
  const f = await fixture([card('a'.repeat(32), { Status: 'Backlog', 'Next action': 'Implement security policy' })])
  f.queue.needsWill![0]!.requests = [{ id: 'decision', cardId: 'a'.repeat(32), action: 'Decision', preserveAction: true,
    requestedFrom: 'Will', question: mode === 'conditional' ? 'Approve the exception after the security review' :
      mode === 'no-request' ? 'No active decision requested' : 'Approve the exception?',
    since: mode === 'future' ? '2099-01-01' : new Date().toISOString(), sourceId: 'request-note', answered: false }]
  expect(await f.call('claim_next_card', claim(mode))).toMatchObject({ outcome: 'no-unclaimed-card' })
  expect(f.leases.status('a'.repeat(32))).toBeNull()
})

it.each(['candidate', 'sibling'])('fences a %s source write during request-history collection', async mode => {
  const f = await fixture([card('a'.repeat(32), { Status: 'Backlog', 'Next action': '' })])
  f.queue.needsWill![0]!.requests = [{ id: 'decision', cardId: 'a'.repeat(32), action: 'Decision', preserveAction: true,
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
