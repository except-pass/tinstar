import { describe, expect, it } from 'vitest'
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
  it('omits owner-only, empty tags and an already answered tag; retains other unresolved requests and explicit waits', () => {
    const snapshot = fixtureSources({ now }), card = snapshot.intentions.data!.cards.find(card => card.id === fixtureId(1))!
    card.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Decision'], hasMore: false }
    card.properties['Next action'] = { id: 'action', type: 'rich_text', value: 'Accept the result', hasMore: false }
    const scene = fixtureScene({ now }); scene.cards.find(row => row.id === card.id)!.source = card
    const queue = buildQueue(snapshot, new Map(), now)
    const open = needsWill(queue, scene, new Map([[card.id, requestContext()]]), null, new Map())
    expect(open.map(item => item.cardIds)).toEqual([[card.id]])
    expect(open[0]).toMatchObject({ requestSince: '2026-11-09T12:00:00Z', ageBasis: 'request-history' })
    expect(needsWill(queue, scene, new Map([[card.id, requestContext(true)]]), null, new Map())).toEqual([])
    card.properties['Waiting For'] = { id: 'wait', type: 'rich_text', value: 'Will to supply approval; unblocks deployment; Firstmate follows up', hasMore: false }
    expect(needsWill(queue, scene, new Map([[card.id, requestContext(true)]]), null, new Map())[0]).toMatchObject({ requestSince: null, ageBasis: 'unknown' })
    delete card.properties['Waiting For']
    card.properties['Will action']!.value = ['Decision', 'Merge']
    expect(needsWill(queue, scene, new Map([[card.id, requestContext(true)]]), null, new Map())).toHaveLength(1)
    card.properties['Will action']!.value = ['None']
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
    const items = needsWill(queue, scene, new Map(), inventory, readiness)
    expect(items).toHaveLength(1)
    expect(items[0]?.pulls[0]).toMatchObject({ title: 'Requested change', readiness: { checks: 'passed' } })
    expect(items[0]).toMatchObject({ requestSince: null, ageBasis: 'unknown' })
    delete card.properties['Will action']; delete card.properties['Next action']
    expect(needsWill(buildQueue(snapshot, readiness, now), scene, new Map(), inventory, readiness)).toEqual([])
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
