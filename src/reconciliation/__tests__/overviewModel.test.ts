import { describe, expect, it } from 'vitest'
import { fixtureHomes, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { gapTargets, overviewGroups, managerName, rootHome } from '../overviewModel'
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
