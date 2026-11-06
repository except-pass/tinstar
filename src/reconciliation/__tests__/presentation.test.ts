import { describe, expect, it } from 'vitest'
import { fixtureHomes, fixtureId, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { defaultOrganizer, floorFields, organizedGroups } from '../../shared/floorOrganization'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { applyPresentationAction, initialPresentation, semanticId, type Target } from '../presentation'

describe('shared semantic presentation transitions', () => {
  it('reveals only the navigated card through search, donuts and collapsed ancestors', () => {
    const now = Date.parse('2026-11-04T17:00:00Z'), scene = fixtureScene({ now })
    const base = initialPresentation()
    const groups = organizedGroups(scene, base, now)
    const collapsed = groups.flatMap(group => [semanticId({ kind: 'group', id: group.id }), semanticId({ kind: 'group', id: group.outerId })])
    const state = { ...base, collapsed, search: { query: 'no-such-anchor-xyz', patterns: [], facets: [] }, donutFilter: { cards: ['Waiting For'], workers: ['no-match'] } }
    expect(organizedGroups(scene, state, now)).toHaveLength(0)
    const next = applyPresentationAction(state, { type: 'navigate-card', cardId: fixtureId(1) }, scene, now).state
    const revealed = organizedGroups(scene, next, now)
    expect([...new Set(revealed.flatMap(group => group.cardIds))]).toEqual([fixtureId(1)])
    expect(revealed.flatMap(group => group.executionIds)).toEqual([])
    for (const group of revealed) {
      expect(next.collapsed).not.toContain(semanticId({ kind: 'group', id: group.id }))
      expect(next.collapsed).not.toContain(semanticId({ kind: 'group', id: group.outerId }))
    }
    expect(next.search).toEqual(state.search)
    expect(next.donutFilter).toEqual(state.donutFilter)
    const changed = applyPresentationAction(next, { type: 'set-search', search: state.search }, scene, now).state
    expect(organizedGroups(scene, changed, now)).toHaveLength(0)
  })
  it('preserves selection and reveals its managers/groups across shared organizer fields', () => {
    const now = Date.parse('2026-11-04T17:00:00Z')
    const scene = fixtureScene({ now })
    const selected: Target = { kind: 'card', id: fixtureId(1) }
    let state = initialPresentation()
    for (const home of fixtureHomes) state = applyPresentationAction(state, { type: 'set-expanded', target: { kind: 'manager', id: home }, expanded: false }, scene, now).state
    state = applyPresentationAction(state, { type: 'focus', target: selected }, scene, now).state
    expect(state.collapsed).not.toContain(semanticId({ kind: 'manager', id: fixtureHomes[1]! }))
    for (const { id: outer } of floorFields) {
      const organizer = { ...defaultOrganizer(), outer, inner: 'status' as const }
      state = applyPresentationAction(state, { type: 'set-organizer', organizer }, scene, now).state
      const groups = organizedGroups(scene, state, now)
      for (const group of groups) {
        for (const id of [group.id, group.outerId]) state = applyPresentationAction(state, { type: 'set-expanded', target: { kind: 'group', id }, expanded: false }, scene, now).state
      }
      for (const home of fixtureHomes) state = applyPresentationAction(state, { type: 'set-expanded', target: { kind: 'manager', id: home }, expanded: false }, scene, now).state
      state = applyPresentationAction(state, { type: 'set-organizer', organizer }, scene, now).state
      expect(state.collapsed).not.toContain(semanticId({ kind: 'manager', id: fixtureHomes[1]! }))
      expect(state.selection).toEqual(selected)
      const selectedGroups = groups.filter(group => group.cardIds.includes(selected.id))
      expect(selectedGroups.length).toBeGreaterThan(0)
      for (const group of selectedGroups) for (const id of [group.id, group.outerId]) expect(state.collapsed).not.toContain(semanticId({ kind: 'group', id }))
    }
    expect(scene.counts.workers).toBe(5)
  })
  it('rejects unknown identities and stale revisions without mutating the view', () => {
    const scene = fixtureScene()
    const state = initialPresentation()
    expect(applyPresentationAction(state, { type: 'focus', target: { kind: 'card', id: 'missing' } }, scene)).toEqual({ state, outcome: 'unknown-id' })
    expect(applyPresentationAction(state, { type: 'set-arrangement', arrangement: 'machine', expectedRevision: 4 }, scene)).toEqual({ state, outcome: 'stale-revision' })
    const manual = applyPresentationAction(state, { type: 'set-arrangement', arrangement: 'machine' }, scene).state
    expect(applyPresentationAction(manual, { type: 'focus', target: { kind: 'you', id: 'root' }, origin: 'assistant', expectedRevision: 0 }, scene).outcome).toBe('stale-revision')
  })
  it('bounds flashes, clears transient presentation and reveals planned cards', () => {
    const scene = fixtureScene()
    const card: Target = { kind: 'card', id: fixtureId(5) }
    let state = applyPresentationAction(initialPresentation(), { type: 'flash', targets: [card, card], durationMs: 90_000, origin: 'assistant' }, scene, 100).state
    expect(state.flash).toEqual({ ids: [semanticId(card)], until: 4100 })
    expect(state.assistantChangedView).toBe(true)
    state = applyPresentationAction(state, { type: 'set-exceptions', enabled: true }, scene).state
    state = applyPresentationAction(state, { type: 'focus', target: card }, scene).state
    expect(state).toMatchObject({ selection: card, roadmapExpanded: true, exceptionsOnly: false })
    expect(applyPresentationAction(state, { type: 'clear-transient' }, scene).state).toMatchObject({ selection: card, flash: null, assistantChangedView: false })
  })
  it.each(['initiative', 'machine', 'manager'] as const)('reveals filtered flash targets in %s without changing selection or domain data', arrangement => {
    const scene = fixtureScene()
    const claim = scene.claims.find(c => c.cardId === fixtureId(1) && c.verification === 'confirmed')!
    expect(claim).toBeDefined()
    const baseState = { ...initialPresentation(), organizer: { ...defaultOrganizer(), outer: arrangement, inner: 'status' as const } }
    const groups = organizedGroups(scene, baseState, 100)
    const group = groups.find(g => g.cardIds.includes(claim.cardId) && g.executionIds.includes(claim.executionId))!
    const execution = scene.executions.find(e => e.id === claim.executionId)!
    const targets: Target[] = [
      { kind: 'card', id: claim.cardId }, { kind: 'execution', id: execution.id },
      { kind: 'claim', id: claim.id }, { kind: 'group', id: group.id }, { kind: 'group', id: group.outerId }, { kind: 'manager', id: execution.home },
    ]
    expect(new Set(scene.findings.filter(f => f.cardIds.includes(claim.cardId)).map(f => f.kind))).toEqual(new Set(['confirmed-link']))
    const before = JSON.stringify(scene)
    for (const origin of ['manual', 'assistant'] as const) {
      for (const target of targets) {
        const state = { ...baseState, exceptionsOnly: true, selection: { kind: 'you', id: 'root' } as Target,
          collapsed: [...groups.flatMap(g => [semanticId({ kind: 'group', id: g.id }), semanticId({ kind: 'group', id: g.outerId })]), ...fixtureHomes.map(id => semanticId({ kind: 'manager', id }))] }
        const result = applyPresentationAction(state, { type: 'flash', targets: [target], origin }, scene, 100)
        expect(result.outcome).toBe('applied')
        expect(result.state).toMatchObject({ exceptionsOnly: false, selection: state.selection, flash: { ids: [semanticId(target)], until: 2500 } })
        expect(result.state.collapsed).not.toContain(semanticId({ kind: 'group', id: group.id }))
        expect(result.state.collapsed).not.toContain(semanticId({ kind: 'group', id: group.outerId }))
        if (target.kind !== 'group') expect(result.state.collapsed).not.toContain(semanticId({ kind: 'manager', id: execution.home }))
        expect(state.exceptionsOnly).toBe(true)
      }
    }
    expect(JSON.stringify(scene)).toBe(before)
  })
  it('retains historic selection over restart/reassignment without changing domain data', () => {
    const now = Date.now()
    const sources = fixtureSources({ now })
    const reconciler = new SceneReconciler()
    const first = reconciler.reconcile(sources, now)
    const claim = first.claims.find(c => c.verification === 'confirmed' && c.identity.task_id === 'linked-worker')!
    const state = applyPresentationAction(initialPresentation(), { type: 'focus', target: { kind: 'claim', id: claim.id } }, first).state
    const execution = sources.fleet[1]!.observation.data!.tasks[0]!
    execution.identity.spawn_gen = 'attempt-2'
    execution.cardReferences[0]!.pageId = fixtureId(3)
    const next = reconciler.reconcile(sources, now + 1000)
    const before = JSON.stringify(next)
    const result = applyPresentationAction(state, { type: 'set-arrangement', arrangement: 'machine' }, next)
    expect(result.state.selection).toEqual(state.selection)
    expect(next.claimHistory.some(c => c.id === claim.id)).toBe(true)
    expect(JSON.stringify(next)).toBe(before)
  })
  it('uses explicit controlled semantic fixtures and never claims outages are empty', () => {
    const scene = fixtureScene()
    expect(new Set(scene.findings.map(f => f.kind))).toEqual(new Set(['confirmed-link', 'task-execution-gap', 'untracked-worker', 'unverified-conflicting', 'legitimate-wait-planned', 'outside-coverage']))
    const failed = fixtureScene({ unavailable: true, size: 850 })
    expect(failed.findings.some(f => ['task-execution-gap', 'untracked-worker'].includes(f.kind))).toBe(false)
    expect(failed.counts.cards).toBe(857)
    expect(failed.counts.workers).toBe(85)
    for (const groups of Object.values(failed.arrangements)) {
      expect(new Set(groups.flatMap(g => g.cardIds)).size).toBe(failed.counts.cards)
      expect(new Set(groups.flatMap(g => g.executionIds)).size).toBe(failed.counts.attempts)
      expect(groups.some(g => g.label === 'Unassigned / unknown')).toBe(true)
    }
  })
})
