import { describe, expect, it } from 'vitest'
import { fixtureHomes, fixtureId, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { gapTargets, overviewGroups, entityTone, managerName, rootHome, visibleOverviewCard } from '../overviewModel'
import { applyPresentationAction, initialPresentation, type PresentationState } from '../presentation'

describe('independent Overview stacks', () => {
  it.each(['initiative', 'machine', 'secondMate'] as const)('uses independent unions and explicit cross-group references in %s', arrangement => {
    const scene = fixtureScene(), before = JSON.stringify(scene)
    const groups = overviewGroups(scene, { ...initialPresentation(), arrangement }, Date.now())
    expect(new Set(groups.flatMap(g => g.workers.map(e => e.id))).size).toBe(5)
    expect(new Set(groups.flatMap(g => g.cards.map(c => c.id))).size).toBe(arrangement === 'secondMate' ? 3 : 7)
    if (arrangement !== 'secondMate') expect(groups.some(g => g.cards.length !== g.workers.length)).toBe(true)
    expect(groups.flatMap(g => g.workers).some(e => e.identity.task_id === 'untracked-worker')).toBe(true)
    if (arrangement !== 'secondMate') expect(groups.flatMap(g => g.cards).some(c => c.id === fixtureId(2))).toBe(true)
    if (arrangement !== 'initiative') expect(groups.filter(g => g.cards.some(c => c.id === fixtureId(1)))).toHaveLength(2)
    expect(JSON.stringify(scene)).toBe(before)
  })
  it('retains a worker linked to several cards across initiatives and an unknown host', () => {
    const sources = fixtureSources()
    const worker = sources.fleet[1]!.observation.data!.tasks[0]!
    worker.cardReferences.push({ pageId: fixtureId(5), basis: 'explicit', source: 'task.secondary_page_id' })
    delete sources.fleet[1]!.source.machine
    const scene = new SceneReconciler().reconcile(sources)
    const id = scene.executions.find(e => e.identity.task_id === 'linked-worker')!.id
    const groups = overviewGroups(scene, initialPresentation(), Date.now())
    expect(groups.filter(g => g.workers.some(e => e.id === id))).toHaveLength(2)
    expect(scene.claims.filter(c => c.executionId === id)).toHaveLength(2)
    const machine = overviewGroups(scene, { ...initialPresentation(), arrangement: 'machine' }, Date.now())
    expect(machine.some(g => g.label === 'Unassigned / unknown' && g.workers.some(e => e.id === id))).toBe(true)
    expect(entityTone(scene, 'execution', id, Date.now())).toBe('uncertain')
  })
  it('coordinates activity and priority order with stable ties and no domain writes', () => {
    const sources = fixtureSources()
    const cards = sources.intentions.data!.cards
    cards.find(c => c.id === fixtureId(1))!.properties.Priority = { id: 'p', type: 'select', hasMore: false, value: 'P2' }
    cards.find(c => c.id === fixtureId(3))!.properties.Priority = { id: 'p', type: 'select', hasMore: false, value: 'P0' }
    sources.fleet[1]!.observation.data!.tasks[0]!.last_event.age_seconds = 1
    sources.fleet[1]!.observation.data!.tasks[2]!.last_event.age_seconds = 50
    const scene = new SceneReconciler().reconcile(sources), before = JSON.stringify(scene)
    const activity = overviewGroups(scene, { ...initialPresentation(), sort: 'activity' }, Date.now()).find(g => g.cards.some(c => c.id === fixtureId(1)))!
    expect(activity.cards.findIndex(c => c.id === fixtureId(1))).toBeLessThan(activity.cards.findIndex(c => c.id === fixtureId(3)))
    const priorityState = { ...initialPresentation(), sort: 'priority' } as PresentationState
    const priority = overviewGroups(scene, priorityState, Date.now()).find(g => g.cards.some(c => c.id === fixtureId(1)))!
    expect(priority.workers.findIndex(e => e.identity.task_id === 'candidate-worker')).toBeLessThan(priority.workers.findIndex(e => e.identity.task_id === 'linked-worker'))
    expect(overviewGroups(scene, priorityState, Date.now())).toEqual(overviewGroups(scene, priorityState, Date.now()))
    expect(JSON.stringify(scene)).toBe(before)
  })
  it('never creates orphan coloring by collapsing a counterpart or filtering', () => {
    const scene = fixtureScene()
    const state = applyPresentationAction(initialPresentation(), { type: 'set-expanded', target: { kind: 'manager', id: fixtureHomes[1]! }, expanded: false }, scene).state
    const groups = overviewGroups(scene, state, Date.now())
    expect(groups.flatMap(g => g.cards).some(c => c.id === fixtureId(1))).toBe(true)
    expect(entityTone(scene, 'card', fixtureId(1), Date.now())).toBe('linked')
    expect(gapTargets(scene, Date.now())).toHaveLength(2)
    expect(overviewGroups(scene, { ...state, exceptionsOnly: true }, Date.now()).flatMap(g => g.cards).map(c => c.id)).toEqual([fixtureId(2)])
  })
  it('shows a manager its own cards and does not rename unaffiliated cards to unknown', () => {
    const scene = fixtureScene()
    const groups = overviewGroups(scene, { ...initialPresentation(), arrangement: 'secondMate' }, Date.now())
    expect(groups.some(g => g.label.toLowerCase().includes('unknown'))).toBe(false)
    expect(groups.find(g => g.label === 'hulk')?.cards.map(c => c.id)).toContain(fixtureId(1))
    expect(groups.flatMap(g => g.cards).some(c => c.id === fixtureId(2) || c.id === fixtureId(5))).toBe(false)
  })
  it('leaves archived and unknown cards out of the overview', () => {
    const sources = fixtureSources()
    const cards = sources.intentions.data!.cards
    cards.find(c => c.id === fixtureId(5))!.properties.Status!.value = 'Archived'
    const unknown = cards.find(c => c.id === fixtureId(3))!
    unknown.properties.Status!.value = 'Unknown'
    cards.find(c => c.id === fixtureId(6))!.archived = true
    const scene = new SceneReconciler().reconcile(sources)
    const shown = overviewGroups(scene, initialPresentation(), Date.now()).flatMap(g => g.cards.map(c => c.id))
    expect(shown).not.toContain(fixtureId(5))
    expect(shown).not.toContain(fixtureId(3))
    expect(shown).not.toContain(fixtureId(6))
    expect(shown).toContain(fixtureId(1))
    expect(new Set(shown)).toEqual(new Set(scene.cards.filter(visibleOverviewCard).map(c => c.id)))
  })
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
    expect(overviewGroups(scene, { ...initialPresentation(), arrangement: 'secondMate' }, Date.now()).some(group => group.label === 'hulk')).toBe(true)
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
