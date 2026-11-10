import { describe, expect, it } from 'vitest'
import { fixtureId, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { entityTone, gapTargets } from '../overviewModel'
import { cardWorkerFact, patternCheckSummary, workerLinkSourceHealth } from '../overviewEvidence'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { workHealth, combinedPatternResult, sceneWorkHealth, type PatternResult } from '../../shared/workHealth'
import { activeWorker, workerFact } from '../../shared/workerEvidence'
import { organizedGroups } from '../../shared/floorOrganization'
import { initialPresentation } from '../presentation'
import { readWorkerLinks } from '../../server/reconciliation/workerLinks'
import type { WorkerLinkDetector } from '../../server/reconciliation/scene'

const now = Date.parse('2026-11-09T21:00:00Z')
describe('worker link source health', () => {
  it('associates reconciled duplicate execution evidence through nonhistorical links', () => {
    const sources = fixtureSources({ now })
    const home = sources.fleet[1]!
    sources.fleet[2]!.observation.data!.tasks = []
    sources.intentions.data!.cards.find(card => card.id === fixtureId(1))!.properties['First Mate tasks']!.value = JSON.stringify({
      schema: 'tinstar.fm-links.v1',
      tasks: [{ fm_home: home.source.home, task_id: 'linked-worker', first_observed_spawn_gen: 'attempt-1' }],
    })
    home.observation.data!.tasks.push(structuredClone(home.observation.data!.tasks[0]!))
    Object.assign(home.observation, { status: 'partial', coverage: 'partial' })
    const scene = new SceneReconciler().reconcile(sources, now)
    const finding = scene.findings.find(value => value.workerLinkDetectors?.includes('duplicate-execution'))!
    const link = scene.claims.find(value => value.executionId === finding.executionIds[0])!
    expect(finding.cardIds).toEqual([])
    expect(link).toMatchObject({ cardId: fixtureId(1), verification: 'unverified', state: 'last-known' })
    expect(workerLinkSourceHealth(scene, [fixtureId(1), fixtureId(1), fixtureId(2)], now))
      .toEqual({ unknown: 1, unverified: 0, conflicting: 1 })
    finding.sourceHealth = true
    expect(workerLinkSourceHealth(scene, [fixtureId(1)], now))
      .toEqual({ unknown: 0, unverified: 1, conflicting: 0 })
    finding.sourceHealth = undefined
    link.state = 'historical'
    expect(workerLinkSourceHealth(scene, [fixtureId(1)], now))
      .toEqual({ unknown: 1, unverified: 0, conflicting: 0 })
  })
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
  it.each(['current', 'stale', 'different-card'] as const)('keeps %s external reports consistent across gaps, header, styling and patterns', report => {
    const sources = fixtureSources({ now })
    const card = sources.intentions.data!.cards.find(card => card.id === fixtureId(2))!
    card.properties['Delegated To'] = { id: 'external', type: 'rich_text', hasMore: false, value: JSON.stringify({
      schema: 'tinstar.external-worker.v1', kind: 'external', system: 'Build runner', run_id: 'one',
      reference: 'https://runner.example/one', card_id: report === 'different-card' ? fixtureId(1) : card.id,
      observed_at: new Date(now - (report === 'stale' ? 600_000 : 0)).toISOString(), state: 'running',
      evidence: 'Actively compiling the assigned card', reported_by: 'Clawson',
    }) }
    const scene = new SceneReconciler().reconcile(sources, now)
    const gap = report === 'different-card'
    expect(scene.findings.some(finding => finding.kind === 'task-execution-gap' && finding.cardIds.includes(card.id))).toBe(gap)
    expect(cardWorkerFact(scene, card.id, now)).toBe(gap ? 'No worker' : null)
    expect(entityTone(scene, 'card', card.id, now)).toBe(gap ? 'gap' : 'uncertain')
    expect(gapTargets(scene, now).some(target => target.kind === 'card' && target.id === card.id)).toBe(gap)
    const health = sceneWorkHealth(scene, now).find(health => health.cardId === card.id)!
    for (const pattern of ['unstaffed', 'stalled'] as const) {
      expect(health.patterns[pattern].outcome).toBe(report === 'current' ? 'no-match' : report === 'stale' || pattern === 'stalled' ? 'unavailable' : 'match')
    }
  })
  it('uses fresh current state for running and counts multiple workers', () => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = 'working'
    worker.source.current_state.source = 'run-step'
    expect(fact()).toBe('1 worker running')
    expect(cardWorkerFact(fixtureScene({ now }), fixtureId(1), now)).toBe('2 workers running')
  })
  it.each(['parked', 'paused', 'blocked'])('shows recorded %s as waiting, with only the matching report age', state => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = state
    worker.source.last_event.state = state
    worker.source.last_event.age_seconds = 3 * 3600
    expect(fact()).toBe('1 worker waiting · reported 3h ago')
    worker.source.last_event.state = 'working'
    expect(fact()).toBe('1 worker waiting')
  })
  it.each(['waiting', 'held', 'needs-decision'])('keeps unsupported crew-state %s unknown', state => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = state
    worker.source.last_event.state = state
    expect(fact()).toContain('1 worker, no update since')
  })
  it.each([true, false])('uses a fresh Codex turn (%s) without dating it from an old report', turn => {
    const { scene, worker, fact } = singleWorker()
    worker.source.harness = 'codex'
    worker.source.current_state.state = 'unknown'
    worker.source.current_state.freshness = 'unknown'
    worker.source.last_event.state = 'unknown'
    worker.source.last_event.age_seconds = 2 * 86400
    worker.source.codex = { turn_open: turn, observed_at: new Date(now).toISOString(),
      last_activity_at: new Date(now - 1000).toISOString(), session_file: 'rollout-test.jsonl' }
    expect(fact()).toBe(turn ? '1 worker running' : '1 worker waiting')
    worker.source.codex.observed_at = new Date(now - 300_000).toISOString()
    expect(fact()).toContain('no update since')
    worker.source.codex.observed_at = new Date(now).toISOString()
    worker.observation.status = 'stale'
    expect(fact()).toContain('no update since')
    worker.observation.status = 'fresh'
    scene.coverage.homes.find(home => home.source.home === worker.home)!.observation.status = 'stale'
    expect(fact()).toBe('1 worker, home unreachable')
  })
  it('dates waiting reports independently of recent log activity', () => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = 'parked'
    worker.source.last_event.state = 'parked'
    worker.source.last_event.age_seconds = 2 * 86400
    worker.source.codex = { turn_open: false, observed_at: new Date(now).toISOString(),
      last_activity_at: new Date(now - 1000).toISOString(), session_file: 'rollout-test.jsonl' }
    expect(fact()).toBe('1 worker waiting · reported 2d ago')
  })
  it('ignores pane state and dates the last recorded status event', () => {
    const { worker, fact } = singleWorker()
    worker.source.harness = 'codex'
    worker.source.current_state.state = 'unknown'
    worker.source.last_event.state = 'working'
    worker.source.current_state.source = 'pane'
    worker.source.last_event.age_seconds = 2 * 86400
    expect(fact()).toBe('1 worker, no update since 2026-11-07 21:00 UTC')
    worker.source.current_state.source = 'none'
    expect(fact()).toBe('1 worker, no update since 2026-11-07 21:00 UTC')
  })
  it('does not present stale state as currently running, or use other homes to discredit a fresh worker', () => {
    const { scene, worker, fact } = singleWorker()
    const home = scene.coverage.homes.find(home => home.source.home === worker.home)!
    scene.coverage.homes.find(value => value !== home)!.observation.status = 'stale'
    expect(fact()).toBe('1 worker running')
    worker.observation.observedAt = new Date(now - 3 * 3600_000).toISOString()
    worker.observation.status = 'stale'
    expect(fact()).toBe('1 worker, no update since 2026-11-09 17:59 UTC')
    worker.observation.status = 'fresh'
    home.observation.status = 'stale'
    expect(fact()).toBe('1 worker, home unreachable')
  })
  it.each(['done', 'failed'])('omits recorded terminal state %s', state => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = state
    expect(fact()).toBeNull()
  })
  it.each([
    { source: 'run-step', state: 'working', turn: null, resumed: true },
    { source: 'run-step', state: 'running', turn: null, resumed: true },
    { source: 'none', state: 'unknown', turn: true, resumed: true },
    { source: 'none', state: 'unknown', turn: false, resumed: false },
    { source: 'none', state: 'unknown', turn: null, resumed: false },
    { source: 'pane', state: 'working', turn: null, resumed: false },
    { source: 'run-step', state: 'paused', turn: null, resumed: false },
    { source: 'run-step', state: 'parked', turn: null, resumed: false },
    { source: 'run-step', state: 'blocked', turn: null, resumed: false },
  ])('counts an old done worker only with newer execution: $source/$state/$turn', ({ source, state, turn, resumed }) => {
    const { scene, worker, fact } = singleWorker()
    worker.source.last_event = { state: 'done', raw: 'done: old completion', note: null, age_seconds: 86400 }
    worker.liveness = 'finished'
    worker.source.current_state = { ...worker.source.current_state, state, source }
    worker.source.codex = turn === null ? null : { turn_open: turn, observed_at: new Date(now).toISOString(), last_activity_at: new Date(now - (turn ? 1000 : 2 * 86400_000)).toISOString(), session_file: 'resumed.jsonl' }
    expect(fact()).toBe(resumed ? '1 worker running' : null)
    expect(workHealth(scene, fixtureId(1), now)).toMatchObject({ workerCount: resumed ? 1 : 0, running: resumed ? 1 : 0 })
    const shown = organizedGroups(scene, initialPresentation(), now).flatMap(group => group.workers)
    expect(shown.some(value => value.id === worker.id)).toBe(resumed)
    expect(workerFact(worker, now, worker.observation)).toBe(resumed ? 'running' : 'finished')
    if (turn === false) {
      worker.source.codex!.last_activity_at = new Date(now).toISOString()
      expect(fact()).toBeNull()
    }
    if (resumed) {
      if (worker.source.codex) worker.source.codex.last_activity_at = new Date(now - 2 * 86400_000).toISOString()
      else worker.source.current_state.observed_at = new Date(now - 2 * 86400_000).toISOString()
      expect(fact()).toBeNull()
    }
  })
  it('counts a newer open turn after a done report and stale run-step', () => {
    const { scene, worker, fact } = singleWorker()
    worker.source.last_event = { state: 'done', raw: 'done: old completion', note: null, age_seconds: 86400 }
    worker.liveness = 'finished'
    worker.source.current_state = { ...worker.source.current_state, state: 'done', source: 'run-step', freshness: 'stale' }
    worker.source.codex = { turn_open: true, observed_at: new Date(now).toISOString(),
      last_activity_at: new Date(now - 1000).toISOString(), session_file: 'resumed.jsonl' }
    expect(fact()).toBe('1 worker running')
    expect(activeWorker(worker, now)).toBe(true)
    expect(workHealth(scene, fixtureId(1), now)).toMatchObject({ workerCount: 1, running: 1 })
    expect(organizedGroups(scene, initialPresentation(), now).flatMap(group => group.workers).some(value => value.id === worker.id)).toBe(true)
    expect(workerFact(worker, now, worker.observation)).toBe('running')
  })
  it('counts only observed unfinished workers across headers, relationships and pattern health', () => {
    const sources = fixtureSources({ now })
    const home = sources.fleet[1]!
    const live = home.observation.data!.tasks.find(task => task.id === 'linked-worker')!
    live.current_state = { ...live.current_state, state: 'working', source: 'pane' }
    live.last_event = { state: 'paused', raw: null, note: 'Build dependencies', age_seconds: 2 * 86400 }
    const finished = structuredClone(live)
    finished.id = finished.identity.task_id = 'finished-worker'
    finished.last_event = { state: 'done', raw: 'done: cancelled scope', note: 'Cancelled', age_seconds: 7 * 86400 }
    home.observation.data!.tasks.push(finished)
    sources.fleet[2]!.observation.data!.tasks = []
    const card = sources.intentions.data!.cards.find(card => card.id === fixtureId(1))!
    card.properties['First Mate tasks']!.value = JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks:
      ['linked-worker', 'finished-worker', 'not-found-worker'].map(task_id => ({ fm_home: home.source.home, task_id, first_observed_spawn_gen: 'attempt-1' })) })
    const scene = new SceneReconciler().reconcile(sources, now)
    expect(cardWorkerFact(scene, card.id, now)).toBe('1 worker, no update since 2026-11-07 21:00 UTC')
    const shown = new Map(organizedGroups(scene, initialPresentation(), now).flatMap(group => group.workers.map(worker => [worker.id, worker] as const)))
    const linked = scene.executions.filter(worker => activeWorker(worker, now) && scene.claims.some(link => link.cardId === card.id && link.executionId === worker.id && link.verification === 'confirmed'))
    expect(linked).toHaveLength(1)
    expect(shown.has(linked[0]!.id)).toBe(true)
    expect(workerFact(linked[0]!, now, home.observation)).toBe('no update since 2026-11-07 21:00 UTC')
    expect(workHealth(scene, card.id, now)).toMatchObject({ workerCount: 1, running: 0, unknown: 1 })
    home.observation.status = 'stale'
    scene.coverage.homes.find(value => value.source.home === home.source.home)!.observation.status = 'stale'
    expect(cardWorkerFact(scene, card.id, now)).toBe('1 worker, home unreachable')
    expect(workerFact(linked[0]!, now, undefined)).toBe('home unreachable')
  })
  it.each(['working', 'paused', 'done'])('never treats pane %s as recorded activity', state => {
    const { worker, fact } = singleWorker()
    worker.source.current_state.state = state
    worker.source.current_state.source = 'pane'
    worker.source.last_event.age_seconds = 2 * 86400
    expect(fact()).toBe('1 worker, no update since 2026-11-07 21:00 UTC')
  })
  it('retains both running and unknown facts on mixed assignments', () => {
    const scene = fixtureScene({ now })
    const helper = scene.executions.find(worker => worker.identity.task_id === 'helper-worker')!
    helper.source.harness = 'codex'
    helper.source.current_state.state = 'unknown'
    expect(cardWorkerFact(scene, fixtureId(1), now)).toBe('1 worker running · 1 worker, no update since 2026-11-09 20:59 UTC')
  })
})

