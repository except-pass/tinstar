import { describe, expect, it } from 'vitest'
import { SceneSessions, CONNECTED_MS } from '../sessions'
import { applyPresentationAction, initialPresentation } from '../../../shared/reconciliationPresentation'
import { fixtureScene, fixtureQueue } from '../../../../test-fixtures/reconciliation/scenes'

const scene = fixtureScene()
describe('window presentation command protocol', () => {
  it('requires browser acknowledgment, deduplicates retries and isolates windows', () => {
    let now = 1000
    const broker = new SceneSessions(() => now), state = initialPresentation()
    const a = broker.register(state), b = broker.register(state)
    const command = { scene_id: a.scene_id, command_id: 'one', expected_revision: 0, ttl_ms: 8000, action: { type: 'set-arrangement' as const, arrangement: 'machine' as const } }
    expect(broker.enqueue(command, scene).outcome).toBe('queued')
    expect(broker.read(a.scene_id).state?.arrangement).toBe('initiative')
    expect(broker.sync(b.scene_id, state, [])).toEqual([])
    const [received] = broker.sync(a.scene_id, state, [])
    const applied = applyPresentationAction(state, received!.action, scene, now)
    expect(broker.result(a.scene_id, 'one').outcome).toBe('queued')
    broker.sync(a.scene_id, applied.state, [{ scene_id: a.scene_id, command_id: 'one', outcome: 'applied', state: applied.state, revision: 1 }])
    expect(broker.enqueue(command, scene)).toMatchObject({ outcome: 'applied', revision: 1 })
    expect(broker.read(b.scene_id).state?.arrangement).toBe('initiative')
    expect(broker.enqueue({ ...command, action: { type: 'clear-transient' } }, scene).outcome).toBe('conflict')
    now += CONNECTED_MS
    expect(broker.enqueue({ ...command, command_id: 'two', expected_revision: 1 }, scene).outcome).toBe('disconnected')
  })
  it('expires queued commands and rejects stale/unknown identities and forged revision acks', () => {
    let now = 1000
    const broker = new SceneSessions(() => now), state = initialPresentation(), a = broker.register(state)
    const input = { scene_id: a.scene_id, command_id: 'queued', expected_revision: 0, ttl_ms: 500, action: { type: 'set-exceptions' as const, enabled: true } }
    broker.enqueue(input, scene)
    broker.sync(a.scene_id, state, [{ scene_id: a.scene_id, command_id: 'queued', outcome: 'applied', state, revision: 0 }])
    expect(broker.result(a.scene_id, 'queued').outcome).toBe('queued')
    now += 501
    expect(broker.result(a.scene_id, 'queued').outcome).toBe('expired')
    expect(broker.sync(a.scene_id, state, [])).toEqual([])
    expect(broker.enqueue({ ...input, command_id: 'stale', expected_revision: 5 }, scene).outcome).toBe('stale-revision')
    expect(broker.enqueue({ ...input, command_id: 'missing', action: { type: 'focus', target: { kind: 'card', id: 'missing' } } }, scene).outcome).toBe('unknown-id')
    expect(broker.authorized(a.scene_id, 'wrong-key')).toBe(false)
    expect(broker.authorized(a.scene_id, a.key)).toBe(true)
  })
  it('lets manual input win over stale queued focus', () => {
    const broker = new SceneSessions(), state = initialPresentation(), a = broker.register(state)
    const input = { scene_id: a.scene_id, command_id: 'focus', expected_revision: 0, ttl_ms: 8000, action: { type: 'focus' as const, target: { kind: 'card' as const, id: scene.cards[0]!.id } } }
    broker.enqueue(input, scene)
    const [received] = broker.sync(a.scene_id, state, [])
    const clicked = applyPresentationAction(state, { type: 'set-arrangement', arrangement: 'machine' }, scene)
    const stale = applyPresentationAction(clicked.state, received!.action, scene)
    expect(stale.outcome).toBe('stale-revision')
    broker.sync(a.scene_id, stale.state, [{ scene_id: a.scene_id, command_id: 'focus', outcome: stale.outcome, revision: stale.state.revision }])
    expect(broker.result(a.scene_id, 'focus').outcome).toBe('stale-revision')
    expect(broker.read(a.scene_id).state?.selection).toBeNull()
    expect(broker.read(a.scene_id).state?.arrangement).toBe('machine')
  })
})

it('navigates ordered readiness without changing the domain queue and excludes future items', () => {
  const queue = fixtureQueue(), original = JSON.stringify(queue)
  let state = initialPresentation()
  const open = applyPresentationAction(state, { type: 'open-queue' }, scene, Date.now(), queue)
  expect(open.outcome).toBe('applied')
  state = open.state
  expect(state.queueItemId).toBe(queue.items[0]!.id)
  for (let i = 0; i < queue.items.length + 2; i++) state = applyPresentationAction(state, { type: 'navigate-queue', direction: 'next' }, scene, Date.now(), queue).state
  expect(queue.items.find(item => item.id === state.queueItemId)!.readiness).not.toBe('future-or-conditional')
  expect(JSON.stringify(queue)).toBe(original)
  expect(applyPresentationAction(state, { type: 'navigate-queue', direction: 'next' }, scene).outcome).toBe('queue-source-unavailable')
  const unavailable = applyPresentationAction({ ...state, queueItemId: 'answered' }, { type: 'navigate-queue', direction: 'next' }, scene, Date.now(), queue)
  expect(unavailable.outcome).toBe('unknown-id')
})

it('retains a browser commit made before expiry when its acknowledgment arrives later', () => {
  let now = 1000
  const broker = new SceneSessions(() => now), state = initialPresentation(), a = broker.register(state)
  const action = { type: 'set-arrangement' as const, arrangement: 'machine' as const }
  broker.enqueue({ scene_id: a.scene_id, command_id: 'short', expected_revision: 0, ttl_ms: 500, action }, scene)
  const applied = applyPresentationAction(state, action, scene, 1200).state
  now = 1600
  expect(broker.result(a.scene_id, 'short').outcome).toBe('expired')
  broker.sync(a.scene_id, applied, [{ scene_id: a.scene_id, command_id: 'short', outcome: 'applied', applied_at: 1200, state: applied, revision: 1 }])
  expect(broker.result(a.scene_id, 'short').outcome).toBe('applied')
})
