import { describe, expect, it } from 'vitest'
import { fixtureHomes, fixtureId, fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../scene'
import { initialPresentation } from '../../../reconciliation/presentation'
import { overviewGroups } from '../../../reconciliation/overviewModel'
import { FIRST_MATE_TASKS, WORKER_LINK_SCHEMA, type WorkerLink } from '../workerLinks'

const now = Date.parse('2026-11-04T20:00:00Z')
const link: WorkerLink = { fm_home: fixtureHomes[1]!, task_id: 'linked-worker', first_observed_spawn_gen: 'attempt-1' }
const source = () => {
  const input = fixtureSources({ now })
  for (const home of input.fleet) {
    home.observation.data!.tasks = home.observation.data!.tasks.filter(task => task.identity.task_id === link.task_id)
    for (const task of home.observation.data!.tasks) task.cardReferences = []
    home.observation.data!.backlog = []
  }
  for (const card of input.intentions.data!.cards) declare(input, card.id, [])
  return input
}
function declare(input: ReturnType<typeof source>, cardId = fixtureId(1), tasks: WorkerLink[] = [link]) {
  input.intentions.data!.cards.find(c => c.id === cardId)!.properties[FIRST_MATE_TASKS] = {
    id: 'links', type: 'rich_text', hasMore: false, value: JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks }),
  }
}
const reconcile = (input: ReturnType<typeof source>) => new SceneReconciler().reconcile(input, now)

