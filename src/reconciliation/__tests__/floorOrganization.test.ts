import { describe, expect, it } from 'vitest'
import { fixtureId, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { notionObservation } from '../../server/reconciliation/notion'
import { resolveFloorGroup } from '../../shared/floorOrganization'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { dateBucket, dateTimestamp, defaultOrganizer, organizedGroups, type Organizer } from '../../shared/floorOrganization'
import { actionSchema, stateSchema } from '../../shared/reconciliationCommands'
import { applyPresentationAction, initialPresentation, semanticId } from '../presentation'
import { workBreadcrumb, workerBreadcrumb } from '../recordFields'
import { entityTone, overviewGroups } from '../overviewModel'
import { loadPresentationPreferences, preferencesKey, savePresentationPreferences } from '../presentationPreferences'

const now = Date.parse('2026-11-04T17:00:00Z')
const stateFor = (organizer: Partial<Organizer> = {}) => ({ ...initialPresentation(), organizer: { ...defaultOrganizer(), ...organizer } })
describe('shared organization of independent endpoints', () => {
  it.each(['initiative', 'epic'] as const)('uses only explicit %s properties from Notion', async field => {
    const name = field === 'initiative' ? 'Initiative' : 'Epic'
    for (const property of [undefined,
      { type: 'relation', relation: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }] },
      { type: 'select', select: { name: 'Delivery' } },
      { type: 'rich_text', rich_text: [{ plain_text: 'Delivery' }] },
    ]) {
      const fetcher = (async (_url, init) => new Response(JSON.stringify(init?.method === 'POST'
        ? { results: [{ object: 'page', id: fixtureId(1), last_edited_time: new Date(now).toISOString(), properties: property ? { [name]: property } : {} }], has_more: false }
        : { object: 'data_source', properties: {} }))) as typeof fetch
      const observation = await notionObservation({ token: 'fixture', dataSourceId: fixtureId(1) }, fetcher).get()
      const scene = fixtureScene({ now })
      const card = scene.cards.find(c => c.id === fixtureId(1))!
      Object.assign(card.source.properties, observation.data!.cards[0]!.properties)
      const organizer = { ...defaultOrganizer(), outer: field, order: field }
      expect(actionSchema.safeParse({ type: 'set-organizer', organizer }).success).toBe(true)
      const groups = organizedGroups(scene, { ...initialPresentation(), organizer }, now)
      expect(groups.filter(g => g.cardIds.includes(card.id)).map(g => g.label).sort()).toEqual(
        !property ? ['Unassigned / Unknown'] : property.type === 'relation'
          ? ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] : ['Delivery'])
      if (!property) expect(groups).toHaveLength(1)
    }
  })
  it('reads select Initiative/Epic into groups and confirmed linked-worker breadcrumbs', async () => {
    const fetcher = (async (_url, init) => new Response(JSON.stringify(init?.method === 'POST'
      ? { results: [{ object: 'page', id: fixtureId(1), last_edited_time: new Date(now).toISOString(), properties: {
        Initiative: { type: 'select', select: { name: 'Cloud Platform' } },
        Epic: { type: 'select', select: { name: 'Observability' } },
      } }], has_more: false }
      : { object: 'data_source', properties: { Initiative: { type: 'select' }, Epic: { type: 'select' } } }))) as typeof fetch
    const observation = await notionObservation({ token: 'fixture', dataSourceId: fixtureId(1) }, fetcher).get()
    const scene = fixtureScene({ now }), card = scene.cards.find(c => c.id === fixtureId(1))!
    Object.assign(card.source.properties, observation.data!.cards[0]!.properties)
    const group = organizedGroups(scene, stateFor({ outer: 'initiative', inner: 'status' }), now).find(g => g.cardIds.includes(card.id))!
    expect(group.outerLabel).toBe('Cloud Platform')
    expect(workBreadcrumb(scene, card)).toBe('Cloud Platform / Observability')
    const claim = scene.claims.find(c => c.cardId === card.id && c.verification === 'confirmed')!
    const worker = scene.executions.find(w => w.id === claim.executionId)!
    expect(workerBreadcrumb(scene, worker)).toBe('Cloud Platform / Observability')
    claim.verification = 'unverified'
    expect(workerBreadcrumb(scene, worker)).toBe('')
    delete card.source.properties.Initiative
    delete card.source.properties.Epic
    expect(workBreadcrumb(scene, card)).toBe('Unassigned')
  })
  it('resolves generated group members and reveals claim and manager ancestors', () => {
    const scene = fixtureScene({ now }), state = stateFor({ outer: 'machine', inner: 'status' })
    const claim = scene.claims.find(c => c.cardId === fixtureId(1))!
    const groups = organizedGroups(scene, state, now)
    for (const group of groups) {
      expect(resolveFloorGroup(scene, state, group.id, now)?.cardIds).toEqual(group.cardIds)
      expect(resolveFloorGroup(scene, state, group.outerId, now)?.executionIds).toEqual(
        [...new Set(groups.filter(g => g.outerId === group.outerId).flatMap(g => g.executionIds))])
    }
    for (const target of [{ kind: 'claim', id: claim.id }, { kind: 'manager', id: claim.accountability.home }] as const) {
      for (const type of ['focus', 'flash'] as const) {
        const collapsed = groups.flatMap(g => [semanticId({ kind: 'group', id: g.id }), semanticId({ kind: 'group', id: g.outerId })])
        const result = applyPresentationAction({ ...state, collapsed }, type === 'focus' ? { type, target } : { type, targets: [target] }, scene, now)
        expect(result.outcome).toBe('applied')
        for (const group of groups.filter(g => g.executionIds.includes(claim.executionId))) {
          expect(result.state.collapsed).not.toContain(semanticId({ kind: 'group', id: group.id }))
          expect(result.state.collapsed).not.toContain(semanticId({ kind: 'group', id: group.outerId }))
        }
      }
    }
  })
  it('carries both linked workers under a task field and keeps independent endpoints visible', () => {
    const scene = fixtureScene({ now }), before = JSON.stringify(scene)
    const groups = overviewGroups(scene, stateFor(), now)
    const active = groups.find(g => g.label === 'In Progress')!
    expect(active.cards.some(c => c.id === fixtureId(1))).toBe(true)
    expect(active.workers.filter(w => ['linked-worker', 'helper-worker'].includes(w.identity.task_id!))).toHaveLength(2)
    expect(groups.find(g => g.label === 'Unassigned / Unknown')!.workers.map(w => w.identity.task_id)).toContain('untracked-worker')
    expect(active.cards.some(c => c.id === fixtureId(6))).toBe(true)
    expect(groups.flatMap(g => g.cards).some(c => c.id === fixtureId(5))).toBe(false)
    expect(JSON.stringify(scene)).toBe(before)
  })
  it('makes task references in both machine groups and deduplicates each subdivision', () => {
    const scene = fixtureScene({ now })
    scene.claims.push({ ...scene.claims.find(c => c.cardId === fixtureId(1))!, id: 'repeated-evidence' })
    const groups = organizedGroups(scene, stateFor({ outer: 'machine' }), now)
    const refs = groups.filter(g => g.cardIds.includes(fixtureId(1)))
    expect(refs.map(g => g.label).sort()).toEqual(['Bandit', 'Hulk'])
    expect(refs.every(g => g.cardIds.filter(id => id === fixtureId(1)).length === 1)).toBe(true)
    expect(new Set(groups.flatMap(g => g.cards.map(c => c.id))).size).toBe(5)
    expect(groups.find(g => g.label === 'Unassigned / Unknown')!.cardIds).toContain(fixtureId(2))
  })
  it('preserves correlation across task → worker and worker → task nested fields', () => {
    const scene = fixtureScene({ now })
    for (const organizer of [{ outer: 'status', inner: 'machine' }, { outer: 'machine', inner: 'status' }] as const) {
      const groups = organizedGroups(scene, stateFor(organizer), now)
      const refs = groups.filter(g => g.cardIds.includes(fixtureId(1)))
      expect(refs).toHaveLength(2)
      expect(refs.every(g => g.workers.length === 1)).toBe(true)
      expect(refs.flatMap(g => g.workers.map(w => w.placement.machine)).sort()).toEqual(['Bandit', 'Hulk'])
    }
  })
  it('carries a worker through two task-owned groups without borrowing parent hierarchy', () => {
    const scene = fixtureScene({ now }), worker = scene.executions.find(e => e.identity.task_id === 'linked-worker')!
    const card = scene.cards.find(c => c.id === fixtureId(6))!
    scene.claims.push({ ...scene.claims.find(c => c.cardId === fixtureId(1))!, id: 'second-link', executionId: worker.id, cardId: card.id })
    const groups = organizedGroups(scene, stateFor({ outer: 'owner' }), now)
    expect(groups.filter(g => g.executionIds.includes(worker.id)).map(g => g.label).sort()).toEqual(['Firstmate', 'Will'])
    expect(groups.some(g => /Reconciliation initiative/.test(g.label))).toBe(false)
  })
  it('keeps textual and equal-title candidates out of authoritative memberships', () => {
    const scene = fixtureScene({ now })
    const worker = scene.executions.find(e => e.identity.task_id === 'candidate-worker')!
    scene.claims.push({ ...scene.claims.find(c => c.cardId === fixtureId(1))!, id: 'text-only', executionId: worker.id, basis: 'textual', verification: 'unverified' })
    const group = organizedGroups(scene, stateFor({ outer: 'owner' }), now).find(g => g.executionIds.includes(worker.id))!
    expect(group.label).toBe('Unassigned / Unknown')
    expect(group.cardIds).toEqual([])
  })
  it('keeps a running worker visible with a hidden linked task without manufacturing an orphan', () => {
    const scene = fixtureScene({ now })
    scene.cards.find(c => c.id === fixtureId(1))!.source.properties.Status!.value = 'Done'
    const state = stateFor({ outer: 'status' }), before = JSON.stringify(scene)
    const groups = organizedGroups(scene, state, now), hidden = groups.find(g => g.label === 'Done')!
    expect(hidden.workers).toHaveLength(2)
    expect(hidden.cards).toEqual([])
    expect(hidden.workers.every(w => entityTone(scene, 'execution', w.id, now) === 'linked')).toBe(true)
    expect(JSON.stringify(scene)).toBe(before)
  })
  it('retains source-derived workers when Done makes a link conflicting, without an orphan alarm', () => {
    const sources = fixtureSources({ now })
    sources.intentions.data!.cards.find(c => c.id === fixtureId(1))!.properties.Status!.value = 'Done'
    const scene = new SceneReconciler().reconcile(sources, now)
    const groups = overviewGroups(scene, stateFor(), now)
    expect(groups.flatMap(g => g.cards).some(c => c.id === fixtureId(1))).toBe(false)
    const workers = groups.flatMap(g => g.workers).filter(w => ['linked-worker', 'helper-worker'].includes(w.identity.task_id!))
    expect(workers).toHaveLength(2)
    expect(workers.every(w => entityTone(scene, 'execution', w.id, now) !== 'orphan')).toBe(true)
  })
  it('orders dates by timestamps in both columns, keeps blanks last in both directions and ties deterministic', () => {
    const scene = fixtureScene({ now })
    const first = scene.cards.find(c => c.id === fixtureId(1))!, other = scene.cards.find(c => c.id === fixtureId(4))!
    first.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start: '2026-11-04T08:00:00-05:00' } }
    other.source.properties['Next check-in']!.value = { start: '2026-11-04T15:00:00Z' }
    for (const direction of ['asc', 'desc'] as const) {
      const group = organizedGroups(scene, stateFor({ outer: 'none', order: 'checkIn', direction }), now)[0]!
      expect(group.cards.slice(0, 2).map(c => c.id)).toEqual(direction === 'asc' ? [first.id, other.id] : [other.id, first.id])
      expect(group.cards.slice(2).map(c => c.id)).toEqual(group.cards.slice(2).map(c => c.id).sort())
      expect(group.workers.at(-1)!.identity.task_id).toBe('untracked-worker')
    }
  })
  it('does not lose zero-link cards or workers when grouping every available field', async () => {
    const { floorFields } = await import('../../shared/floorOrganization')
    const scene = fixtureScene({ now })
    for (const f of floorFields) {
      const groups = organizedGroups(scene, stateFor({ outer: f.id }), now)
      expect(new Set(groups.flatMap(g => g.executionIds)).size).toBe(5)
      expect(new Set(groups.flatMap(g => g.cardIds)).size).toBe(5)
    }
  })
})

