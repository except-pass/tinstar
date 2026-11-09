import { describe, expect, it } from 'vitest'
import { fixtureId, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { cardWorkerFact, patternCheckSummary, workerLinkSourceHealth } from '../overviewEvidence'
import { SceneReconciler } from '../../server/reconciliation/scene'
import type { PatternResult } from '../../shared/workHealth'
import type { WorkerLinkDetector } from '../../server/reconciliation/scene'

const now = Date.parse('2026-11-09T21:00:00Z')
describe('worker link source health', () => {
  it('keeps advisory candidates, hierarchy issues and unknown expectations neutral', () => {
    const sources = fixtureSources({ now })
    const card = sources.intentions.data!.cards.find(card => card.id === fixtureId(2))!
    card.properties.Status!.value = 'Unrecognized status'
    card.properties['Parent item']!.value = [fixtureId(2)]
    const scene = new SceneReconciler().reconcile(sources, now)
    expect(scene.cards.find(value => value.id === card.id)!.hierarchyIssues.length).toBeGreaterThan(0)
    expect(scene.cards.find(value => value.id === card.id)!.expectation).toBe('unknown')
    expect(scene.findings.some(finding => finding.sourceHealth && finding.cardIds.includes(fixtureId(3)))).toBe(true)
    expect(workerLinkSourceHealth(scene, [fixtureId(2), fixtureId(3)], now))
      .toEqual({ unknown: 1, unverified: 1, conflicting: 0 })
  })
  it.each<WorkerLinkDetector>(['invalid-record', 'declared-absent', 'duplicate-primary', 'spawn-evidence', 'duplicate-execution'])(
    'counts substantive %s evidence once and excludes advisory findings', detector => {
      const scene = fixtureScene({ now })
      scene.findings.push({ id: 'detector', kind: 'unverified-conflicting', cardIds: [fixtureId(2)], executionIds: [],
        homeIds: [], reason: 'Worker-link evidence', workerLinkDetectors: [detector] })
      expect(workerLinkSourceHealth(scene, [fixtureId(2), fixtureId(2)], now))
        .toEqual({ unknown: 0, unverified: 0, conflicting: 1 })
      scene.findings.at(-1)!.sourceHealth = true
      expect(workerLinkSourceHealth(scene, [fixtureId(2)], now))
        .toEqual({ unknown: 1, unverified: 0, conflicting: 0 })
      scene.findings.at(-1)!.sourceHealth = undefined
      scene.findings.at(-1)!.workerLinkDetectors = ['historical-link']
      expect(workerLinkSourceHealth(scene, [fixtureId(2)], now))
        .toEqual({ unknown: 1, unverified: 0, conflicting: 0 })
    })
  it('counts unique visible unknown and unverified cards separately from positive conflicts', () => {
    const scene = fixtureScene({ now })
    const ids = [fixtureId(1), fixtureId(2), fixtureId(2), fixtureId(3)]
    expect(workerLinkSourceHealth(scene, ids, now)).toEqual({ unknown: 1, unverified: 1, conflicting: 0 })
    scene.claims.find(link => link.cardId === fixtureId(3))!.verification = 'conflicting'
    expect(workerLinkSourceHealth(scene, ids, now)).toEqual({ unknown: 1, unverified: 0, conflicting: 1 })
    expect(workerLinkSourceHealth(scene, [], now)).toEqual({ unknown: 0, unverified: 0, conflicting: 0 })
  })
  it('ages confirmed relationships and keeps healthy home links through an unrelated outage', () => {
    const scene = fixtureScene({ now })
    scene.coverage.homes[0]!.observation.status = 'stale'
    expect(workerLinkSourceHealth(scene, [fixtureId(1)], now).unverified).toBe(0)
    expect(workerLinkSourceHealth(scene, [fixtureId(1)], now, true).unverified).toBe(1)
    expect(workerLinkSourceHealth(scene, [fixtureId(1)], now + 3600_000).unverified).toBe(1)
    scene.claims.forEach(link => { link.state = 'historical' })
    expect(workerLinkSourceHealth(scene, [fixtureId(1)], now).unknown).toBe(1)
  })
  it('keeps invalid records and proven absent declarations actionable during unrelated incomplete coverage', () => {
    const sources = fixtureSources({ now, unavailable: true })
    const cards = sources.intentions.data!.cards
    cards.find(card => card.id === fixtureId(2))!.properties['First Mate tasks']!.value = '{'
    cards.find(card => card.id === fixtureId(3))!.properties['First Mate tasks']!.value = JSON.stringify({
      schema: 'tinstar.fm-links.v1',
      tasks: [{ fm_home: sources.fleet[1]!.source.home, task_id: 'absent-worker', first_observed_spawn_gen: 'attempt-1' }],
    })
    const scene = new SceneReconciler().reconcile(sources, now)
    expect(scene.coverage.absenceConclusions).toBe('suppressed')
    expect(scene.claims.some(link => link.cardId === fixtureId(2))).toBe(false)
    expect(scene.claims.find(link => link.cardId === fixtureId(3))!.verification).toBe('unverified')
    for (const readFailed of [false, true]) {
      expect(workerLinkSourceHealth(scene, [fixtureId(2), fixtureId(3), fixtureId(3), fixtureId(5)], now, readFailed))
        .toEqual({ unknown: 1, unverified: 0, conflicting: 2 })
    }
  })
})

function singleWorker() {
  const scene = fixtureScene({ now })
  const worker = scene.executions.find(worker => worker.identity.task_id === 'linked-worker')!
  scene.claims = scene.claims.filter(link => link.cardId !== fixtureId(1) || link.executionId === worker.id)
  return { scene, worker, fact: () => cardWorkerFact(scene, fixtureId(1), now) }
}

describe('card worker facts', () => {
  it('states a confirmed absence, but omits it under incomplete coverage or unverified links', () => {
    const scene = fixtureScene({ now })
    expect(cardWorkerFact(scene, fixtureId(2), now)).toBe('No worker')
    scene.coverage.absenceConclusions = 'suppressed'
    expect(cardWorkerFact(scene, fixtureId(2), now)).toBeNull()
    const { scene: linked, worker, fact } = singleWorker()
    linked.claims.find(link => link.executionId === worker.id)!.verification = 'unverified'
    expect(fact()).toBeNull()
  })
  it('omits absence for In Progress work without home accountability despite fresh configured sources', () => {
    const sources = fixtureSources({ now })
    for (const home of sources.fleet) home.observation.data!.backlog = []
    const scene = new SceneReconciler().reconcile(sources, now)
    expect(scene.cards.find(card => card.id === fixtureId(2))!.source.properties.Status!.value).toBe('In Progress')
    expect(scene.coverage.absenceConclusions).toBe('sufficient-configured-sources')
    expect(scene.claims.filter(link => link.cardId === fixtureId(2))).toEqual([])
    expect(cardWorkerFact(scene, fixtureId(2), now)).toBeNull()
    expect(cardWorkerFact(scene, fixtureId(1), now)).toBe('2 workers running')
  })
  it('uses fresh current state for running and counts multiple workers', () => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = 'working'
    worker.source.current_state.source = 'run-step'
    expect(fact()).toBe('Worker running')
    expect(cardWorkerFact(fixtureScene({ now }), fixtureId(1), now)).toBe('2 workers running')
  })
  it.each(['waiting', 'parked', 'paused', 'blocked', 'held', 'needs-decision'])('shows %s as waiting, with only the matching report age', state => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = state
    worker.source.last_event.state = state
    worker.source.last_event.age_seconds = 3 * 3600
    expect(fact()).toBe('Worker waiting · reported 3h ago')
    worker.source.last_event.state = 'working'
    expect(fact()).toBe('Worker waiting')
  })
  it('names the unknown pane source and harness without treating a working history event as current', () => {
    const { worker, fact } = singleWorker()
    worker.source.harness = 'codex'
    worker.source.current_state.state = 'unknown'
    worker.source.last_event.state = 'working'
    expect(fact()).toBe('Worker state unknown (codex pane)')
    worker.source.current_state.source = 'none'
    expect(fact()).toBe('Worker state unknown')
  })
  it('does not present stale state as currently running, or use other homes to discredit a fresh worker', () => {
    const { scene, worker, fact } = singleWorker()
    const home = scene.coverage.homes.find(home => home.source.home === worker.home)!
    scene.coverage.homes.find(value => value !== home)!.observation.status = 'stale'
    expect(fact()).toBe('Worker running')
    worker.observation.observedAt = new Date(now - 3 * 3600_000).toISOString()
    worker.observation.status = 'stale'
    expect(fact()).toBe('Worker state unknown · last seen 3h ago')
    worker.observation.status = 'fresh'
    home.observation.status = 'stale'
    expect(fact()).toBe('Worker state unknown · last seen 3h ago')
  })
  it.each(['done', 'failed'])('reports current terminal state %s', state => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = state
    expect(fact()).toBe(`Worker ${state}`)
  })
  it('retains both running and unknown facts on mixed assignments', () => {
    const scene = fixtureScene({ now })
    const helper = scene.executions.find(worker => worker.identity.task_id === 'helper-worker')!
    helper.source.harness = 'codex'
    helper.source.current_state.state = 'unknown'
    expect(cardWorkerFact(scene, fixtureId(1), now)).toBe('Worker running · Worker state unknown (codex pane)')
  })
})

const result = (reason: string, outcome: PatternResult['outcome'] = 'unavailable'): PatternResult => ({ outcome, reason, evidence: [] })
describe('one pattern explanation', () => {
  it('counts unchecked cards, groups plain reasons, and omits evaluable cards', () => {
    expect(patternCheckSummary([
      result('Running state unknown for /home/a: task-a (pane)'),
      result('Running state unknown for /home/b: task-b (pane); Runnable state unknown for /home/b: task-b'),
      result('Meaningful progress time is not published; heartbeat/check-in age is not progress'),
      result('match', 'match'), result('no-match', 'no-match'), undefined,
    ])).toBe('3 cards not checked: worker state unknown; progress time unknown')
  })
  it('omits the explanation when all cards are evaluable', () => {
    expect(patternCheckSummary([])).toBeNull()
    expect(patternCheckSummary([result('match', 'match'), result('no-match', 'no-match')])).toBeNull()
  })
})
