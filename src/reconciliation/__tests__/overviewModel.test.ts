import { describe, expect, it } from 'vitest'
import { fixtureHomes, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { gapTargets, overviewGroups, managerName, rootHome, workerState } from '../overviewModel'
import { initialPresentation } from '../presentation'

describe('independent Overview stacks', () => {
  it('keeps published final reports in history when the source expires', () => {
    const now = Date.now(), sources = fixtureSources({ now })
    sources.fleet[1]!.observation.data!.tasks[0]!.lastEventText = 'done [at=1]: Finished attempt'
    const scene = new SceneReconciler().reconcile(sources, now + 61_000)
    const groups = overviewGroups(scene, initialPresentation(), now + 61_000)
    expect(groups.flatMap(g => g.workers).some(e => e.identity.task_id === 'linked-worker')).toBe(false)
    expect(scene.executions.some(e => e.identity.task_id === 'linked-worker')).toBe(true)
  })
  it('uses configured labels and treats the configured root as First Mate', () => {
    const scene = fixtureScene()
    scene.coverage.homes[0]!.source.label = 'main'
    scene.coverage.homes[1]!.source.label = 'hulk'
    expect(managerName(scene, fixtureHomes[1]!)).toBe('hulk')
    expect(managerName(scene, '/some/fm-kdf')).toBe('kdf')
    expect(rootHome(scene)?.source.label).toBe('main')
    expect(overviewGroups(scene, { ...initialPresentation(), organizer: { outer: 'manager', inner: 'none', order: 'checkIn', direction: 'asc' } }, Date.now()).some(group => group.label === 'hulk')).toBe(true)
  })
  it('suppresses gaps on expired, missing-ID and partial coverage scenes', () => {
    const now = Date.now(), scene = fixtureScene({ now })
    expect(gapTargets(scene, now + 61_000)).toEqual([])
    expect(gapTargets(scene, now, true)).toEqual([])
    const sources = fixtureSources({ now })
    sources.fleet[1]!.observation.data!.tasks[0]!.identity.spawn_gen = null
    expect(gapTargets(new SceneReconciler().reconcile(sources, now), now)).toEqual([])
    expect(gapTargets(fixtureScene({ now, unavailable: true }), now)).toEqual([])
  })
})

it('navigates a canonical Desk task without changing queue position or saved filters', async () => {
  const { applyPresentationAction, semanticId } = await import('../presentation')
  const { organizedGroups } = await import('../../shared/floorOrganization')
  const now = Date.now(), scene = fixtureScene({ now })
  const card = scene.cards.find(c => c.source.properties.Name?.value === 'Build live reconciliation')!
  const organizer = { outer: 'machine' as const, inner: 'status' as const, order: 'checkIn' as const, direction: 'asc' as const }
  const state = { ...initialPresentation(), organizer, statusFilter: { preset: 'custom' as const, statuses: ['Waiting For'] }, queueItemId: 'retain-this-item' }
  const groups = organizedGroups(scene, { ...state, statusFilter: { preset: 'all', statuses: [] } }, now).filter(g => g.cardIds.includes(card.id))
  state.collapsed = groups.flatMap(g => [g.id, g.outerId]).map(id => semanticId({ kind: 'group', id }))
  const before = structuredClone(state)
  const result = applyPresentationAction(state, { type: 'navigate-card', cardId: card.id }, scene, now)
  expect(result.outcome).toBe('applied')
  expect(result.state.selection).toBeNull()
  expect(result.state.queueItemId).toBe(state.queueItemId)
  expect(result.state.statusFilter).toEqual(state.statusFilter)
  expect(result.state.organizer).toEqual(organizer)
  expect(result.state.collapsed).toEqual([])
  expect(organizedGroups(scene, result.state, now).filter(g => g.cardIds.includes(card.id))).toHaveLength(2)
  expect(result.state.navigation?.cardId).toBe(card.id)
  expect(state).toEqual(before)
  expect(applyPresentationAction(state, { type: 'navigate-card', cardId: 'missing' }, scene, now)).toEqual({ outcome: 'unknown-id', state })
})


it('retains event precedence across expiry and shares status with grouping', () => {
  const now = Date.now(), sources = fixtureSources({ now })
  const task = sources.fleet[1]!.observation.data!.tasks[0]!
  task.current_state.state = 'working'
  task.lastEventText = 'paused: Awaiting input'
  const reconciler = new SceneReconciler()
  for (const time of [now, now + 61_000]) {
    const scene = reconciler.reconcile(sources, time)
    const worker = scene.executions.find(e => e.identity.task_id === task.identity.task_id)!
    expect(workerState(worker)).toBe('Waiting')
    const groups = overviewGroups(scene, { ...initialPresentation(), organizer: { outer: 'workerStatus', inner: 'none', order: 'checkIn', direction: 'asc' } }, time)
    expect(groups.find(g => g.executionIds.includes(worker.id))?.label).toBe('Waiting')
  }
})

it('distinguishes dead endpoints from completed reports', () => {
  const now = Date.now(), sources = fixtureSources({ now })
  const task = sources.fleet[1]!.observation.data!.tasks[0]!
  task.endpoint.exists = false
  task.lastEventText = 'working: Still working'
  const reconciler = new SceneReconciler()
  const status = (time: number) => workerState(reconciler.reconcile(sources, time).executions.find(e => e.identity.task_id === task.identity.task_id)!)
  expect(status(now)).toBe('Unknown')
  expect(status(now + 61_000)).toBe('Unknown')
  task.lastEventText = 'done: Completed'
  expect(status(now)).toBe('Finished')
  expect(status(now + 61_000)).toBe('Finished')
})
