import { describe, expect, it } from 'vitest'
import type { SourceSnapshot } from '..'
import type { Observation } from '../observation'
import { reconcileScene, SceneReconciler } from '../scene'
import { cardReferences } from '../references'

type FleetData = NonNullable<SourceSnapshot['fleet'][number]['observation']['data']>
type NotionData = NonNullable<SourceSnapshot['intentions']['data']>
type Task = FleetData['tasks'][number]
type Card = NotionData['cards'][number]
const now = Date.parse('2026-11-03T20:00:00Z')
const at = new Date(now).toISOString()
const a = '40d50ce6d422814aa741c102cd00aaae'
const b = '30950ce6d42280d3a541cbd66c274f6a'
const c = '30950ce6d42280b584d0000b877283da'
function observation<T>(data: T): Observation<T> {
  return { data, status: 'fresh', coverage: 'complete', observedAt: at, attemptedAt: at, expiresAt: new Date(now + 60_000).toISOString(), error: null }
}
function card(id = a, values: Record<string, unknown> = {}): Card {
  return { id, url: `https://notion.so/${id}`, last_edited_time: at, archived: false, in_trash: false,
    properties: Object.fromEntries(Object.entries({ Name: 'Build reconciliation', Status: 'In Progress', Owner: 'Firstmate', 'Parent item': [], ...values })
      .map(([name, value]) => [name, { id: name, type: name === 'Parent item' ? 'relation' : 'select', value, hasMore: false }])) }
}
type TaskOverrides = Omit<Partial<Task>, 'current_state' | 'backlog'> & { current_state?: Partial<Task['current_state']>; backlog?: Partial<Task['backlog']> }
function task(id = 'worker', pageId: string | null = a, overrides: TaskOverrides = {}): Task {
  return { id, kind: 'ship', spawn_gen: 'attempt-1', harness: null, model: null, branch: null, project: null, backend: null,
    identity: { fm_home: '/farm/hulk', task_id: id, spawn_gen: 'attempt-1' },
    cardReferences: pageId ? [{ pageId, basis: 'explicit', source: 'task.notion_page_id' }] : [], remote: null,
    endpoint: { exists: true, agent_alive: null, status: null, observed_at: at, freshness: 'fresh' },
    paths: { home: null, worktree: null }, lastEventText: null, last_event: { raw: null, note: null, state: null, age_seconds: null }, pr: { head: null, source: null, url: null }, ...overrides,
    current_state: { state: 'working', freshness: 'fresh', source: 'pane', observed_at: at, detail: null, ...overrides.current_state },
    backlog: { id: null, title: null, state: null, hold_reason: null, blocked_by: null, hold_until: null, ...overrides.backlog } }
}
function home(tasks: Task[] = [], path = '/farm/hulk', machine: string | undefined = 'hulk'): SourceSnapshot['fleet'][number] {
  return { source: { home: path, machine, machineBasis: machine ? 'configured' : 'unknown' }, observation: observation({
    schema: 'fm-fleet-snapshot.v1', fm_home: path, generated: at, coverageScope: 'home-task-metadata-and-backlog', main_inventory: { valid: true, reason: null, unstructured_current_count: null }, backlogPresent: true,
    ledger: { role: 'change-signal-only', cursor: null, scope: 'not-collected' }, tasks, backlog: [],
  }) }
}
function snapshot(tasks: Task[] = [], cards: Card[] = [card()]): SourceSnapshot {
  return { generatedAt: at, scope: 'configured-homes-only', warnings: [], fleet: [home(tasks)], intentions: observation({
    dataSourceId: b, schema: {}, cards, hasMore: false, truncatedRelations: [], missingSchemaProperties: [], scope: 'configured-source',
  }) }
}
const findings = (source: SourceSnapshot, kind: string) => reconcileScene(source, now).findings.filter(f => f.kind === kind)
function expectedHome(source = snapshot()): SourceSnapshot {
  source.fleet[0]!.observation.data!.backlog = [{ id: 'expected-work', title: 'Authorized work', state: 'in_flight', kind: 'ship', repo: null,
    hold_reason: null, hold_until: null, blocked_by: null, captain_actionable: null, pr_url: null,
    cardReferences: [{ pageId: a, basis: 'explicit', source: 'backlog.notion_page_id' }] }]
  return source
}

