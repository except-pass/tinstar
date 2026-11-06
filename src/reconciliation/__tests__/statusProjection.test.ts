import { afterEach, describe, expect, it } from 'vitest'
import { fixtureId, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { organizerPresets, organizedGroups, statusProjection } from '../../shared/floorOrganization'
import { cardStatusOrder, compareStatus, floorWorkerStatus, type DonutFilter } from '../../shared/floorStatus'
import { applyPresentationAction, initialPresentation, type FloorScene } from '../presentation'
import { loadPresentationPreferences, savePresentationPreferences } from '../presentationPreferences'
import { entityTone, overviewGroups, expandedRelationships } from '../overviewModel'
import { actionSchema, stateSchema } from '../../shared/reconciliationCommands'

const now = Date.parse('2026-11-04T17:00:00Z')
function fanout() {
  const scene = fixtureScene({ now })
  const link = scene.claims.find(c => c.cardId === fixtureId(1))!
  scene.claims.push({ ...link, id: 'fanout', cardId: fixtureId(6) }, { ...link, id: 'duplicate' })
  return scene
}
const ids = (values: { id: string }[]) => values.map(v => v.id).sort()
const worker = (scene: FloorScene, task: string) => scene.executions.find(w => w.identity.task_id === task)!
function project(scene: FloorScene, filter: DonutFilter) {
  const state = applyPresentationAction(initialPresentation(), { type: 'set-donut-filter', filter }, scene, now).state
  return { state, ...statusProjection(scene, state, now) }
}

afterEach(() => localStorage.clear())
describe('canonical relationship-aware status projection', () => {
  it('keeps Operational independent endpoints and existing hidden-task semantics without selections', () => {
    const scene = fanout(), p = project(scene, { cards: [], workers: [] })
    expect(p.cards).toHaveLength(5)
    expect(p.workers).toHaveLength(5)
    expect(p.workerCandidates).toHaveLength(5)
    expect(p.workers).toContain(worker(scene, 'untracked-worker'))
    scene.cards.find(c => c.id === fixtureId(1))!.source.properties.Status!.value = 'Backlog'
    expect(project(scene, { cards: [], workers: [] }).workers).toHaveLength(5)
  })
  it('ORs card selections and retains selected independent cards, using only real linked workers', () => {
    const scene = fanout(), p = project(scene, { cards: ['In Progress', 'Waiting For'], workers: [] })
    expect(ids(p.cards)).toEqual([1, 2, 3, 4, 6].map(fixtureId).sort())
    expect(ids(p.workers)).toEqual(['linked-worker', 'helper-worker', 'blocked-worker'].map(task => worker(scene, task).id).sort())
    expect(p.cardCandidates).toHaveLength(5)
    expect(p.workerCandidates).toHaveLength(3)
    const single = project(scene, { cards: ['Waiting For'], workers: [] })
    expect(ids(single.cards)).toEqual([fixtureId(4)])
    expect(ids(single.workers)).toEqual([worker(scene, 'blocked-worker').id])
    expect(single.cardCandidates).toHaveLength(5) // own donut never locks out
  })
  it('ORs worker states, deduplicates fan-out, and keeps matching independent workers', () => {
    const scene = fanout(), p = project(scene, { cards: [], workers: ['Running'] })
    expect(p.workers).toHaveLength(4)
    expect(ids(p.cards)).toEqual([fixtureId(1), fixtureId(6)])
    expect(p.cardCandidates).toHaveLength(2)
    expect(p.workerCandidates).toHaveLength(5)
    const multi = project(scene, { cards: [], workers: ['Running', 'Blocked'] })
    expect(multi.workers).toHaveLength(5)
    expect(ids(multi.cards)).toEqual([1, 4, 6].map(fixtureId).sort())
  })
  it('ANDs both donuts over edges and removes matching unrelated orphan endpoints', () => {
    const scene = fanout(), p = project(scene, { cards: ['In Progress'], workers: ['Running'] })
    expect(ids(p.workers)).toEqual(['linked-worker', 'helper-worker'].map(task => worker(scene, task).id).sort())
    expect(ids(p.cards)).toEqual([fixtureId(1), fixtureId(6)])
    expect(p.cardCandidates).toHaveLength(2)
    expect(p.workerCandidates).toHaveLength(2)
    const none = project(scene, { cards: ['Waiting For'], workers: ['Running'] })
    expect(none.workers).toEqual([]); expect(none.cards).toEqual([])
    expect(none.workerCandidates.map(floorWorkerStatus)).toEqual(['Blocked'])
    expect(none.cardCandidates).toHaveLength(2)
  })
  it('does not promote candidate, historical, unknown-endpoint or conflicting claims', () => {
    const scene = fanout(), before = JSON.stringify(scene)
    const link = scene.claims[0]!, candidate = worker(scene, 'candidate-worker')
    scene.claims.push({ ...link, id: 'candidate', verification: 'unverified', cardId: fixtureId(4), executionId: candidate.id })
    scene.claims.push({ ...link, id: 'old', state: 'historical', cardId: fixtureId(4), executionId: candidate.id })
    scene.claims.push({ ...link, id: 'missing', cardId: fixtureId(4), executionId: 'unobserved-worker' })
    const source = JSON.stringify(scene), p = project(scene, { cards: ['Waiting For'], workers: [] })
    expect(ids(p.workers)).toEqual([worker(scene, 'blocked-worker').id])
    expect(JSON.stringify(scene)).toBe(source)
    expect(before).not.toBe(source)
  })
  it('composes base scope, reveals only the navigation anchor through explicit filtering, and preserves the prior base', () => {
    const scene = fanout(), base = { ...initialPresentation(), statusFilter: { preset: 'custom' as const, statuses: ['Waiting For'] }, exceptionsOnly: false, linksVisible: false }
    let state = applyPresentationAction(base, { type: 'set-donut-filter', filter: { cards: [], workers: ['Running'] } }, scene, now).state
    expect(statusProjection(scene, state, now).cards).toEqual([])
    expect(overviewGroups(scene, state, now, false, expandedRelationships(scene, [{ kind: 'execution', id: worker(scene, 'linked-worker').id }])).flatMap(g => g.cards)).toEqual([])
    state = applyPresentationAction(state, { type: 'navigate-card', cardId: fixtureId(1) }, scene, now).state
    expect(ids(statusProjection(scene, state, now).cards)).toEqual([fixtureId(1)])
    expect([...new Set(ids(overviewGroups(scene, state, now, false, expandedRelationships(scene, [{ kind: 'execution', id: worker(scene, 'linked-worker').id }])).flatMap(g => g.cards)))]).toEqual([fixtureId(1)])
    expect(state.donutFilter).toEqual({ cards: [], workers: ['Running'] })
    expect(state.statusFilter).toEqual(base.statusFilter)
    const clear = applyPresentationAction(state, { type: 'clear-donut-filter' }, scene, now).state
    expect(clear.organizer).toEqual(base.organizer)
    expect(clear.statusFilter).toEqual(base.statusFilter)
    expect(clear.linksVisible).toBe(false)
    expect(statusProjection(scene, clear, now).workers).toHaveLength(5)
  })
  it('keeps live counts truthful across source changes, empty reads and unavailable coverage without inventing gaps', () => {
    const scene = fanout(), selected = project(scene, { cards: ['In Progress'], workers: ['Running'] })
    const tones = scene.cards.map(c => entityTone(scene, 'card', c.id, now))
    for (const home of scene.coverage.homes) home.observation.status = 'stale'
    expect(statusProjection(scene, selected.state, now).cards).toHaveLength(2)
    expect(scene.cards.map(c => entityTone(scene, 'card', c.id, now))).not.toContain('gap')
    expect(tones).toContain('gap')
    scene.cards.find(c => c.id === fixtureId(1))!.source.properties.Status!.value = 'Waiting For'
    expect(ids(statusProjection(scene, selected.state, now).cards)).toEqual([fixtureId(6)])
    scene.executions = []
    expect(statusProjection(scene, selected.state, now).cards).toEqual([])
  })
  it('preserves canonical memberships in every applicable machine group while counting each endpoint once', () => {
    const scene = fanout(), p = project(scene, { cards: ['In Progress'], workers: ['Running'] })
    const groups = organizedGroups(scene, { ...p.state, organizer: { ...organizerPresets.machine } }, now)
    expect(groups.filter(g => g.cardIds.includes(fixtureId(1))).map(g => g.outerLabel).sort()).toEqual(['Bandit', 'Hulk'])
    expect(groups.flatMap(g => g.cards)).toHaveLength(3)
    expect(new Set(groups.flatMap(g => g.cards.map(c => c.id))).size).toBe(2)
  })
  it('persists selections and custom organizer through the existing state schema and browser preferences', () => {
    const scene = fanout(), action = actionSchema.parse({ type: 'set-donut-filter', filter: { cards: ['In Progress'], workers: ['Running'] } })
    const state = applyPresentationAction({ ...initialPresentation(), organizer: { ...organizerPresets.manager, direction: 'desc' } }, action, scene, now).state
    expect(stateSchema.safeParse(state).success).toBe(true)
    savePresentationPreferences({ ...state, selection: { kind: 'card', id: fixtureId(1) } })
    const restored = loadPresentationPreferences()
    expect(restored.donutFilter).toEqual(state.donutFilter)
    expect(restored.organizer).toEqual(state.organizer)
    expect(restored.selection).toBeNull()
    expect(ids(statusProjection(scene, restored, now).cards)).toEqual([fixtureId(1), fixtureId(6)])
  })
})

describe('organizer presets and operational ordering', () => {
  it('applies only organizer slots and preserves filters and unrelated view settings', () => {
    const scene = fanout(), base = { ...initialPresentation(), donutFilter: { cards: ['Waiting For'], workers: [] }, linksVisible: false, exceptionsOnly: true }
    for (const organizer of Object.values(organizerPresets)) {
      const state = applyPresentationAction(base, { type: 'set-organizer', organizer }, scene, now).state
      expect(state.organizer).toEqual(organizer)
      expect(state.statusFilter).toEqual(base.statusFilter)
      expect(state.donutFilter).toEqual(base.donutFilter)
      expect(state.linksVisible).toBe(false); expect(state.exceptionsOnly).toBe(true)
    }
  })
  it('orders every board option deterministically, with unfamiliar options alphabetical and unknown last', () => {
    const all = [...cardStatusOrder, 'New board option B', '', 'New board option A', 'Status unknown']
    expect([...all].reverse().sort((a, b) => compareStatus(a, b, 'cards'))).toEqual([...cardStatusOrder, 'New board option A', 'New board option B', '', 'Status unknown'])
    const scene = fanout()
    scene.cards = all.map((status, index) => ({ ...scene.cards[0]!, id: fixtureId(200 + index), source: { ...scene.cards[0]!.source, properties: { ...scene.cards[0]!.source.properties, Status: { ...scene.cards[0]!.source.properties.Status!, value: status } } } }))
    const groups = organizedGroups(scene, { ...initialPresentation(), organizer: { outer: 'none', inner: 'none', order: 'operational', direction: 'asc' }, statusFilter: { preset: 'all', statuses: [] } }, now)
    expect(groups[0]!.cards.map(c => c.source.properties.Status!.value)).toEqual([...cardStatusOrder, 'New board option A', 'New board option B', '', 'Status unknown'])
  })
  it('uses worker urgency and check-in/name/id ties, and actual configured manager ancestry', () => {
    const scene = fanout()
    const grouped = organizedGroups(scene, { ...initialPresentation(), organizer: { outer: 'none', inner: 'none', order: 'operational', direction: 'asc' } }, now)[0]!
    expect(grouped.workers[0]!.identity.task_id).toBe('blocked-worker')
    // Rename the actual parent after its children alphabetically. Hierarchy wins.
    scene.coverage.homes[0]!.source.label = 'Z First Mate'
    scene.coverage.homes[1]!.source.label = 'A Second Mate'
    const w = worker(scene, 'candidate-worker'); w.home = scene.coverage.homes[0]!.source.home
    const groups = organizedGroups(scene, { ...initialPresentation(), organizer: { ...organizerPresets.manager } }, now)
    expect(groups[0]!.outerLabel).toBe('Z First Mate')
    expect(groups.at(-1)!.outerLabel).toBe('Unassigned / Unknown')
    const initiative = organizedGroups(scene, { ...initialPresentation(), organizer: { ...organizerPresets.initiative } }, now)
    expect(initiative.findIndex(g => g.innerLabel === 'A Second Mate')).toBeLessThan(initiative.findIndex(g => g.innerLabel === 'Z First Mate'))
    const first = scene.cards.find(c => c.id === fixtureId(1))!, sixth = scene.cards.find(c => c.id === fixtureId(6))!
    first.source.properties.Name!.value = 'Z task'; sixth.source.properties.Name!.value = 'A task'
    sixth.source.properties['Next check-in'] = { id: 'check', type: 'date', value: { start: '2026-11-05' }, hasMore: false }
    first.source.properties['Next check-in'] = { id: 'check', type: 'date', value: { start: '2026-11-04' }, hasMore: false }
    const ordered = organizedGroups(scene, { ...initialPresentation(), organizer: { outer: 'none', inner: 'none', order: 'operational', direction: 'asc' } }, now)[0]!.cards
    expect(ordered.indexOf(first)).toBeLessThan(ordered.indexOf(sixth))
  })
})
