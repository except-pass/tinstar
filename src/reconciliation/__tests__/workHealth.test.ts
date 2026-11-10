import { describe, expect, it } from 'vitest'
import { fixtureId, fixtureReadinessScene, fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { workHealth } from '../../shared/workHealth'

const now = Date.parse('2026-11-09T16:00:00Z')
const sceneFor = (): import('../../shared/reconciliationPresentation').FloorScene => fixtureReadinessScene({ now })
type Scene = ReturnType<typeof sceneFor>
const health = (scene: Scene, id = 4) => workHealth(scene, fixtureId(id), now)
const assigned = (scene: Scene) => scene.executions.find(worker => worker.identity.task_id === 'blocked-worker')!
const rowFor = (scene: Scene, id = 'blocked-worker') => scene.backlog.find(row => row.source.id === id)!
const queue: NonNullable<Scene['backlog'][number]['source']['queue']> = { decisions: [], holdKind: null, originTaskId: null, completed: false }

function queued(scene: Scene, id = 'ready-blocker') {
  const template = rowFor(scene)
  const row: Scene['backlog'][number] = { ...template, id: JSON.stringify([template.home, id]), source: { ...template.source, id, state: 'queued', unresolved_blocker_ids: [], cardReferences: [], queue } }
  scene.backlog.push(row)
  return row
}

describe('read-only task readiness projection', () => {
  it('proves an assigned waiting task stalled only with complete zeros', () => {
    const result = health(sceneFor())
    expect(result).toMatchObject({ workerCount: 1, running: 0, runnable: 0, activeResolverCount: 0, lastProgressAt: null })
    expect(result.patterns.active.outcome).toBe('no-match')
    expect(result.patterns.stalled.outcome).toBe('match')
    expect(result.patterns.stale.outcome).toBe('unavailable')
    expect(result.patterns.stalled.evidence.join(' ')).toContain('/fixture/hulk')
  })
  it('uses crew-state over historical waiting or working events', () => {
    const scene = sceneFor(), worker = assigned(scene)
    worker.source.last_event.state = 'working'; worker.liveness = 'running'
    expect(health(scene).patterns.stalled.outcome).toBe('match')
    worker.source.current_state.state = 'working'; worker.source.last_event.state = 'paused'; worker.liveness = 'waiting'
    expect(health(scene)).toMatchObject({ running: 1, patterns: { active: { outcome: 'match' }, stalled: { outcome: 'no-match' } } })
  })
  it('keeps one running plus one waiting worker Active, including an unknown sibling', () => {
    const scene = sceneFor(), helper = scene.executions.find(worker => worker.identity.task_id === 'helper-worker')!
    helper.source.current_state.state = 'paused'
    expect(health(scene, 1)).toMatchObject({ running: 1, patterns: { active: { outcome: 'match' }, stalled: { outcome: 'no-match' } } })
    helper.source.current_state.state = 'unknown'
    expect(health(scene, 1).patterns.active.outcome).toBe('match')
  })
  it.each(['unknown', null, 'waiting', 'held', 'needs-decision'])('never proves zero running from current_state %s', state => {
    const scene = sceneFor(); assigned(scene).source.current_state.state = state
    expect(health(scene).patterns.active.outcome).toBe('unavailable')
    expect(health(scene).patterns.stalled.outcome).toBe('unavailable')
    expect(health(scene).patterns.active.reason).toContain('Running state unknown for /fixture/hulk')
  })
  it.each(['status-log', 'none'])('rejects non-authoritative current-state source %s', source => {
    const scene = sceneFor(); assigned(scene).source.current_state.source = source
    expect(health(scene).patterns.stalled.outcome).toBe('unavailable')
    assigned(scene).source.current_state.state = 'working'
    expect(health(scene).patterns.active.outcome).toBe('unavailable')
  })
  it('rejects a directly referenced queued path without verified links', () => {
    const scene = sceneFor(), row = queued(scene)
    scene.executions = []; scene.claims = []
    row.source.cardReferences = [{ pageId: fixtureId(4), basis: 'explicit', source: 'backlog.work_item' }]
    expect(health(scene)).toMatchObject({ workerCount: 0, runnable: null, patterns: { active: { outcome: 'unavailable' }, stalled: { outcome: 'unavailable' } } })
    row.source.cardReferences[0]!.basis = 'textual'
    expect(health(scene).runnable).toBeNull()
    expect(health(scene).patterns.active.outcome).toBe('unavailable')
  })
  it('counts distinct named runnable blockers without counting blocked rows', () => {
    const scene = sceneFor(); queued(scene)
    rowFor(scene).source.unresolved_blocker_ids = ['ready-blocker', 'ready-blocker']
    expect(health(scene)).toMatchObject({ runnable: 1, activeResolverCount: 0, patterns: { active: { outcome: 'match' }, stalled: { outcome: 'no-match' } } })
  })
  it.each(['hold_reason', 'hold_until', 'hold_bucket', 'captain_actionable', 'holdKind', 'blocked'] as const)('excludes queued %s paths', hold => {
    const scene = sceneFor(), row = queued(scene)
    rowFor(scene).source.unresolved_blocker_ids = ['ready-blocker']
    if (hold === 'holdKind') row.source.queue = { ...queue, holdKind: 'captain' }
    else if (hold === 'blocked') row.source.unresolved_blocker_ids = ['another-blocker']
    else if (hold === 'captain_actionable') row.source.captain_actionable = true
    else row.source[hold] = 'held'
    expect(health(scene).runnable).toBe(hold === 'blocked' ? null : 0)
    expect(health(scene).patterns.active.outcome).toBe(hold === 'blocked' ? 'unavailable' : 'no-match')
  })
  it.each(['blocker', 'continuation'])('counts a working %s as a resolver, not an own running path', kind => {
    const scene = sceneFor(), candidate = scene.executions.find(worker => worker.identity.task_id === 'untracked-worker')!
    if (kind === 'blocker') rowFor(scene).source.unresolved_blocker_ids = ['untracked-worker']
    else rowFor(scene, 'untracked-worker').source.queue = { ...queue, originTaskId: 'blocked-worker' }
    expect(health(scene)).toMatchObject({ running: 0, runnable: 0, activeResolverCount: 1, patterns: { active: { outcome: 'no-match' }, stalled: { outcome: 'no-match' } } })
    candidate.source.current_state.state = 'unknown'
    expect(health(scene).activeResolverCount).toBeNull()
    expect(health(scene).patterns.stalled.outcome).toBe('unavailable')
    candidate.source.current_state.state = 'parked'
    expect(health(scene).activeResolverCount).toBe(0)
    expect(health(scene).patterns.stalled.outcome).toBe('match')
  })
  it.each(['backlog', 'execution'] as const)('counts a queued continuation discovered through %s', source => {
    const scene = sceneFor(), row = queued(scene)
    if (source === 'backlog') row.source.queue = { ...queue, originTaskId: 'blocked-worker' }
    else {
      const worker = scene.executions.find(worker => worker.identity.task_id === 'untracked-worker')!
      worker.identity.task_id = 'ready-blocker'
      worker.source.queue = { ...queue, originTaskId: 'blocked-worker' }
      worker.source.current_state.state = 'paused'
    }
    expect(health(scene)).toMatchObject({ runnable: 1, activeResolverCount: 0, patterns: { active: { outcome: 'match' }, stalled: { outcome: 'no-match' } } })
  })
  it.each(['own', 'blocker', 'continuation'] as const)('excludes a working queued %s from runnable counts', kind => {
    const scene = sceneFor()
    const worker = kind === 'own' ? assigned(scene) : scene.executions.find(worker => worker.identity.task_id === 'untracked-worker')!
    const row = rowFor(scene, worker.identity.task_id!)
    row.source.state = 'queued'
    worker.source.current_state.state = 'working'
    if (kind === 'blocker') rowFor(scene).source.unresolved_blocker_ids = ['untracked-worker']
    if (kind === 'continuation') row.source.queue = { ...queue, originTaskId: 'blocked-worker' }
    expect(health(scene)).toMatchObject({ runnable: 0, activeResolverCount: kind === 'own' ? 0 : 1,
      patterns: { active: { outcome: kind === 'own' ? 'match' : 'no-match' }, stalled: { outcome: 'no-match' } } })
  })
  it.each(['blocker', 'backlog-origin', 'execution-origin'] as const)('preserves unknown for an uninspected nested %s', kind => {
    const scene = sceneFor(), candidate = queued(scene)
    rowFor(scene).source.unresolved_blocker_ids = ['ready-blocker']
    candidate.source.hold_reason = 'held'
    if (kind === 'blocker') {
      candidate.source.unresolved_blocker_ids = ['nested-ready']
      queued(scene, 'nested-ready')
    } else if (kind === 'backlog-origin') {
      queued(scene, 'nested-ready').source.queue = { ...queue, originTaskId: 'ready-blocker' }
    } else {
      scene.executions.find(worker => worker.identity.task_id === 'untracked-worker')!.source.queue = { ...queue, originTaskId: 'ready-blocker' }
    }
    expect(health(scene)).toMatchObject({ runnable: null, activeResolverCount: null,
      patterns: { active: { outcome: 'unavailable' }, stalled: { outcome: 'unavailable' } } })
  })
  it.each(['own', 'blocker', 'backlog-origin', 'execution-origin'] as const)('keeps queued %s readiness unknown with unknown execution activity', kind => {
    const scene = sceneFor()
    const worker = kind === 'own' ? assigned(scene) : scene.executions.find(worker => worker.identity.task_id === 'untracked-worker')!
    const row = rowFor(scene, worker.identity.task_id!)
    row.source.state = 'queued'
    worker.source.current_state.state = 'unknown'
    if (kind === 'blocker') rowFor(scene).source.unresolved_blocker_ids = ['untracked-worker']
    if (kind === 'backlog-origin') row.source.queue = { ...queue, originTaskId: 'blocked-worker' }
    if (kind === 'execution-origin') worker.source.queue = { ...queue, originTaskId: 'blocked-worker' }
    expect(health(scene)).toMatchObject({ runnable: null, patterns: { active: { outcome: 'unavailable' }, stalled: { outcome: 'unavailable' } } })
  })
  it('does not count a task own worker again as its resolver', () => {
    const scene = sceneFor(); rowFor(scene).source.unresolved_blocker_ids = ['blocked-worker']
    expect(health(scene).activeResolverCount).toBe(0)
  })
  it('keeps an explicit Waiting For dependency Blocked while Status remains In Progress', () => {
    const scene = sceneFor()
    scene.cards.find(card => card.id === fixtureId(4))!.source.properties['Waiting For']!.value = 'Reviewer input'
    expect(health(scene).patterns.blocked.outcome).toBe('match')
    expect(health(scene).patterns.stalled.outcome).toBe('no-match')
  })
  it('retains a backlog-only dependency as Blocked even without a waiting worker', () => {
    const scene = sceneFor()
    scene.cards.find(card => card.id === fixtureId(4))!.source.properties['Waiting For']!.value = 'Named dependency'
    assigned(scene).source.current_state.state = 'unknown'
    rowFor(scene).source.unresolved_blocker_ids = ['named-dependency']
    expect(health(scene).blockers).toEqual(['named-dependency'])
    expect(health(scene).patterns.blocked.outcome).toBe('match')
    expect(health(scene).patterns.stalled.outcome).toBe('no-match')
  })
  it('does not use a candidate whose current-state freshness is stale', () => {
    const scene = sceneFor(), candidate = scene.executions.find(worker => worker.identity.task_id === 'untracked-worker')!
    rowFor(scene).source.unresolved_blocker_ids = ['untracked-worker']
    candidate.source.current_state.freshness = 'stale'
    expect(health(scene).activeResolverCount).toBeNull()
    expect(health(scene).patterns.stalled.outcome).toBe('unavailable')
  })
  it('resolves named blockers only within their canonical home', () => {
    const scene = sceneFor(), local = queued(scene)
    rowFor(scene).source.unresolved_blocker_ids = ['ready-blocker']
    const remote = { ...local, id: 'remote-ready', home: '/fixture/bandit' }
    scene.backlog.push(remote)
    expect(health(scene).runnable).toBe(1) // the local identity is explicit
    scene.backlog = scene.backlog.filter(row => row !== local)
    expect(health(scene).runnable).toBeNull()
    expect(health(scene).patterns.active.outcome).toBe('unavailable')
    expect(health(scene).patterns.stalled.outcome).toBe('unavailable')
    scene.backlog.push({ ...remote, id: 'another-ready', home: '/fixture/mac' })
    expect(health(scene).runnable).toBeNull()
    expect(health(scene).activeResolverCount).toBeNull()
  })
  it.each(['missing-list', 'missing-blocker', 'partial', 'stale', 'expired', 'read-failed', 'unverified'] as const)('keeps %s evidence unknown', failure => {
    const scene = sceneFor()
    if (failure === 'missing-list') delete rowFor(scene).source.unresolved_blocker_ids
    if (failure === 'missing-blocker') rowFor(scene).source.unresolved_blocker_ids = ['unobserved-blocker']
    if (failure === 'partial') scene.coverage.homes[1]!.observation.coverage = 'partial'
    if (failure === 'stale') scene.coverage.homes[1]!.observation.status = 'stale'
    if (failure === 'expired') scene.coverage.homes[1]!.observation.expiresAt = new Date(now - 1).toISOString()
    if (failure === 'read-failed') scene.searchReadFailed = true
    if (failure === 'unverified') scene.claims.find(link => link.cardId === fixtureId(4))!.verification = 'unverified'
    expect(health(scene)).toMatchObject({ runnable: null, activeResolverCount: null, patterns: { active: { outcome: 'unavailable' }, stalled: { outcome: 'unavailable' } } })
  })
  it('rejects stale home evidence even with retained explicit empty lists', () => {
    const scene = fixtureReadinessScene({ now, stale: true })
    expect(rowFor(scene).source.unresolved_blocker_ids).toEqual([])
    expect(health(scene).runnable).toBeNull()
    expect(health(scene).patterns.stalled.reason).toContain('Home snapshot stale or unreadable: /fixture/hulk')
  })
})

describe('Codex turn readiness', () => {
  function codex(scene: Scene, turn: boolean | null = true, observedAt = new Date(now).toISOString()) {
    const worker = assigned(scene)
    worker.source.harness = 'codex'
    worker.source.current_state.state = 'unknown'
    worker.source.codex = { turn_open: turn, observed_at: observedAt, last_activity_at: '2026-11-08T00:00:00Z', session_file: 'rollout-test.jsonl' }
    return worker
  }
  it('uses open/closed turns for Active and Stalled without an activity timeout', () => {
    const scene = sceneFor(), worker = codex(scene)
    expect(health(scene)).toMatchObject({ running: 1, waiting: 0, unknown: 0, patterns: { active: { outcome: 'match' }, stalled: { outcome: 'no-match' } } })
    worker.source.codex!.turn_open = false
    expect(health(scene)).toMatchObject({ running: 0, waiting: 1, unknown: 0, patterns: { active: { outcome: 'no-match' }, stalled: { outcome: 'match' } } })
  })
  it.each([null, 'expired', 'future', 'invalid', 'missing', 'wrong-harness', 'stale-home'] as const)('leaves %s evidence honestly unknown', condition => {
    const scene = sceneFor(), worker = codex(scene)
    if (condition === null) worker.source.codex!.turn_open = null
    if (condition === 'expired') worker.source.codex!.observed_at = new Date(now - 300_000).toISOString()
    if (condition === 'future') worker.source.codex!.observed_at = new Date(now + 60_000).toISOString()
    if (condition === 'invalid') worker.source.codex!.observed_at = 'invalid'
    if (condition === 'missing') worker.source.codex = null
    if (condition === 'wrong-harness') worker.source.harness = 'claude'
    if (condition === 'stale-home') worker.observation.status = 'stale'
    expect(health(scene)).toMatchObject({ running: 0, waiting: 0, unknown: 1, patterns: { active: { outcome: 'unavailable' }, stalled: { outcome: 'unavailable' } } })
  })
  it('keeps known crew state authoritative', () => {
    const scene = sceneFor(), worker = codex(scene)
    worker.source.current_state.state = 'parked'
    expect(health(scene)).toMatchObject({ running: 0, waiting: 1 })
    worker.source.codex!.turn_open = false
    worker.source.current_state.state = 'working'
    expect(health(scene)).toMatchObject({ running: 1, waiting: 0 })
  })
})

describe('status-aware worker coverage', () => {
  it.each(['Queued', 'Waiting For', 'Waiting for Prod Release', 'Done', 'Archived'])(
    'does not require a First Mate worker for %s', status => {
      const scene = fixtureScene({ now }), card = scene.cards.find(card => card.id === fixtureId(2))!
      card.source.properties.Status!.value = status
      expect(health(scene, 2).patterns.unstaffed.outcome).toBe('no-match')
      expect(health(scene, 2).patterns.stalled.outcome).toBe('no-match')
      expect(health(scene, 2).patterns.active.outcome).toBe('no-match')
    },
  )
  it('does not treat an archived In Progress card as unstaffed', () => {
    const scene = fixtureScene({ now })
    scene.cards.find(card => card.id === fixtureId(2))!.source.archived = true
    expect(health(scene, 2).patterns.unstaffed.outcome).toBe('no-match')
  })
  it('requires sufficient coverage to conclude In Progress is unstaffed', () => {
    const scene = fixtureScene({ now })
    expect(health(scene, 2).patterns.unstaffed.outcome).toBe('match')
    scene.coverage.absenceConclusions = 'suppressed'
    expect(health(scene, 2).patterns.unstaffed.outcome).toBe('unavailable')
  })
  it('retains unknown instead of a defect for an unaccountable blank link', () => {
    const scene = fixtureScene({ now }), card = scene.cards.find(card => card.id === fixtureId(2))!
    card.source.properties['First Mate tasks']!.value = ''
    scene.findings = scene.findings.filter(finding => !finding.cardIds.includes(card.id))
    expect(health(scene, 2).patterns.unstaffed.outcome).toBe('unavailable')
  })
  it.each(['current', 'stale', 'different-card'] as const)('accounts for a %s external-worker report without inventing verified runtime coverage', freshness => {
    const scene = fixtureScene({ now }), card = scene.cards.find(card => card.id === fixtureId(2))!
    card.source.properties['Delegated To'] = { id: 'external', type: 'rich_text', hasMore: false, value: JSON.stringify({
      schema: 'tinstar.external-worker.v1', kind: 'external', system: 'Build runner', run_id: 'one',
      reference: 'https://runner.example/one', card_id: freshness === 'different-card' ? fixtureId(1) : card.id,
      observed_at: new Date(now - (freshness === 'stale' ? 600_000 : 0)).toISOString(), state: 'running',
      evidence: 'Actively compiling the assigned card', reported_by: 'Clawson',
    }) }
    const verdict = health(scene, 2)
    expect(verdict.patterns.unstaffed.outcome).toBe(freshness === 'current' ? 'no-match' : freshness === 'stale' ? 'unavailable' : 'match')
    expect(verdict.patterns.active.outcome).toBe('unavailable')
    if (freshness !== 'different-card') expect(verdict.patterns.unstaffed.evidence.join(' ')).toContain('https://runner.example/one')
  })
})