describe('claim evidence and stable identity', () => {
  it('confirms only explicit IDs and retains accountability without asserting progress', () => {
    const scene = reconcileScene(snapshot([task()]), now)
    expect(scene.claims[0]).toMatchObject({ cardId: a, basis: 'explicit', verification: 'confirmed', observedAt: at,
      identity: { fm_home: '/farm/hulk', task_id: 'worker', spawn_gen: 'attempt-1' }, accountability: { home: '/farm/hulk', owner: 'Firstmate' } })
    expect(scene.findings.map(f => f.kind)).toEqual(['confirmed-link'])
    expect(scene.cards[0]?.progressAssessment).toBeNull()
  })

  it('confirms a worker from an explicit work_item and ignores a non-Notion work_item', () => {
    const linked = task('worker', null, {
      cardReferences: cardReferences({ work_item: `https://www.notion.so/Build-reconciliation-${a}?pvs=21` }, 'task'),
    })
    const scene = reconcileScene(snapshot([linked]), now)
    const worker = scene.executions[0]!
    const rollup = scene.cardRollups.find(entry => entry.cardId === a)
    expect(rollup?.executionIds).toContain(worker.id)
    expect(rollup?.counts.workers).toBe(1)
    expect(scene.claims.filter(claim => claim.executionId === worker.id)).toEqual([
      expect.objectContaining({ cardId: a, basis: 'explicit', verification: 'confirmed', sources: ['task.work_item'] }),
    ])
    expect(scene.findings.find(finding => finding.kind === 'confirmed-link' && finding.executionIds.includes(worker.id) && finding.cardIds.includes(a))?.reason)
      .toBe('Explicit work_item links this attempt to the card; this does not establish progress or delivery')

    const unlinked = reconcileScene(snapshot([task('worker', null, {
      cardReferences: cardReferences({ work_item: 'https://github.com/org/repo/issues/1' }, 'task'),
    })]), now)
    const other = unlinked.executions[0]!
    expect(unlinked.cardRollups.find(entry => entry.cardId === a)?.executionIds ?? []).not.toContain(other.id)
    expect(unlinked.claims.filter(claim => claim.executionId === other.id)).toEqual([])
    expect(unlinked.claims.some(claim => claim.verification === 'confirmed')).toBe(false)
  })

  it('extracts textual IDs from raw/title but never returns raw contents or upgrades them', () => {
    const refs = cardReferences({ title: `Build (card ${a})`, raw: `private text https://app.notion.com/p/${b}`, notion_page_id: '40d50ce6-d422-814a-a741-c102cd00aaae' }, 'backlog')
    expect(refs).toEqual([
      { pageId: a, basis: 'explicit', source: 'backlog.notion_page_id' },
      { pageId: a, basis: 'textual', source: 'backlog.title' }, { pageId: b, basis: 'textual', source: 'backlog.raw' },
    ])
    expect(JSON.stringify(refs)).not.toContain('private')
    expect(cardReferences({ title: `unrelated UUID ${a}`, notion_page_id: '-'.repeat(32) }, 'task')).toEqual([])
    const source = snapshot([task('worker', null, { cardReferences: refs.filter(ref => ref.pageId === b) })], [card(b)])
    expect(reconcileScene(source, now).claims[0]).toMatchObject({ basis: 'textual', verification: 'unverified' })
    expect(findings(source, 'untracked-worker')).toHaveLength(0)
    expect(findings(source, 'task-execution-gap')).toHaveLength(0)
  })

  it('treats title equality as an inferred candidate; differing titles establish nothing', () => {
    const source = snapshot([task('worker', null, { backlog: { title: 'Build   reconciliation' } })])
    expect(reconcileScene(source, now).claims[0]).toMatchObject({ basis: 'inferred', verification: 'unverified' })
    expect(findings(source, 'untracked-worker')).toHaveLength(0)
    source.fleet[0]!.observation.data!.tasks[0]!.backlog.title = 'Different work'
    expect(findings(source, 'untracked-worker')).toHaveLength(1)
  })

  it('marks contradictory IDs, completed cards and outside ownership conflicting', () => {
    const worker = task('worker', a, { cardReferences: [
      { pageId: a, basis: 'explicit', source: 'task.notion_page_id' }, { pageId: b, basis: 'textual', source: 'task.backlog.title' },
    ] })
    const scene = reconcileScene(snapshot([worker], [card(a), card(b)]), now)
    expect(scene.claims.every(c => c.verification === 'conflicting')).toBe(true)
    for (const values of [{ Status: 'Done' }, { Owner: 'PM Bot' }]) {
      expect(reconcileScene(snapshot([task()], [card(a, values)]), now).claims[0]?.verification).toBe('conflicting')
    }
  })

  it('keeps multiple attempts/workers and identical task names in two homes distinct', () => {
    const first = task()
    const second = task('helper')
    const source = snapshot([first, second])
    source.fleet.push(home([task('worker', a, { identity: { fm_home: '/farm/other', task_id: 'worker', spawn_gen: 'attempt-1' } })], '/farm/other', 'optimus'))
    const scene = reconcileScene(source, now)
    expect(new Set(scene.claims.map(c => c.id)).size).toBe(3)
    expect(scene.counts).toMatchObject({ cards: 1, workers: 3, attempts: 3, claims: 3 })
    expect(findings(source, 'task-execution-gap')).toHaveLength(0)
    source.fleet[0]!.observation.data!.tasks.push({ ...first, identity: { ...first.identity, spawn_gen: 'attempt-2' } })
    expect(reconcileScene(source, now).counts).toMatchObject({ cards: 1, workers: 3, attempts: 4 })
  })

  it('does not count duplicate source identities twice', () => {
    const scene = reconcileScene(snapshot([task(), task()]), now)
    expect(scene.executions).toHaveLength(1)
    expect(scene.findings.some(f => f.reason.includes('Duplicate'))).toBe(true)
  })

  it('keeps old attempt/reassignment claims as history and preserves unchanged IDs', () => {
    const reconciler = new SceneReconciler()
    const source = snapshot([task()], [card(a), card(b)])
    const first = reconciler.reconcile(source, now)
    const same = reconciler.reconcile(source, now + 1000)
    expect(same.claims[0]?.id).toBe(first.claims[0]?.id)
    source.fleet[0]!.observation.data!.tasks[0] = task('worker', b)
    const reassigned = reconciler.reconcile(source, now + 2000)
    expect(reassigned.claims.map(c => c.cardId)).toEqual([b])
    expect(reassigned.claimHistory[0]).toMatchObject({ cardId: a, state: 'historical', endedAt: at })
    source.fleet[0]!.observation.data!.tasks[0] = task('worker', b, { identity: { fm_home: '/farm/hulk', task_id: 'worker', spawn_gen: 'attempt-2' } })
    const restarted = reconciler.reconcile(source, now + 3000)
    expect(restarted.claimHistory).toHaveLength(2)
    expect(restarted.counts).toMatchObject({ cards: 2, workers: 1, attempts: 1, claims: 1 })
    expect(restarted.claims[0]?.id).not.toBe(reassigned.claims[0]?.id)
  })

  it('does not retire relationships when a home read fails', () => {
    const model = new SceneReconciler()
    const source = snapshot([task()]); model.reconcile(source, now)
    source.fleet[0]!.observation = { ...source.fleet[0]!.observation, status: 'unknown', coverage: 'unknown', data: null }
    const scene = model.reconcile(source, now + 1000)
    expect(scene.claimHistory[0]).toMatchObject({ state: 'last-known', endedAt: null })
    expect(scene.findings.some(f => f.kind === 'task-execution-gap')).toBe(false)
    expect(model.reconcile(source, now + 86_400_001).claimHistory).toEqual([])
    expect(new SceneReconciler().reconcile(source, now + 1000).claimHistory).toEqual([])
  })
})

