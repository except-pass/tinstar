import { describe, expect, it } from 'vitest'
import { fixtureHomes, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { expandedRelationships, gapTargets, overviewGroups, managerName, relevantWorkerHomes, rootHome, workerAbsenceLabel, workerSourceCoverage, workerState, workerSummary } from '../overviewModel'
import { applyPresentationAction, initialPresentation } from '../presentation'

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
  it('treats one stale or partial home as partial coverage and all-unreadable homes as unavailable', () => {
    const now = Date.now(), scene = fixtureScene({ now })
    expect(workerSourceCoverage(scene.coverage.homes, now)).toBe('available')
    expect(workerSummary(scene.coverage.homes, now, false, 4)).toBe('4 workers')
    expect(workerAbsenceLabel('available', 'gutter')).toBe('no worker')
    scene.coverage.homes[0]!.observation.coverage = 'partial'
    expect(workerSourceCoverage(scene.coverage.homes, now)).toBe('partial')
    expect(workerSummary(scene.coverage.homes, now, false, 4, 4, true)).toBe('4 W')
    expect(workerSummary(scene.coverage.homes, now, false, 0)).toBe('Unknown workers')
    expect(workerAbsenceLabel('partial', 'column')).toBe('Unknown worker')
    expect(workerAbsenceLabel('partial', 'gutter')).toBe('unknown worker')
    scene.coverage.homes[0]!.observation.status = 'stale'
    expect(workerSourceCoverage(scene.coverage.homes, now)).toBe('partial')
    for (const home of scene.coverage.homes) Object.assign(home.observation, { status: 'unknown', coverage: 'unknown' })
    expect(workerSourceCoverage(scene.coverage.homes, now)).toBe('unavailable')
    expect(workerSummary(scene.coverage.homes, now, false, 0)).toBe('Workers unavailable')
    expect(workerSummary(scene.coverage.homes, now, false, 2)).toBe('2 last known workers')
    expect(workerSummary(scene.coverage.homes, now, true, 2)).toBe('2 last known workers')
    const hulk = relevantWorkerHomes(scene, { outer: 'manager', inner: 'none' }, { outerLabel: 'hulk', label: 'hulk' })
    expect(hulk.map(home => home.source.home)).toEqual([fixtureHomes[1]])
    expect(relevantWorkerHomes(scene, { outer: 'manager', inner: 'none' }, { outerLabel: 'Unassigned / Unknown', label: 'Unassigned' })).toHaveLength(scene.coverage.homes.length)
    expect(relevantWorkerHomes(scene, { outer: 'initiative', inner: 'status' }, { outerLabel: 'Unassigned / Unknown', label: 'In Progress' })).toBe(scene.coverage.homes)
    expect(relevantWorkerHomes(scene, { outer: 'none', inner: 'none' }, { outerLabel: 'All work', label: 'All work' })).toBe(scene.coverage.homes)
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


it('uses recorded crew-state over historical intent and withdraws it on expiry', () => {
  const now = Date.now(), sources = fixtureSources({ now })
  const task = sources.fleet[1]!.observation.data!.tasks[0]!
  task.current_state.state = 'working'
  task.lastEventText = 'paused: Awaiting input'
  const reconciler = new SceneReconciler()
  for (const time of [now, now + 61_000]) {
    const scene = reconciler.reconcile(sources, time)
    const worker = scene.executions.find(e => e.identity.task_id === task.identity.task_id)!
    expect(workerState(worker)).toBe(time === now ? 'Running' : 'No update')
    const groups = overviewGroups(scene, { ...initialPresentation(), organizer: { outer: 'workerStatus', inner: 'none', order: 'checkIn', direction: 'asc' } }, time)
    expect(groups.find(g => g.executionIds.includes(worker.id))?.label).toBe(time === now ? 'Running' : 'No update')
  }
})

it('distinguishes dead endpoints from completed reports', () => {
  const now = Date.now(), sources = fixtureSources({ now })
  const task = sources.fleet[1]!.observation.data!.tasks[0]!
  task.endpoint.exists = false
  task.lastEventText = 'working: Still working'
  const reconciler = new SceneReconciler()
  const status = (time: number) => workerState(reconciler.reconcile(sources, time).executions.find(e => e.identity.task_id === task.identity.task_id)!)
  expect(status(now)).toBe('No update')
  expect(status(now + 61_000)).toBe('No update')
  task.lastEventText = 'done: Completed'
  task.current_state.state = 'done'
  expect(status(now)).toBe('Finished')
  expect(status(now + 61_000)).toBe('Finished')
})


it.each([
  ['blocked', 'paused: Awaiting input', 'Blocked'],
  ['working', 'blocked: Needs intervention', 'Running'],
  ['blocked', 'working: Resumed', 'Blocked'],
  ['blocked', 'resolved: Cleared', 'Blocked'],
  ['blocked', 'unrecognized: Latest note', 'Blocked'],
])('uses effective status for state %s and event %s', (state, event, expected) => {
  const now = Date.now(), sources = fixtureSources({ now })
  const task = sources.fleet[1]!.observation.data!.tasks[0]!
  task.current_state.state = state
  task.lastEventText = event
  for (const time of [now, now + 61_000]) {
    const scene = new SceneReconciler().reconcile(sources, time)
    const worker = scene.executions.find(e => e.identity.task_id === task.identity.task_id)!
    expect(workerState(worker)).toBe(time === now ? expected : 'No update')
    const groups = overviewGroups(scene, { ...initialPresentation(), organizer: { outer: 'workerStatus', inner: 'none', order: 'workerStatus', direction: 'asc' } }, time)
    expect(groups.find(g => g.executionIds.includes(worker.id))?.label).toBe(time === now ? expected : 'No update')
  }
})

it('expires generic flash reveals while retaining selection and Desk navigation', async () => {
  const { applyPresentationAction } = await import('../presentation')
  const { organizedGroups } = await import('../../shared/floorOrganization')
  const now = Date.now(), scene = fixtureScene({ now })
  const card = scene.cards.find(c => c.source.properties.Name?.value === 'Build live reconciliation')!
  const state = { ...initialPresentation(), statusFilter: { preset: 'custom' as const, statuses: [] } }
  const flashed = applyPresentationAction(state, { type: 'flash', targets: [{ kind: 'card', id: card.id }], durationMs: 1000 }, scene, now)
  const visible = (presentation: Parameters<typeof organizedGroups>[1], time: number) => organizedGroups(scene, presentation, time).some(group => group.cardIds.includes(card.id))
  expect(visible(state, now)).toBe(false)
  expect(visible(flashed.state, now + 999)).toBe(true)
  expect(visible(flashed.state, now + 1000)).toBe(false)
  expect(visible(flashed.state, now + 2000)).toBe(false)
  const navigated = applyPresentationAction(state, { type: 'navigate-card', cardId: card.id }, scene, now)
  expect(visible(navigated.state, now + 5000)).toBe(true)
  expect(navigated.state.navigation?.cardId).toBe(card.id)
  expect(visible({ ...flashed.state, selection: { kind: 'card', id: card.id } }, now + 5000)).toBe(true)
  expect(flashed.state.statusFilter).toEqual(state.statusFilter)
  expect(navigated.state.statusFilter).toEqual(state.statusFilter)
})


it.each(['outer', 'inner'] as const)('follows remote worker publishers for the %s machine axis', axis => {
  const now = Date.now(), sources = fixtureSources({ now })
  sources.fleet[1]!.observation.data!.tasks.forEach(task => { task.remote = { host: 'Bandit' } as NonNullable<typeof task.remote> })
  sources.fleet[2]!.observation.data!.tasks = []
  const reconciler = new SceneReconciler()
  const organizer = { outer: axis === 'outer' ? 'machine' : 'initiative', inner: axis === 'inner' ? 'machine' : 'none' }
  const group = { outerLabel: axis === 'outer' ? 'Bandit' : 'Reconciliation initiative', label: 'Bandit' }
  const summary = () => {
    const scene = reconciler.reconcile(sources, now)
    const homes = relevantWorkerHomes(scene, organizer, group)
    expect(homes.map(home => home.source.home)).toEqual([fixtureHomes[1]])
    expect(relevantWorkerHomes(scene, { outer: 'manager', inner: 'none' }, { outerLabel: 'bandit', label: 'bandit' }).map(home => home.source.home)).toEqual([fixtureHomes[2]])
    return workerSummary(homes, now, false, 4)
  }
  sources.fleet[2]!.observation.status = 'stale'
  expect(summary()).toBe('4 workers')
  sources.fleet[1]!.observation.status = 'stale'
  sources.fleet[2]!.observation.status = 'fresh'
  expect(summary()).toBe('4 last known workers')
  sources.fleet[1]!.observation.status = 'fresh'
  expect(summary()).toBe('4 workers')
  sources.fleet[2]!.observation.data!.tasks = [structuredClone(sources.fleet[1]!.observation.data!.tasks[0]!)]
  const task = sources.fleet[2]!.observation.data!.tasks[0]!
  task.identity = { ...task.identity, fm_home: fixtureHomes[2]! }
  sources.fleet[2]!.observation.status = 'stale'
  const homes = relevantWorkerHomes(reconciler.reconcile(sources, now), organizer, group)
  expect(homes.map(home => home.source.home)).toEqual([fixtureHomes[1], fixtureHomes[2]])
  expect(workerSourceCoverage(homes, now)).toBe('partial')
})


it.each(['machine', 'manager'] as const)('preserves %s outer aggregate coverage after focus', async outer => {
  const { organizedGroups, resolveFloorGroup } = await import('../../shared/floorOrganization')
  const { applyPresentationAction } = await import('../presentation')
  const now = Date.now(), scene = fixtureScene({ now })
  scene.executions = scene.executions.filter(worker => worker.home === fixtureHomes[1])
  scene.executions.forEach(worker => { worker.placement.machine = 'Bandit' })
  scene.coverage.homes[1]!.observation.status = 'stale'
  const state = { ...initialPresentation(), organizer: { outer, inner: 'status' as const, order: 'checkIn' as const, direction: 'asc' as const } }
  const child = organizedGroups(scene, state, now).find(group => group.workers.length)!
  const focused = applyPresentationAction(state, { type: 'focus', target: { kind: 'group', id: child.outerId } }, scene, now)
  expect(focused.outcome).toBe('applied')
  const aggregate = resolveFloorGroup(scene, focused.state, child.outerId, now)!
  const inspectorHomes = relevantWorkerHomes(scene, state.organizer, aggregate)
  const headerHomes = relevantWorkerHomes(scene, state.organizer, { label: child.outerLabel })
  expect(inspectorHomes.map(home => home.source.home)).toEqual([fixtureHomes[1]])
  expect(inspectorHomes).toEqual(headerHomes)
  expect(workerSummary(inspectorHomes, now, false, aggregate.executionIds.length)).toBe(`${aggregate.executionIds.length} last known workers`)
  scene.coverage.homes[1]!.observation.status = 'fresh'
  expect(workerSourceCoverage(relevantWorkerHomes(scene, state.organizer, aggregate), now)).toBe('available')
})

it('does not revive an expired unrelated Backlog flash when opening a relationship', () => {
  const now = Date.now(), scene = fixtureScene({ now })
  const backlog = scene.cards.find(c => c.source.properties.Status?.value === 'Backlog')!
  const worker = scene.executions.find(w => w.identity.task_id === 'linked-worker')!
  const linkedCard = scene.claims.find(c => c.executionId === worker.id && c.verification === 'confirmed')!.cardId
  scene.cards.find(c => c.id === linkedCard)!.source.properties.Status!.value = 'Backlog'
  const state = { ...initialPresentation(), flash: { ids: [`card:${backlog.id}`], until: now + 1000 } }
  const revealed = expandedRelationships(scene, [{ kind: 'execution', id: worker.id }])
  const cardsAt = (time: number) => overviewGroups(scene, state, time, false, revealed).flatMap(g => g.cardIds)
  expect(cardsAt(now + 999)).toContain(backlog.id)
  for (const time of [now + 1000, now + 2000]) {
    expect(cardsAt(time)).not.toContain(backlog.id)
    expect(cardsAt(time)).toContain(linkedCard)
  }
  expect(overviewGroups(scene, state, now + 2000).flatMap(g => g.cardIds)).not.toContain(linkedCard)
  expect(state.flash).toEqual({ ids: [`card:${backlog.id}`], until: now + 1000 })
  expect(state.statusFilter?.preset ?? 'operational').toBe('operational')
})


it('preserves an assistant flash through compact relationship expansion and a donut filter', () => {
  const now = Date.now(), scene = fixtureScene({ now })
  const a = scene.cards.find(card => card.source.properties.Status?.value === 'In Progress')!
  const b = scene.cards.find(card => card.source.properties.Status?.value === 'Backlog')!
  const state = { ...initialPresentation(), donutFilter: { cards: ['In Progress'], workers: [] } }
  const expanded = expandedRelationships(scene, [{ kind: 'card', id: a.id }])
  expect(overviewGroups(scene, state, now, false, expanded).flatMap(group => group.cardIds)).not.toContain(b.id)
  const flashed = applyPresentationAction(state, { type: 'flash', targets: [{ kind: 'card', id: b.id }], origin: 'assistant' }, scene, now)
  expect(flashed.outcome).toBe('applied')
  expect(overviewGroups(scene, flashed.state, now, false, expanded).flatMap(group => group.cardIds)).toContain(b.id)
  expect(overviewGroups(scene, flashed.state, now + 5000, false, expanded).flatMap(group => group.cardIds)).not.toContain(b.id)
  expect(flashed.state.donutFilter).toEqual(state.donutFilter)
  expect(expanded).toEqual(expandedRelationships(scene, [{ kind: 'card', id: a.id }]))
})