const result = (reason: string, outcome: PatternResult['outcome'] = 'unavailable'): PatternResult => ({ outcome, reason, evidence: [] })
describe('selected pattern coverage', () => {
  it('counts unique visible cards, groups reasons and keeps evaluated results separate', () => {
    const results = new Map([
      ['a', result('Running state unknown for /home/a: task-a (pane)')],
      ['b', result('Running state unknown for /home/b: task-b (pane); Runnable state unknown for /home/b: task-b')],
      ['c', result('Meaningful progress time is not published; heartbeat/check-in age is not progress')],
      ['d', result('match', 'match')], ['e', result('no-match', 'no-match')],
      ['outside', result('Notion source unavailable')],
    ])
    expect(patternCheckSummary(['a', 'a', 'b', 'c', 'd', 'e', 'not-evaluated'], results)).toEqual({
      unavailableCardIds: ['a', 'b', 'c'], total: 5, evaluated: 2, label: 'Pattern unknown: 3',
      reasons: ['worker state unknown', 'progress time unknown'],
    })
    expect(results.get('d')!.outcome).toBe('match')
    expect(results.get('e')!.outcome).toBe('no-match')
    expect(results.get('a')!.outcome).toBe('unavailable')
  })
  it('omits coverage when no visible cards are unavailable', () => {
    const results = new Map([['a', result('match', 'match')], ['b', result('no-match', 'no-match')]])
    expect(patternCheckSummary([], results)).toBeNull()
    expect(patternCheckSummary(['a', 'b'], results)).toBeNull()
  })
  it('describes 127 unavailable cards without implying broken links or requests', () => {
    const results = new Map(Array.from({ length: 127 }, (_, id) => [String(id), result('Worker decision requests or assignment coverage are incomplete')]))
    expect(patternCheckSummary(results.keys(), results)).toMatchObject({
      total: 127, evaluated: 0, label: 'Pattern unknown: 127', reasons: ['worker decision evidence unavailable'],
    })
  })
  it.each(['blank', 'empty', 'verified', 'conflict', 'missing-home', 'stale-home', 'partial-home'] as const)(
    'preserves %s evidence and keeps link findings out of selected pattern coverage', condition => {
      const sources = fixtureSources({ now })
      const card = sources.intentions.data!.cards.find(card => card.id === fixtureId(1))!
      if (condition === 'blank') {
        card.properties['First Mate tasks']!.value = ''
        card.properties['First Mate tasks']!.workerLinks = readWorkerLinks({ type: 'rich_text', rich_text: [] })
      }
      if (condition === 'empty') card.properties['First Mate tasks']!.value = JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks: [] })
      if (condition === 'conflict') card.properties['First Mate tasks']!.value = '{'
      if (condition === 'missing-home') sources.fleet = []
      if (condition === 'stale-home') sources.fleet[1]!.observation.status = 'stale'
      if (condition === 'partial-home') sources.fleet[0]!.observation.coverage = 'partial'
      const scene = new SceneReconciler().reconcile(sources, now)
      // Stale progress is unavailable in the existing producer for every card;
      // even a positive conflict is independent of this pattern verdict.
      const results = new Map(sceneWorkHealth(scene, now).map(health => [health.cardId, combinedPatternResult(health, ['stale'])]))
      expect(results.get(card.id)!.outcome).toBe('unavailable')
      expect(patternCheckSummary([card.id, card.id], results)).toMatchObject({ unavailableCardIds: [card.id], total: 1, evaluated: 0 })
      expect(workerLinkSourceHealth(scene, [card.id], now).conflicting).toBe(condition === 'conflict' ? 1 : 0)
    },
  )
})
