import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { fixtureHomes, fixtureId, fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { executionWarnings } from '../workflowViews'
import { needsWill } from '../needsWill'
import { buildQueue } from '../queue'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import type { CardContextRead } from '../cardContext'
import type { PullsRead } from '../../../shared/pulls'
const now = Date.parse('2026-11-10T14:00:00Z')

describe('per-source advisory execution warnings', () => {
  it('uses each linked home expiry, including the publication allowance, and ignores unrelated source failures', () => {
    const scene = fixtureScene({ now }), card = scene.cards.find(card => card.id === fixtureId(1))!
    const workers = scene.executions.filter(worker => scene.claims.some(claim => claim.cardId === card.id && claim.executionId === worker.id))
    for (const worker of workers) worker.source.current_state.state = 'blocked'
    scene.coverage.homes[0]!.observation.status = 'stale' // unrelated home
    expect(executionWarnings(scene, now).find(warning => warning.cardId === card.id)?.state).toBe('no-running-worker')
    const home = scene.coverage.homes.find(home => home.source.home === fixtureHomes[1])!
    home.observation.observedAt = new Date(now - 120_000).toISOString()
    home.observation.expiresAt = new Date(now + 180_000).toISOString()
    expect(executionWarnings(scene, now).find(warning => warning.cardId === card.id)?.state).toBe('no-running-worker')
    home.observation.expiresAt = new Date(now - 1).toISOString()
    expect(executionWarnings(scene, now).find(warning => warning.cardId === card.id)?.state).toBe('unknown')
    expect(card.source.properties.Status?.value).toBe('In Progress')
  })
  it('accepts positive native or external evidence; a stale sibling never negates a running worker', () => {
    const scene = fixtureScene({ now }), card = scene.cards.find(card => card.id === fixtureId(1))!
    scene.coverage.homes[1]!.observation.status = 'stale'
    expect(executionWarnings(scene, now).some(warning => warning.cardId === card.id)).toBe(false)
    card.source.properties['First Mate tasks']!.value = 'unreadable legacy record'
    card.source.properties['Delegated To'] = { id: 'external', type: 'rich_text', value: JSON.stringify({ schema: 'tinstar.external-worker.v1', kind: 'external', system: 'Build runner', run_id: 'one', reference: 'https://runner.example/one', card_id: card.id, observed_at: new Date(now).toISOString(), state: 'running', evidence: 'Actively compiling the assigned card', reported_by: 'Clawson' }), hasMore: false }
    expect(executionWarnings(scene, now).some(warning => warning.cardId === card.id)).toBe(false)
    expect(executionWarnings(scene, now + 300_001).find(warning => warning.cardId === card.id)?.state).toBe('unknown')
  })
  it('preserves unknown links and detects a declared missing worker only in its own fresh complete source', () => {
    const scene = fixtureScene({ now }), card = scene.cards.find(card => card.id === fixtureId(1))!
    const declared = JSON.parse(String(card.source.properties['First Mate tasks']!.value))
    const homes = new Set(declared.tasks.map((task: { fm_home: string }) => task.fm_home))
    scene.executions = scene.executions.filter(worker => !scene.claims.some(claim => claim.cardId === card.id && claim.executionId === worker.id))
    expect(executionWarnings(scene, now).find(warning => warning.cardId === card.id)?.state).toBe('no-running-worker')
    const home = scene.coverage.homes.find(home => homes.has(home.source.home))!
    home.observation.coverage = 'partial'
    expect(executionWarnings(scene, now).find(warning => warning.cardId === card.id)?.state).toBe('unknown')
    card.source.properties['First Mate tasks']!.value = ''
    expect(executionWarnings(scene, now).find(warning => warning.cardId === card.id)?.state).toBe('unknown')
  })
})

function requestContext(answered = false): CardContextRead {
  return { outcome: 'available', blocks: [
    { id: 'ask', type: 'comment', text: 'Requested from: Will\nQuestion: Accept the result?\nTin Star request: {"id":"request-one","action":"Decision","preserve_action":false}', createdAt: '2026-11-09T12:00:00Z' },
    ...(answered ? [{ id: 'answer', type: 'comment', text: 'Tin Star answer: "request-one"' }] : []),
  ] }
}
describe('one Needs Will projection', () => {
  it('retains current tags despite historical answers and omits empty tags', () => {
    const snapshot = fixtureSources({ now }), card = snapshot.intentions.data!.cards.find(card => card.id === fixtureId(1))!
    card.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Decision'], hasMore: false }
    card.properties['Next action'] = { id: 'action', type: 'rich_text', value: 'Accept the result', hasMore: false }
    const scene = fixtureScene({ now }); scene.cards.find(row => row.id === card.id)!.source = card
    let queue = buildQueue(snapshot, new Map(), now)
    const open = needsWill(queue, scene, new Map([[card.id, requestContext()]]), null, new Map())
    expect(open.map(item => item.cardIds)).toEqual([[card.id]])
    expect(open[0]).toMatchObject({ requestSince: '2026-11-09T12:00:00Z', ageBasis: 'request-history' })
    expect(needsWill(queue, scene, new Map([[card.id, requestContext(true)]]), null, new Map())[0]).toMatchObject({ requestSince: null, ageBasis: 'unknown', requests: [] })
    card.properties['Waiting For'] = { id: 'wait', type: 'rich_text', value: 'Will to supply approval; unblocks deployment; Firstmate follows up', hasMore: false }
    expect(needsWill(queue, scene, new Map([[card.id, requestContext(true)]]), null, new Map())[0]).toMatchObject({ requestSince: null, ageBasis: 'unknown' })
    delete card.properties['Waiting For']
    card.properties['Will action']!.value = ['Decision', 'Merge']
    queue = buildQueue(snapshot, new Map(), now)
    expect(needsWill(queue, scene, new Map([[card.id, requestContext(true)]]), null, new Map())).toHaveLength(1)
    card.properties['Will action']!.value = ['None']
    queue = buildQueue(snapshot, new Map(), now)
    expect(needsWill(queue, scene, new Map(), null, new Map())).toEqual([])
  })
  it('joins explicitly requested PRs through the existing canonical evidence, never every green PR or a fabricated wait age', () => {
    const snapshot = fixtureSources({ now }), card = snapshot.intentions.data!.cards.find(card => card.id === fixtureId(1))!
    const url = 'https://github.com/except-pass/tinstar/pull/100'
    card.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Merge'], hasMore: false }
    card.properties['Next action'] = { id: 'next', type: 'rich_text', value: 'Merge the reviewed change', hasMore: false }
    card.properties.Link = { id: 'link', type: 'url', value: url, hasMore: false }
    const scene = fixtureScene({ now }); scene.cards.find(row => row.id === card.id)!.source = card
    const readiness = new Map([[url, { status: 'fresh' as const, state: 'open' as const, head: 'a'.repeat(40), draft: false, checks: 'passed' as const, mergeability: 'ready' as const, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }]])
    const inventory: PullsRead = { pulls: [{ id: 'except-pass/tinstar#100', repository: 'except-pass/tinstar', number: 100, url, title: 'Requested change', author: 'agent', draft: false, head: 'a'.repeat(40), base: 'main', createdAt: '2026-11-01T00:00:00Z', updatedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), freshness: 'fresh', state: 'open', links: [] }], repositories: [], warnings: [], associationsComplete: true }
    const queue = buildQueue(snapshot, readiness, now)
    const items = needsWill(queue, scene, new Map(), inventory, readiness, true)
    expect(items).toHaveLength(1)
    expect(items[0]?.pulls[0]).toMatchObject({ title: 'Requested change', readiness: { checks: 'passed' } })
    expect(items[0]).toMatchObject({ requestSince: null, ageBasis: 'unknown' })
    delete card.properties.Link
    inventory.pulls[0]!.links = [{ cardId: card.id, active: true, sources: ['Manual association'], events: [] }]
    const associated = buildQueue(snapshot, readiness, now, inventory)
    expect(associated.items.find(item => item.cardIds.includes(card.id))?.evidence.filter(link => link.kind === 'pull-request')).toEqual([{ kind: 'pull-request', url }])
    expect(needsWill(associated, scene, new Map(), inventory, readiness, true)[0]?.pulls).toHaveLength(1)
    inventory.pulls[0]!.url = url.replace('except-pass', 'EXCEPT-PASS') + '?tab=checks'
    card.properties.Link = { id: 'link', type: 'url', value: url, hasMore: false }
    expect(needsWill(buildQueue(snapshot, readiness, now, inventory), scene, new Map(), inventory, readiness, true)[0]?.pulls).toHaveLength(1)
    delete card.properties.Link
    inventory.pulls[0]!.links[0]!.active = false
    expect(needsWill(buildQueue(snapshot, readiness, now, inventory), scene, new Map(), inventory, readiness, true)[0]?.pulls).toEqual([])
    delete card.properties['Will action']; delete card.properties['Next action']
    expect(needsWill(buildQueue(snapshot, readiness, now), scene, new Map(), inventory, readiness, true)).toEqual([])
  })
  it('does not infer an answer or missing request from incomplete comment coverage', () => {
    const snapshot = fixtureSources({ now }), card = snapshot.intentions.data!.cards.find(card => card.id === fixtureId(1))!
    card.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Decision'], hasMore: false }
    card.properties['Next action'] = { id: 'next', type: 'rich_text', value: 'Choose the design', hasMore: false }
    const scene = fixtureScene({ now }); scene.cards.find(row => row.id === card.id)!.source = card
    expect(needsWill(buildQueue(snapshot, new Map(), now), scene, new Map([[card.id, { ...requestContext(true), outcome: 'partial' }]]), null, new Map())).toHaveLength(1)
  })
})