describe('truthful reconciliation findings', () => {
  it('requires expected-now work plus fresh sufficient coverage for a gap', () => {
    expect(findings(expectedHome(), 'task-execution-gap')).toHaveLength(1)
    expect(findings(snapshot(), 'task-execution-gap')).toHaveLength(0)
    expect(findings(expectedHome(snapshot([], [card(a, { Status: 'Backlog' })])), 'task-execution-gap')).toHaveLength(0)
    expect(findings(snapshot([], [card(a, { Owner: null })]), 'task-execution-gap')).toHaveLength(0)
    expect(findings(snapshot([], [card(a, { Status: 'Unrecognized' })]), 'task-execution-gap')).toHaveLength(0)
  })

  it('separates overdue accountability from execution and progress', () => {
    const overdue = card(a, { 'Next check-in': { start: '2026-11-02T10:00:00Z' } })
    const scene = reconcileScene(snapshot([task()], [overdue]), now)
    expect(scene.cards[0]?.checkpoint.state).toBe('overdue')
    expect(scene.cards[0]?.progressAssessment).toBeNull()
    expect(scene.findings.map(f => f.kind)).toEqual(['confirmed-link'])
    expect(findings(expectedHome(snapshot([], [card(a, { 'Next check-in': { start: '2030-01-01' } })])), 'task-execution-gap')).toHaveLength(1)
  })

  it('retains waits, planned/backlog work and their next action/checkpoint', () => {
    for (const values of [{ Status: 'Backlog' }, { Status: 'Queued' }, { Status: 'Waiting For' }, { Status: 'Ready for Review' },
      { 'Waiting For': 'Will to review the evidence' }, { 'Start Date': { start: '2030-01-01' } }]) {
      const source = snapshot([], [card(a, { ...values, 'Next check-in': { start: '2030-01-02' } })])
      expect(findings(source, 'legitimate-wait-planned')).toHaveLength(1)
      expect(findings(source, 'task-execution-gap')).toHaveLength(0)
      expect(reconcileScene(source, now).cards[0]?.checkpoint.at).toBe('2030-01-02')
    }
    expect(reconcileScene(snapshot([], [card(a, { 'Waiting For': 'Review by Will' })]), now).cards[0]?.nextAction).toBe('Review by Will')
    const waiting = task('worker', a, { current_state: { state: 'blocked', freshness: 'fresh', observed_at: at, detail: 'Waiting for read permission' } })
    expect(findings(snapshot([waiting]), 'legitimate-wait-planned')).toHaveLength(1)
  })

  it('requires current confirmed claims for worker waits while retaining candidate activity', () => {
    const waiting = { state: 'blocked', freshness: 'fresh', observed_at: at } as const
    const candidates = [
      task('candidate', null, { current_state: waiting, backlog: { title: 'Build reconciliation' } }),
      task('candidate', null, { current_state: waiting, cardReferences: cardReferences({ title: `card ${a}` }, 'task') }),
      task('candidate', null, { current_state: waiting, cardReferences: cardReferences({ notion_page_id: a, title: `card ${b}` }, 'task') }),
    ]
    for (const worker of candidates) {
      const scene = reconcileScene(expectedHome(snapshot([worker], [card(a), card(b)])), now)
      expect(scene.executions[0]?.activity).toBe('waiting')
      expect(scene.claims.length).toBeGreaterThan(0)
      expect(scene.claims.every(claim => claim.verification !== 'confirmed')).toBe(true)
      expect(scene.findings.some(f => f.kind === 'unverified-conflicting')).toBe(true)
      expect(scene.findings.some(f => f.kind === 'legitimate-wait-planned' || f.kind === 'task-execution-gap')).toBe(false)
    }
    const source = snapshot([task('confirmed', a, { current_state: waiting }), candidates[0]!])
    const confirmed = reconcileScene(source, now)
    expect(confirmed.findings.filter(f => f.kind === 'legitimate-wait-planned').map(f => f.executionIds))
      .toEqual([[confirmed.executions[0]!.id]])
    source.intentions.status = 'stale'
    const stale = reconcileScene(source, now)
    expect(stale.executions.every(execution => execution.activity === 'waiting')).toBe(true)
    expect(stale.claims.every(claim => claim.state === 'last-known')).toBe(true)
    expect(stale.findings.some(f => f.kind === 'legitimate-wait-planned' || f.kind === 'task-execution-gap')).toBe(false)
  })

  it('accounts for queued/held First Mate backlog without inventing an execution attempt', () => {
    const source = snapshot()
    source.fleet[0]!.observation.data!.backlog = [{ id: 'queued-work', title: 'Waiting on input', state: 'queued', kind: 'ship', repo: null,
      hold_reason: 'Need review', hold_until: null, blocked_by: null, captain_actionable: null, pr_url: null,
      cardReferences: [{ pageId: a, basis: 'explicit', source: 'backlog.notion_page_id' }] }]
    const explicit = reconcileScene(source, now)
    expect(explicit.claims).toHaveLength(0)
    expect(explicit.backlog[0]?.source.hold_reason).toBe('Need review')
    expect(explicit.findings.map(f => f.kind)).toEqual(['legitimate-wait-planned'])
    source.fleet[0]!.observation.data!.backlog![0]!.cardReferences[0]!.basis = 'textual'
    const textual = reconcileScene(source, now)
    expect(textual.findings.map(f => f.kind)).toEqual(['unverified-conflicting'])
  })

  it('keeps contradictory standalone backlog references unverified across accountability and waits', () => {
    for (const state of ['in_flight', 'queued']) for (const held of [false, true]) {
      const source = expectedHome(snapshot([], [card(a), card(b)]))
      const row = source.fleet[0]!.observation.data!.backlog![0]!
      row.state = state
      row.hold_reason = held ? 'Review required' : null
      row.cardReferences = cardReferences({ notion_page_id: a, title: `card ${b}` }, 'backlog')
      const scene = reconcileScene(source, now)
      expect(scene.claims).toEqual([])
      expect(scene.backlog[0]?.source.cardReferences).toEqual(row.cardReferences)
      expect(scene.findings.filter(f => f.kind === 'unverified-conflicting').flatMap(f => f.cardIds).sort()).toEqual([a, b].sort())
      expect(scene.findings.some(f => f.kind === 'task-execution-gap' || f.kind === 'legitimate-wait-planned')).toBe(false)
    }
  })

  it('labels human and PM Bot ownership outside execution coverage', () => {
    for (const owner of ['PM Bot', 'Will', 'Human']) {
      expect(findings(snapshot([], [card(a, { Owner: owner })]), 'outside-coverage')).toHaveLength(1)
      expect(findings(snapshot([], [card(a, { Owner: owner })]), 'task-execution-gap')).toHaveLength(0)
    }
  })

  it('only labels observed executing workers untracked after complete reads', () => {
    expect(findings(snapshot([task('untracked', null)]), 'untracked-worker')).toHaveLength(1)
    for (const state of ['unknown', 'done', 'idle', 'blocked', 'failed']) {
      const worker = task('untracked', null, { current_state: { state, freshness: 'fresh', observed_at: at } })
      expect(findings(snapshot([worker]), 'untracked-worker')).toHaveLength(0)
    }
    expect(findings(snapshot([task('manager', null, { kind: 'secondmate' })]), 'untracked-worker')).toHaveLength(0)
  })

  it('suppresses absence with unavailable, partial, stale or expired sources', () => {
    for (const target of ['fleet', 'notion']) for (const status of ['unknown', 'partial', 'stale', 'expired']) {
      const source = expectedHome(snapshot([task('untracked', null)]))
      const obs = target === 'fleet' ? source.fleet[0]!.observation : source.intentions
      if (status === 'expired') obs.expiresAt = new Date(now - 1).toISOString()
      else { obs.status = status as 'unknown' | 'partial' | 'stale'; obs.coverage = status === 'partial' ? 'partial' : 'unknown' }
      const scene = reconcileScene(source, now)
      expect(scene.coverage.absenceConclusions).toBe('suppressed')
      expect(scene.findings.some(f => f.kind === 'untracked-worker' || f.kind === 'task-execution-gap')).toBe(false)
      expect(scene.findings.some(f => f.kind === 'unknown-stale-source')).toBe(true)
      expect(scene.executions).toHaveLength(1)
    }
    expect(findings({ ...snapshot(), fleet: [] }, 'task-execution-gap')).toHaveLength(0)
  })

  it('retains last-known data and does not confuse unknown runtime with metadata freshness', () => {
    const source = snapshot([task('worker', null, { current_state: { state: 'unknown', freshness: 'fresh', observed_at: at } })])
    const scene = reconcileScene(source, now)
    expect(scene.executions[0]?.activity).toBe('unknown')
    expect(scene.coverage.absenceConclusions).toBe('suppressed')
    expect(findings(source, 'task-execution-gap')).toHaveLength(0)
    source.fleet[0]!.observation.status = 'stale'
    expect(reconcileScene(source, now).executions).toHaveLength(1)
    const explicit = snapshot([task()]); explicit.intentions.status = 'stale'
    expect(reconcileScene(explicit, now).claims[0]?.state).toBe('last-known')
  })

  it('does not label a worker with unknown placement untracked', () => {
    const source = snapshot([task('worker', null)])
    source.fleet[0]!.source.machine = undefined
    expect(findings(source, 'untracked-worker')).toHaveLength(0)
    expect(findings(source, 'unknown-stale-source').length).toBeGreaterThan(0)
  })

  it('does not confirm IDs missing from Notion or execution identity', () => {
    const source = snapshot([task('worker', b)])
    expect(reconcileScene(source, now).claims[0]).toMatchObject({ verification: 'unverified' })
    expect(findings(source, 'untracked-worker')).toHaveLength(0)
    source.fleet[0]!.observation.data!.tasks[0]!.identity.spawn_gen = null
    expect(reconcileScene(source, now).claims[0]?.verification).toBe('conflicting')
    expect(findings(source, 'task-execution-gap')).toHaveLength(0)
  })
})