describe('Notion authoritative observation table', () => {
  it('confirms two workers on one card using only exact Notion declarations and fleet identities', () => {
    const input = source()
    const first = input.fleet[1]!.observation.data!.tasks[0]!
    input.fleet[1]!.observation.data!.tasks.push({ ...first, id: 'helper', identity: { ...first.identity, task_id: 'helper' } })
    declare(input, fixtureId(1), [link, { ...link, task_id: 'helper' }])
    const scene = reconcile(input)
    expect(scene.claims).toHaveLength(2)
    expect(scene.claims.every(c => c.verification === 'confirmed' && c.state === 'current')).toBe(true)
    expect(scene.claims.map(c => c.sources)).toEqual([['notion.First Mate tasks'], ['notion.First Mate tasks']])
    expect(scene.cardRollups.find(c => c.cardId === fixtureId(1))?.counts.workers).toBe(2)
    expect(scene.findings.filter(f => f.kind === 'confirmed-link')).toHaveLength(2)
  })
  it.each(['stale', 'partial', 'unknown', 'unconfigured'] as const)('keeps %s homes last-known, including after a server restart', status => {
    const input = source(); declare(input)
    if (status === 'unconfigured') input.fleet.splice(1, 1)
    else {
      input.fleet[1]!.observation.status = status
      input.fleet[1]!.observation.coverage = status === 'partial' ? 'partial' : 'unknown'
      if (status === 'unknown') input.fleet[1]!.observation.data = null
    }
    const scene = reconcile(input)
    expect(scene.claims[0]).toMatchObject({ state: 'last-known', verification: 'unverified' })
    expect(scene.findings.some(f => ['untracked-worker', 'task-execution-gap'].includes(f.kind))).toBe(false)
    expect(scene.findings.some(f => f.reason.includes('not observed in a complete fresh home'))).toBe(false)
  })
  it('classifies positive Notion-origin evidence without a declaration as an investigation candidate', () => {
    const input = source()
    input.fleet[1]!.observation.data!.tasks[0]!.cardReferences = [{ pageId: fixtureId(1), basis: 'explicit', source: 'task.work_item' }]
    const scene = reconcile(input)
    expect(scene.claims[0]?.verification).toBe('unverified')
    expect(scene.findings.filter(f => f.kind === 'untracked-worker')).toHaveLength(1)
    expect(scene.findings.some(f => f.kind === 'confirmed-link')).toBe(false)
  })
  it('leaves independent workers legitimately unlinked', () => {
    const scene = reconcile(source())
    expect(scene.claims).toEqual([])
    expect(scene.findings.filter(f => f.executionIds.length)).toEqual([])
  })
  it('surfaces wrong IDs without inventing workers or switching to a title candidate', () => {
    const input = source(); declare(input, fixtureId(1), [{ ...link, task_id: 'wrong' }])
    const scene = reconcile(input)
    expect(scene.claims[0]).toMatchObject({ verification: 'unverified', state: 'last-known', identity: { task_id: 'wrong' } })
    expect(scene.executions.map(e => e.identity.task_id)).toEqual(['linked-worker'])
    expect(scene.findings.some(f => f.reason.includes('Declared worker not observed'))).toBe(true)
  })
  it('marks competing primary cards conflicting, even when one is filter-hidden or Done', () => {
    const input = source(); declare(input); declare(input, fixtureId(5))
    const scene = reconcile(input)
    expect(scene.claims).toHaveLength(2)
    expect(scene.claims.every(c => c.verification === 'conflicting')).toBe(true)
    expect(scene.findings.filter(f => f.reason.includes('Competing'))).toHaveLength(2)
    input.intentions.data!.cards.find(c => c.id === fixtureId(5))!.properties.Status!.value = 'Done'
    expect(reconcile(input).claims.every(c => c.verification === 'conflicting')).toBe(true)
  })
  it('requires investigation when spawn evidence changes or the same task ID has multiple attempts', () => {
    const input = source(); declare(input)
    input.fleet[1]!.observation.data!.tasks[0]!.identity.spawn_gen = 'replacement'
    expect(reconcile(input).claims[0]?.verification).toBe('conflicting')
    input.fleet[1]!.observation.data!.tasks.push({ ...input.fleet[1]!.observation.data!.tasks[0]!, identity: { ...link, spawn_gen: 'attempt-1' } })
    expect(reconcile(input).claims.every(c => c.verification === 'conflicting')).toBe(true)
  })
  it('never transfers an association to another home with the same task ID', () => {
    const input = source(); declare(input)
    const task = input.fleet[1]!.observation.data!.tasks.shift()!
    input.fleet[2]!.observation.data!.tasks.push({ ...task, identity: { ...task.identity, fm_home: fixtureHomes[2]! } })
    const scene = reconcile(input)
    expect(scene.claims[0]).toMatchObject({ verification: 'unverified', identity: { fm_home: fixtureHomes[1] } })
    expect(scene.claims[0]?.executionId).not.toBe(scene.executions[0]?.id)
  })
  it.each(['Done', 'Owner changed', 'Archived'])('retains %s cards as historical relationships', value => {
    const input = source(); declare(input)
    const card = input.intentions.data!.cards.find(c => c.id === fixtureId(1))!
    if (value === 'Owner changed') card.properties.Owner!.value = 'Will'
    else if (value === 'Archived') card.archived = true
    else card.properties.Status!.value = value
    expect(reconcile(input).claims[0]).toMatchObject({ verification: 'confirmed', state: 'historical' })
    expect(reconcile(input).findings.some(f => f.reason.includes('Competing'))).toBe(false)
  })
  it.each(['missing', 'stale', 'expired', 'pagination-incomplete'] as const)('keeps %s Notion observations unknown and suppresses absence claims', status => {
    const input = source(); declare(input)
    if (status === 'missing') Object.assign(input.intentions, { status: 'unknown', data: null, coverage: 'unknown' })
    else if (status === 'expired') input.intentions.expiresAt = new Date(now - 1).toISOString()
    else if (status === 'pagination-incomplete') { input.intentions.status = 'partial'; input.intentions.data!.hasMore = true }
    else input.intentions.status = 'stale'
    const scene = reconcile(input)
    expect(scene.claims.every(c => c.verification !== 'confirmed')).toBe(true)
    expect(scene.findings.some(f => ['task-execution-gap', 'untracked-worker'].includes(f.kind))).toBe(false)
  })
  it('does not infer missing declarations when any card property is unknown', () => {
    const input = source()
    delete input.intentions.data!.cards[0]!.properties[FIRST_MATE_TASKS]
    input.fleet[1]!.observation.data!.tasks[0]!.cardReferences = [{ pageId: fixtureId(1), basis: 'textual', source: 'task.backlog.title' }]
    expect(reconcile(input).findings.some(f => f.kind === 'untracked-worker')).toBe(false)
  })
  it('keeps valid relationships in the source model when filters hide the card', () => {
    const input = source(); declare(input)
    input.intentions.data!.cards.find(c => c.id === fixtureId(1))!.properties.Status!.value = 'Backlog'
    const scene = reconcile(input)
    expect(scene.claims[0]).toMatchObject({ verification: 'confirmed', state: 'current' })
    const groups = overviewGroups(scene, initialPresentation(), now)
    expect(groups.flatMap(g => g.cardIds)).not.toContain(fixtureId(1))
    expect(scene.findings.some(f => f.kind === 'untracked-worker')).toBe(false)
  })
  it('retains observed history as last-known when Notion disappears even with a complete empty home', () => {
    const input = source(); declare(input)
    const model = new SceneReconciler()
    const first = model.reconcile(input, now)
    input.fleet[1]!.observation.data!.tasks = []
    Object.assign(input.intentions, { data: null, status: 'unknown', coverage: 'unknown' })
    const next = model.reconcile(input, now + 1000)
    expect(next.claimHistory.find(c => c.id === first.claims[0]!.id)).toMatchObject({ state: 'last-known', endedAt: null })
  })
  it('surfaces duplicate primary declarations even while the home is offline', () => {
    const input = source(); declare(input); declare(input, fixtureId(5))
    input.fleet[1]!.observation = { ...input.fleet[1]!.observation, status: 'unknown', coverage: 'unknown', data: null }
    expect(reconcile(input).claims.every(c => c.verification === 'conflicting' && c.state === 'last-known')).toBe(true)
  })

})
