import { describe, expect, it } from 'vitest'
import { fixtureHomes, fixtureId, fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../scene'
import { initialPresentation } from '../../../reconciliation/presentation'
import { overviewGroups } from '../../../reconciliation/overviewModel'
import { FIRST_MATE_TASKS, readWorkerLinks, WORKER_LINK_SCHEMA, type WorkerLink } from '../workerLinks'

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
    expect(scene.findings.filter(f => f.workerLinkDetectors?.includes('duplicate-primary'))).toHaveLength(2)
    input.intentions.data!.cards.find(c => c.id === fixtureId(5))!.properties.Status!.value = 'Done'
    expect(reconcile(input).claims.every(c => c.verification === 'conflicting')).toBe(true)
  })
  it('requires investigation when spawn evidence changes or the same task ID has multiple attempts', () => {
    const input = source(); declare(input)
    input.fleet[1]!.observation.data!.tasks[0]!.identity.spawn_gen = 'replacement'
    expect(reconcile(input).claims[0]?.verification).toBe('conflicting')
    input.fleet[1]!.observation.data!.tasks.push({ ...input.fleet[1]!.observation.data!.tasks[0]!, identity: { ...link, spawn_gen: 'attempt-1' } })
    expect(reconcile(input).claims.every(c => c.verification === 'conflicting')).toBe(true)
    // Fleet collection marks duplicate task IDs partial; positive conflicting
    // attempt evidence must still surface rather than becoming an absence claim.
    input.fleet[1]!.observation.status = 'partial'
    input.fleet[1]!.observation.coverage = 'partial'
    expect(reconcile(input).claims.every(c => c.verification === 'conflicting' && c.state === 'last-known')).toBe(true)
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
  it.each(['competing cards', 'different generation', 'multiple attempts'] as const)(
    'preserves %s conflicts with incomplete Notion pagination', conflict => {
      const input = source(); declare(input)
      Object.assign(input.intentions, { status: 'partial', coverage: 'partial' })
      input.intentions.data!.hasMore = true
      const tasks = input.fleet[1]!.observation.data!.tasks
      if (conflict === 'competing cards') declare(input, fixtureId(5))
      else if (conflict === 'different generation') tasks[0]!.identity.spawn_gen = 'replacement'
      else {
        tasks.push({ ...tasks[0]!, identity: { ...tasks[0]!.identity, spawn_gen: 'replacement' } })
        Object.assign(input.fleet[1]!.observation, { status: 'partial', coverage: 'partial' })
      }
      const scene = reconcile(input)
      expect(scene.claims).toHaveLength(2 - Number(conflict === 'different generation'))
      expect(scene.claims.every(c => c.verification === 'conflicting' && c.state === 'last-known')).toBe(true)
      expect(scene.findings.filter(f => f.kind === 'unverified-conflicting' && f.reason.includes('First Mate must investigate')))
        .toHaveLength(scene.claims.length + Number(conflict === 'multiple attempts'))
      if (conflict === 'multiple attempts') {
        expect(scene.findings.some(f => f.workerLinkDetectors?.includes('spawn-evidence') &&
          scene.executions.every(e => f.executionIds.includes(e.id)))).toBe(true)
      }
      expect(scene.findings.some(f => ['confirmed-link', 'task-execution-gap', 'untracked-worker'].includes(f.kind))).toBe(false)
    },
  )
  it('keeps an absent declared worker unknown with incomplete Notion pagination', () => {
    const input = source(); declare(input)
    Object.assign(input.intentions, { status: 'partial', coverage: 'partial' })
    input.intentions.data!.hasMore = true
    input.fleet[1]!.observation.data!.tasks = []
    const scene = reconcile(input)
    expect(scene.claims[0]).toMatchObject({ verification: 'unverified', state: 'last-known' })
    expect(scene.findings.some(f => f.reason.includes('Declared worker not observed'))).toBe(false)
    expect(scene.findings.some(f => ['confirmed-link', 'task-execution-gap', 'untracked-worker'].includes(f.kind))).toBe(false)
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

  it('does not treat blank properties as malformed while still confirming a real link', () => {
    const input = source()
    const cards = input.intentions.data!.cards
    const linked = cards.find(c => c.id === fixtureId(1))!
    const malformed = cards.find(c => c.id === fixtureId(2))!
    declare(input, linked.id, [link])
    linked.properties[FIRST_MATE_TASKS]!.workerLinks = readWorkerLinks({
      type: 'rich_text', rich_text: [{ plain_text: linked.properties[FIRST_MATE_TASKS]!.value as string }],
    })
    malformed.properties[FIRST_MATE_TASKS]!.workerLinks = readWorkerLinks({
      type: 'rich_text', rich_text: [{ plain_text: '{' }],
    })
    const hinted = cards.find(c => c.id === fixtureId(3))!
    for (const card of cards) {
      if (card.id === linked.id || card.id === malformed.id) continue
      const blank = card.id === hinted.id
        ? { type: 'rich_text', rich_text: [{ plain_text: ' \n\t' }] }
        : { type: 'rich_text', rich_text: [] }
      card.properties[FIRST_MATE_TASKS]!.workerLinks = readWorkerLinks(blank)
      card.properties[FIRST_MATE_TASKS]!.value = ''
    }
    const observed = input.fleet[1]!.observation.data!.tasks[0]!
    input.fleet[1]!.observation.data!.tasks.push({ ...observed, id: 'hinted', identity: { ...observed.identity, task_id: 'hinted' },
      cardReferences: [{ pageId: hinted.id, basis: 'textual', source: 'task.work_item' }] })
    const scene = reconcile(input)
    const propertyFindings = scene.findings.filter(f => f.reason.startsWith(`${FIRST_MATE_TASKS}:`))
    expect(propertyFindings).toEqual([expect.objectContaining({
      kind: 'unverified-conflicting', cardIds: [malformed.id], reason: `${FIRST_MATE_TASKS}: Malformed JSON`,
    })])
    expect(scene.claims.filter(c => c.verification === 'confirmed')).toEqual([
      expect.objectContaining({ cardId: linked.id, basis: 'explicit' }),
    ])
    expect(scene.claims.find(c => c.cardId === hinted.id)).toMatchObject({ verification: 'unverified', basis: 'textual' })
    expect(scene.findings.some(f => f.kind === 'confirmed-link' && f.cardIds.includes(linked.id))).toBe(true)
    malformed.properties[FIRST_MATE_TASKS]!.workerLinks = readWorkerLinks({ type: 'rich_text', rich_text: [] })
    const covered = reconcile(input)
    expect(covered.findings.some(f => f.reason.includes('Malformed JSON'))).toBe(false)
    expect(covered.findings.some(f => f.reason.startsWith(`${FIRST_MATE_TASKS}:`))).toBe(false)
    expect(covered.coverage.absenceConclusions).toBe('suppressed')
    expect(covered.claims.filter(c => c.verification === 'confirmed').map(c => c.cardId)).toEqual([linked.id])
    expect(covered.claims.find(c => c.cardId === hinted.id)?.verification).not.toBe('confirmed')
  })

  it('treats a missing generation in a partial home as unknown evidence', () => {
    const input = source(); declare(input)
    input.fleet[1]!.observation.data!.tasks[0]!.identity.spawn_gen = null
    Object.assign(input.fleet[1]!.observation, { status: 'partial', coverage: 'partial' })
    expect(reconcile(input).claims[0]).toMatchObject({ verification: 'unverified', state: 'last-known' })
  })

})