describe('arrangement data and rollups', () => {
  it('groups the same records by real Parent item chain, home and machine with deduplicated counts', () => {
    const source = snapshot([task(), task('helper')], [card(a, { 'Parent item': [b] }), card(b, { Name: 'Epic', 'Parent item': [c], Status: 'Backlog' }), card(c, { Name: 'Initiative', Status: 'Backlog' })])
    source.fleet.push(home([task('remote', a, { identity: { fm_home: '/farm/kdf', task_id: 'remote', spawn_gen: 'one' }, remote: { host: 'observed-host', root: '/farm/child' } })], '/farm/kdf', 'bandit'))
    source.fleet[1]!.source.parentHome = '/farm/hulk'
    const scene = reconcileScene(source, now)
    expect(scene.cards.find(card => card.id === a)?.ancestry).toEqual([b, c])
    const initiative = scene.arrangements.initiative.find(group => group.label === 'Initiative')
    expect(initiative?.counts).toMatchObject({ cards: 3, workers: 3, attempts: 3, claims: 3 })
    expect(scene.arrangements.secondMate.filter(group => group.executionIds.length)).toHaveLength(2)
    expect(scene.arrangements.machine.find(group => group.label === 'observed-host')?.placements).toContainEqual({ machine: 'observed-host', basis: 'observed', configuredMachine: 'bandit' })
    expect(scene.claims.find(claim => claim.identity.task_id === 'remote')?.accountability.parentHome).toBe('/farm/hulk')
    for (const groups of Object.values(scene.arrangements)) {
      expect(new Set(groups.flatMap(g => g.cardIds))).toEqual(new Set([a, b, c]))
      expect(new Set(groups.flatMap(g => g.executionIds))).toEqual(new Set(scene.executions.map(e => e.id)))
    }
  })

  it('scopes conflicting worker claims to each card initiative while sharing execution membership', () => {
    const otherRoot = '40950ce6d42280b584d0000b877283da'
    const worker = task('worker', null, { cardReferences: cardReferences({ notion_page_id: a, title: `card ${b}` }, 'task') })
    const scene = reconcileScene(snapshot([worker], [
      card(a, { 'Parent item': [c] }), card(b, { 'Parent item': [otherRoot] }),
      card(c, { Name: 'X', Status: 'Backlog' }), card(otherRoot, { Name: 'Y', Status: 'Backlog' }),
    ]), now)
    for (const [label, child, root] of [['X', a, c], ['Y', b, otherRoot]]) {
      const group = scene.arrangements.initiative.find(g => g.label === label)!
      expect(new Set(group.cardIds)).toEqual(new Set([child, root]))
      expect(group.claimIds).toEqual(scene.claims.filter(claim => claim.cardId === child).map(claim => claim.id))
      expect(group.executionIds).toEqual(scene.executions.map(execution => execution.id))
      expect(group.counts).toMatchObject({ cards: 2, claims: 1, workers: 1, attempts: 1 })
    }
    for (const arrangement of ['secondMate', 'machine'] as const) {
      const group = scene.arrangements[arrangement].find(g => g.executionIds.length)!
      expect(new Set(group.cardIds)).toEqual(new Set([a, b]))
      expect(new Set(group.claimIds)).toEqual(new Set(scene.claims.map(claim => claim.id)))
      expect(group.counts).toMatchObject({ cards: 2, claims: 2, workers: 1, attempts: 1 })
    }
    expect(scene.counts).toMatchObject({ cards: 4, claims: 2, workers: 1, attempts: 1 })
  })

  it('keeps unassigned cards/workers and unreadable homes reachable, including unknown machines', () => {
    const source = snapshot([task('untracked', null)], [card(a, { Status: 'Backlog' })])
    source.fleet[0]!.source.machine = undefined
    source.fleet[0]!.source.machineBasis = 'unknown'
    const missing = home([], '/farm/missing', 'optimus')
    missing.observation = { ...missing.observation, status: 'unknown', coverage: 'unknown', data: null }
    source.fleet.push(missing)
    const scene = reconcileScene(source, now)
    for (const groups of Object.values(scene.arrangements)) {
      expect(groups.find(g => g.label === 'Unassigned / unknown')?.cardIds).toContain(a)
    }
    expect(scene.arrangements.machine.find(g => g.label === 'Unassigned / unknown')?.executionIds).toHaveLength(1)
    expect(scene.arrangements.secondMate.find(g => g.label === 'missing')?.homeIds).toEqual(['/farm/missing'])
    expect(scene.coverage.wholeFarm).toBe('not-certified')
    expect(scene.arrangements.secondMate.find(g => g.label === 'missing')?.counts.exceptions).toBe(1)
    expect(scene.findings.some(f => f.kind === 'untracked-worker')).toBe(false)
  })

  it('discloses missing and cyclic parents without inventing a hierarchy', () => {
    const missing = reconcileScene(snapshot([], [card(a, { 'Parent item': [b] })]), now)
    expect(missing.cards[0]?.hierarchyIssues[0]).toContain('unavailable')
    const cycle = reconcileScene(snapshot([], [card(a, { 'Parent item': [b] }), card(b, { 'Parent item': [a] })]), now)
    expect(cycle.cards.every(card => card.hierarchyIssues.some(issue => issue.includes('Cyclic')))).toBe(true)
    expect(new Set(cycle.arrangements.initiative.flatMap(g => g.cardIds))).toEqual(new Set([a, b]))
  })
})