describe('New York calendar buckets', () => {
  it.each([
    ['2026-11-03', 'Overdue'], ['2026-11-04', 'Today'], ['2026-11-05', 'Tomorrow'],
    ['2026-11-08', 'This week'], ['2026-11-09', 'Later'], [null, 'Not scheduled'], ['bad-date', 'Unknown'],
    ['2026-11-05T02:00:00Z', 'Today'],
  ])('%s → %s', (value, expected) => expect(dateBucket(value, now)).toBe(expected))
  it('handles midnight, overdue timed checkpoints, DST and year boundaries', () => {
    expect(dateBucket('2026-11-04T16:59:59Z', now, true)).toBe('Overdue')
    expect(dateBucket('2026-11-04T00:15:00-05:00', Date.parse('2026-11-04T04:59:00Z'))).toBe('Tomorrow')
    expect(dateTimestamp('2026-11-01')).toBe(Date.parse('2026-11-01T00:00:00-04:00'))
    expect(dateTimestamp('2026-03-08')).toBe(Date.parse('2026-03-08T00:00:00-05:00'))
    expect(dateBucket('2027-01-01', Date.parse('2026-12-31T20:00:00-05:00'))).toBe('Tomorrow')
  })
})

describe('presets, reducer and persisted semantic preferences', () => {
  it('uses current source options and keeps all statuses available under All cards', () => {
    const scene = fixtureScene({ now })
    const state = applyPresentationAction(initialPresentation(), { type: 'set-status-filter', filter: { preset: 'all', statuses: [] } }, scene).state
    expect(new Set(organizedGroups(scene, state, now).flatMap(g => g.cardIds)).size).toBe(7)
    const custom = applyPresentationAction(state, { type: 'set-status-filter', filter: { preset: 'custom', statuses: ['Waiting For'] } }, scene).state
    expect(organizedGroups(scene, custom, now).flatMap(g => g.cardIds)).toEqual([fixtureId(4)])
    expect(new Set(organizedGroups(scene, custom, now).flatMap(g => g.executionIds)).size).toBe(5)
  })
  it('validates the same organizer/filter actions for MCP and persists only preferences', () => {
    localStorage.removeItem(preferencesKey)
    const scene = fixtureScene({ now }), organizer = { ...defaultOrganizer(), outer: 'machine' as const, inner: 'status' as const, direction: 'desc' as const }
    const action = actionSchema.parse({ type: 'set-organizer', organizer })
    let state = applyPresentationAction(initialPresentation(), action, scene).state
    state = applyPresentationAction(state, { type: 'set-status-filter', filter: { preset: 'custom', statuses: ['Queued'] } }, scene).state
    expect(stateSchema.safeParse(state).success).toBe(true)
    savePresentationPreferences({ ...state, selection: { kind: 'card', id: fixtureId(1) } })
    expect(loadPresentationPreferences()).toMatchObject({ organizer, statusFilter: { preset: 'custom', statuses: ['Queued'] }, selection: null, revision: 0 })
    expect(applyPresentationAction(state, { type: 'set-organizer', organizer, expectedRevision: 0 }, scene).outcome).toBe('stale-revision')
    state = applyPresentationAction(state, { type: 'reset-floor' }, scene).state
    expect(state.organizer).toEqual(defaultOrganizer())
    expect(state.statusFilter!.preset).toBe('operational')
  })
  it('targets and expands generated inner and outer groups through the shared reducer', () => {
    const scene = fixtureScene({ now }), state = stateFor({ outer: 'machine', inner: 'status' })
    const group = organizedGroups(scene, state, now).find(g => g.cardIds.includes(fixtureId(1)))!
    for (const id of [group.id, group.outerId]) {
      const collapsed = applyPresentationAction(state, { type: 'set-expanded', target: { kind: 'group', id }, expanded: false }, scene, now)
      expect(collapsed.outcome).toBe('applied')
      expect(collapsed.state.collapsed).toContain(semanticId({ kind: 'group', id }))
      const focus = applyPresentationAction(collapsed.state, { type: 'focus', target: { kind: 'card', id: fixtureId(1) } }, scene, now)
      expect(focus.state.collapsed).not.toContain(semanticId({ kind: 'group', id }))
    }
  })
  it('falls back gracefully for malformed browser preferences', () => {
    localStorage.setItem(preferencesKey, '{invalid')
    expect(loadPresentationPreferences().organizer).toEqual(defaultOrganizer())
    localStorage.removeItem(preferencesKey)
  })
})