it('keeps a current explicit action tag visible for verification even without next-action prose', () => {
  const snapshot = fixtureSources({ now }), card = snapshot.intentions.data!.cards.find(card => card.id === fixtureId(1))!
  card.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Decision'], hasMore: false }
  const scene = fixtureScene({ now }); scene.cards.find(row => row.id === card.id)!.source = card
  expect(needsWill(buildQueue(snapshot, new Map(), now), scene, new Map(), null, new Map())[0]).toMatchObject({ cardIds: [card.id], readiness: 'needs-readiness-verification', ageBasis: 'unknown' })
})

it('keeps asks with authorization placeholders until the PR Operations owner check passes', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { PullsApi } = await import('../../pulls/routes')
  const { ReconciliationSources } = await import('../index')
  const { CardContextReader } = await import('../cardContext')
  const root = await mkdtemp(join(process.cwd(), '.owner-view-test-'))
  const context = vi.spyOn(CardContextReader.prototype, 'commentDetails').mockResolvedValue({ outcome: 'available', blocks: [] })
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
    const sources = new ReconciliationSources({ fleet: [], warnings: [] }, undefined, undefined, root)
    const snapshot = fixtureSources({ now: Date.now() }), card = snapshot.intentions.data!.cards.find(card => card.id === fixtureId(1))!
    card.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Merge'], hasMore: false }
    const url = 'https://github.com/except-pass/tinstar/pull/100'
    card.properties.Link = { id: 'link', type: 'url', value: url, hasMore: false }
    vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
    const api = new PullsApi(sources, undefined, root)
    sources.authorizePulls = req => api.authorized(req)
    const inventory: PullsRead = { pulls: [{ id: 'except-pass/tinstar#100', repository: 'except-pass/tinstar', number: 100, url, title: 'Private title', author: 'private-author', head: 'a'.repeat(40), base: 'private-branch', draft: false, createdAt: '', updatedAt: '', observedAt: '', freshness: 'fresh', links: [] }], repositories: [], warnings: [], associationsComplete: true }
    const read = vi.fn(async () => inventory), readiness = vi.fn(async () => new Map())
    sources.readPulls = read
    sources.readPullReadiness = readiness
    const request = (headers: Record<string, string>, peer = '127.0.0.1') => {
      const req = new IncomingMessage(new Socket())
      req.headers = headers
      Object.defineProperty(req.socket, 'remoteAddress', { value: peer })
      return req
    }
    for (const req of [undefined, request({ 'x-tinstar-ui': '1' }), request({ 'tailscale-user-login': 'stranger@example.test' }), request({ 'tailscale-user-login': 'owner@example.test' }, '100.64.0.1')]) {
      const result = await sources.queue(req)
      expect(result.needsWill?.find(item => item.cardIds.includes(card.id))).toMatchObject({ pulls: [], prDetails: 'PR details require owner authorization' })
      expect(JSON.stringify(result)).not.toContain('Private title')
    }
    expect(read).not.toHaveBeenCalled()
    expect(readiness).not.toHaveBeenCalled()
    const result = await sources.queue(request({ 'tailscale-user-login': 'owner@example.test' }))
    expect(result.needsWill?.find(item => item.cardIds.includes(card.id))?.pulls[0]).toMatchObject({ title: 'Private title', author: 'private-author', base: 'private-branch' })
    expect(read).toHaveBeenCalledTimes(1)
    expect(readiness).toHaveBeenCalledTimes(1)
    const scene = fixtureScene({ now }); scene.cards.find(row => row.id === card.id)!.source = card
    expect(needsWill(buildQueue(snapshot), scene, new Map(), inventory, new Map())[0]).toMatchObject({ pulls: [], prDetails: 'PR details require owner authorization' })
  } finally {
    context.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('projects typed publications only onto their exact open source, preserving generation and supersession', async () => {
  const { fixtureProposal } = await import('../../../../test-fixtures/reconciliation/decisionProposal')
  const scene = fixtureScene({ now }), card = scene.cards[0]!
  card.source.properties['Will action'] = { id: 'action', type: 'multi_select', value: ['Decision'], hasMore: false }
  const sourceRequest = { home: '/fixture-home', taskId: 'task-a', kind: 'decision' as const, id: 'fixture-source' }
  const base = buildQueue(fixtureSources({ now }), new Map(), now)
  const item = { ...base.items[0]!, id: 'request-a', readiness: 'ready-now' as const, cardIds: [card.id], sources: [{ kind: 'firstmate' as const, id: 'source', field: 'decision', action: 'Choose a route?', request: sourceRequest, responseAnchor: 'fixture-anchor', generation: 'gen-1', status: 'fresh' as const, coverage: 'complete' as const, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }] }
  base.items = [item, { ...item, id: 'request-b' }]
  const old = fixtureProposal(item.id, card.id), current = { ...old, proposal_id: 'new-proposal', supersedes: old.proposal_id, source: { ...old.source, revision: '2' } }
  const contexts = new Map([[card.id, { outcome: 'available' as const, blocks: [old, current].map((proposal, index) => ({ id: `note-${index}`, type: 'comment', text: `Requested from: Will\nQuestion: Choose a route?\nTin Star request: ${JSON.stringify({ id: `request-note-${index}`, action: 'Decision', proposal, source_request: sourceRequest, source_question: 'Choose a route?', source_spawn_gen: 'gen-1' })}` })) }]])
  let projected = needsWill(base, scene, contexts, null, new Map())
  expect(projected[0]!.proposal?.value.proposal_id).toBe(current.proposal_id)
  expect(projected[1]!.proposal).toBeUndefined()
  const { decisionFresh } = await import('../../../shared/decisionProposal')
  const partial = new Map<string, CardContextRead>([[card.id, { ...contexts.get(card.id)!, outcome: 'partial', blocks: contexts.get(card.id)!.blocks.slice(0, 1) }]])
  const retained = needsWill(base, scene, partial, null, new Map())[0]!
  expect(retained.proposal?.value.proposal_id).toBe(old.proposal_id)
  expect(retained.readiness).toBe('needs-readiness-verification')
  expect(decisionFresh(retained, now)).toBe(false)
  expect(decisionFresh(needsWill(base, scene, contexts, null, new Map())[0]!, now)).toBe(true)
  item.sources[0]!.generation = 'gen-2'
  projected = needsWill(base, scene, contexts, null, new Map())
  expect(projected[0]!.proposal).toBeUndefined()
})