describe('execution liveness', () => {
  const endpoint = (exists: boolean | null): Task['endpoint'] => ({ exists, agent_alive: null, status: null, observed_at: at, freshness: 'fresh' })
  it.each([
    ['running', true, 'working', null],
    ['running', true, 'unknown', 'working [at=1]: building'],
    ['running', true, 'unknown', 'resolved-to-working [at=1]: resumed'],
    ['running', true, 'unknown', 'resolved [at=1]: blocker cleared'],
    ['waiting', true, 'unknown', 'paused [at=1]: awaiting CI'],
    ['waiting', true, 'working', 'needs-decision [at=1]: review'],
    ['waiting', true, 'unknown', 'blocked [at=1]: input'],
    ['waiting', true, 'parked', null],
    ['waiting', true, 'unknown', 'held [at=1]: review'],
    ['finished', true, 'working', 'done [at=1]: completed with window open'],
    ['finished', false, 'unknown', 'landed [at=1]: merged'],
    ['finished', null, 'unknown', 'done [at=1]: completed'],
    ['absent', false, 'working', 'working [at=1]: old status'],
    ['running', null, 'working', 'working [at=1]: no endpoint observation'],
    ['liveness-not-observed', true, 'unknown', 'pausedness is not a status verb'],
  ] as const)('classifies %s from endpoint=%s state=%s event=%s', (expected, exists, state, event) => {
    const scene = reconcileScene(snapshot([task('codex-worker', null, { harness: 'codex', endpoint: endpoint(exists), current_state: { state }, lastEventText: event })]), now)
    expect(scene.executions[0]?.liveness).toBe(expected)
    expect(scene.counts[expected]).toBe(1)
    expect(scene.counts.running).toBe(expected === 'running' ? 1 : 0)
    expect(scene.findings.some(f => f.kind === 'untracked-worker')).toBe(expected === 'running')
    for (const groups of Object.values(scene.arrangements)) expect(groups.find(g => g.executionIds.length)?.counts[expected]).toBe(1)
  })

  it.each(['agent_alive', 'status'] as const)('rejects dead %s across event and state paths', field => {
    for (const event of ['working', 'resolved', 'resolved-to-working', 'waiting', 'blocked', null]) {
      for (const state of ['unknown', 'working', 'waiting']) {
        const scene = reconcileScene(snapshot([task('dead', a, {
          endpoint: { ...endpoint(true), [field]: 'dead' }, current_state: { state }, lastEventText: event,
        })]), now)
        expect(scene.executions[0]?.liveness).toBe('absent')
      }
    }
  })

  it.each(['working', 'waiting', 'parked', 'blocked', 'needs-decision', 'unknown'])('requires fresh directly observed state %s without endpoint evidence', state => {
    for (const freshness of ['fresh', 'stale', null]) {
      for (const source of ['pane', 'status-log', 'none', 'unknown', null]) {
        const scene = reconcileScene(snapshot([task('unobserved', a, {
          endpoint: endpoint(null), current_state: { state, freshness, source }, lastEventText: 'working [at=1]: old report',
        })]), now)
        const expected = freshness !== 'fresh' || source !== 'pane' || state === 'unknown'
          ? 'liveness-not-observed' : state === 'working' ? 'running' : 'waiting'
        expect(scene.executions[0]?.liveness).toBe(expected)
        expect(scene.counts[expected]).toBe(1)
        if (expected === 'liveness-not-observed') {
          expect(scene.findings.some(f => f.kind === 'task-execution-gap' || f.kind === 'untracked-worker')).toBe(false)
        }
      }
    }
  })

  it.each([
    'done [key=child-outcome-child-done-05b032a1] [at=1]: child child done: complete',
    'done [key=inactive-outcome-mate-child-done] [at=1]: inactive terminal child=child fingerprint=abc',
  ])('does not finish a manager reporting %s', raw => {
    for (const hint of [raw, null]) {
      for (const [state, source, expected] of [['working', 'pane', 'running'], ['waiting', 'pane', 'waiting'], ['done', 'status-log', 'liveness-not-observed']] as const) {
        const scene = reconcileScene(snapshot([task('mate', a, {
          kind: 'secondmate', current_state: { state, source }, lastEventText: hint,
          last_event: { raw, state: 'done', note: 'child complete', age_seconds: 1 },
        })]), now)
        expect(scene.executions[0]?.liveness).toBe(expected)
      }
    }
  })

  it('uses structured status events when the text hint is absent', () => {
    const scene = reconcileScene(snapshot([task('codex', a, { current_state: { state: 'unknown' }, last_event: { raw: null, state: 'paused', note: 'working later', age_seconds: 3 } })]), now)
    expect(scene.executions[0]?.liveness).toBe('waiting')
    expect(scene.findings.some(f => f.kind === 'legitimate-wait-planned')).toBe(true)
  })

  it('does not treat finished records as live execution or unknown liveness as an evidenced gap', () => {
    const finished = task('finished', a, { lastEventText: 'done [at=1]: complete' })
    const completed = reconcileScene(snapshot([finished]), now)
    expect(completed.findings.some(f => f.kind === 'task-execution-gap')).toBe(true)
    expect(completed.counts).toMatchObject({ running: 0, waiting: 0, finished: 1 })
    const unknown = task('unknown', a, { endpoint: endpoint(null), current_state: { freshness: 'stale' } })
    const unobserved = reconcileScene(snapshot([unknown]), now)
    expect(unobserved.findings.some(f => f.kind === 'task-execution-gap' || f.kind === 'untracked-worker')).toBe(false)
    expect(unobserved.coverage.absenceConclusions).toBe('suppressed')
  })
})
