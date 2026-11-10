import { retainedQueueItemId } from '../../shared/reconciliationQueue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceSnapshot } from './index'
import { ReconciliationSources, handleReconciliationRequest } from './index'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../api/originAllowlist'
import { buildQueue } from './queue'
import { QueuePullReader, type PullReadiness } from './queuePulls'
import { PullsApi } from '../pulls/routes'
import { CardContextReader } from './cardContext'
import { queueSignals } from './queueInputs'
import { needsWill } from './needsWill'
import { reconcileScene } from './scene'
import type { Observation } from './observation'

type FleetData = NonNullable<SourceSnapshot['fleet'][number]['observation']['data']>
type Task = FleetData['tasks'][number]
type Backlog = NonNullable<FleetData['backlog']>[number]
type Card = NonNullable<SourceSnapshot['intentions']['data']>['cards'][number]
const now = Date.parse('2026-11-03T20:00:00Z')
const at = new Date(now).toISOString()
const expiresAt = new Date(now + 60_000).toISOString()
const a = '40d50ce6d422814aa741c102cd00aaae'
const b = '30950ce6d42280d3a541cbd66c274f6a'
const pull = 'https://github.com/except-pass/tinstar/pull/999'
const obs = <T>(data: T): Observation<T> => ({ data, status: 'fresh', coverage: 'complete', observedAt: at, attemptedAt: at, expiresAt, error: null })
function card(values: Record<string, unknown> = {}, id = a): Card {
  return { id, url: `https://www.notion.so/${id}`, last_edited_time: at, archived: false, in_trash: false,
    properties: Object.fromEntries(Object.entries({ Name: 'Some Will mention', Status: 'In Progress', Owner: 'Firstmate', 'Will action': [], ...values }).map(([name, value]) => [name, { id: name, type: 'select', hasMore: false, value }])) }
}
function task(decisions: unknown[] = [{ key: 'choose', verb: 'needs-decision', summary: 'Choose A or B' }], id = 'worker'): Task {
  return { id, kind: 'ship', harness: null, model: null, branch: null, project: null, spawn_gen: 'attempt-1', backend: null, remote: null,
    identity: { fm_home: '/farm/hulk', task_id: id, spawn_gen: 'attempt-1' }, cardReferences: [],
    current_state: { state: 'unknown', source: 'pane', detail: null, observed_at: at, freshness: 'fresh' },
    endpoint: { exists: true, agent_alive: null, status: null, observed_at: at, freshness: 'fresh' }, paths: { home: null, worktree: null }, lastEventText: null,
    last_event: { raw: null, state: null, note: null, age_seconds: null }, pr: { url: null, head: null, source: null },
    backlog: { id, title: 'Work', state: 'in_flight', hold_reason: null, blocked_by: null, hold_until: null }, ...queueSignals({ hints: { open_decisions: decisions } }) }
}
function hold(values: Partial<Backlog> = {}): Backlog {
  return { id: 'hold', title: 'Work', state: 'held', kind: 'ship', repo: null, hold_reason: 'Choose A or B', hold_until: null, blocked_by: null,
    captain_actionable: true, pr_url: null, cardReferences: [], ...queueSignals({ hold_kind: 'captain' }), ...values }
}
function snapshot(cards: Card[] = [], tasks: Task[] = [], backlog: Backlog[] = []): SourceSnapshot {
  return { generatedAt: at, scope: 'configured-homes-only', warnings: [], intentions: obs({ dataSourceId: a, schema: {}, cards, hasMore: false, truncatedRelations: [], missingSchemaProperties: [], scope: 'configured-source' }),
    fleet: [{ source: { home: '/farm/hulk', machine: 'hulk', machineBasis: 'configured' }, observation: obs({ schema: 'fm-fleet-snapshot.v1', fm_home: '/farm/hulk', generated: at,
      coverageScope: 'metadata', main_inventory: { valid: true, reason: null, unstructured_current_count: null }, backlogPresent: true,
      ledger: { role: 'change-signal-only', cursor: null, scope: 'local-file-stat' }, tasks, backlog }) }] }
}
const build = (s: SourceSnapshot, prs = new Map<string, PullReadiness>()) => buildQueue(s, prs, now)
const readyPull = (values: Partial<PullReadiness> = {}): PullReadiness => ({ status: 'fresh', observedAt: at, expiresAt, state: 'open', head: 'a'.repeat(40), draft: false, checks: 'passed', mergeability: 'ready', ...values })
const mergeCard = (values = {}) => card({ Owner: 'Will', 'Will action': ['Merge'], 'Next action': 'Merge this PR', Link: pull, ...values })
afterEach(() => { vi.useRealTimers(); resetOriginAllowlistForTests() })

describe('desk queue correctness', () => {
  it('does not turn a title mention, tag, owner or checkpoint alone into immediate work', () => {
    const result = build(snapshot([card(), card({ 'Will action': ['Merge'] }, b), card({ Owner: 'Will', 'Next check-in': { start: '2026-11-01' } }, 'a'.repeat(32))]))
    expect(result.items).toHaveLength(2)
    expect(result.items.every(item => item.readiness === 'needs-readiness-verification' && !item.oneTouch)).toBe(true)
  })

  it('accepts an explicit owner next action; checkpoint changes only ordering', () => {
    const s = snapshot([card({ Owner: 'Will', 'Next action': 'Choose the color', 'Next check-in': { start: '2026-12-01' } })])
    expect(build(s).items[0]).toMatchObject({ readiness: 'ready-now', action: 'Choose the color', oneTouch: true })
    s.intentions.data!.cards[0]!.properties['Next check-in']!.value = { start: '2026-10-01' }
    expect(build(s).items[0]?.readiness).toBe('ready-now')
  })

  it.each(['Done', 'Archived', 'Completed', 'Answered', 'Resolved'])('excludes %s cards and their retained worker calls', Status => {
    const worker = task(); worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    expect(build(snapshot([card({ Owner: 'Will', 'Will action': ['Decision'], Status })], [worker])).items).toEqual([])
  })

  it.each(['Backlog', 'Queued', 'Planned', 'Todo'])('retains %s in its work context without immediate work', Status => {
    expect(build(snapshot([mergeCard({ Status })])).items[0]).toMatchObject({ readiness: 'future-or-conditional', cardIds: [a], oneTouch: false })
  })

  it('keeps future starts, release dependencies and waiting status conditional', () => {
    for (const values of [{ 'Start Date': { start: '2026-12-01' } }, { 'Waiting For': 'Release validation on Hulk' }, { Status: 'Waiting For' }]) {
      expect(build(snapshot([mergeCard(values)]), new Map([[pull, readyPull()]])).items[0]?.readiness).toBe('future-or-conditional')
    }
  })

  it('requires verified PR readiness and drops closed/merged actions', () => {
    const s = snapshot([mergeCard()])
    expect(build(s).items[0]?.readiness).toBe('needs-readiness-verification')
    expect(build(s, new Map([[pull, readyPull()]])).items[0]).toMatchObject({ kind: 'merge', readiness: 'ready-now', oneTouch: true })
    for (const state of ['merged', 'closed'] as const) expect(build(s, new Map([[pull, readyPull({ state })]])).items).toEqual([])
    for (const values of [{ draft: true }, { checks: 'pending' as const }, { checks: 'failed' as const }, { mergeability: 'blocked' as const }]) {
      expect(build(s, new Map([[pull, readyPull(values)]])).items[0]?.readiness).toBe('future-or-conditional')
    }
    for (const values of [{ status: 'stale' as const }, { checks: 'unknown' as const }, { mergeability: 'unknown' as const }]) {
      expect(build(s, new Map([[pull, readyPull(values)]])).items[0]?.readiness).toBe('needs-readiness-verification')
    }
  })

  it('handles missing, unsupported and ambiguous PR evidence honestly', () => {
    for (const Link of [null, 'javascript:alert(1)', 'https://example.com/a']) {
      expect(build(snapshot([mergeCard({ Link })])).items[0]?.readiness).toBe('needs-readiness-verification')
    }
    const result = build(snapshot([mergeCard({ Evidence: 'https://github.com/except-pass/tinstar/pull/998' })]))
    expect(result.items[0]?.readiness).toBe('needs-readiness-verification')
    expect(JSON.stringify(build(snapshot([mergeCard({ Link: 'https://secret:password@example.com/' })])))).not.toContain('password')
  })

  it('uses open decision keys and explicitly captain-actionable holds; blocked/held alone needs verification', () => {
    expect(build(snapshot([], [task()])).items[0]).toMatchObject({ readiness: 'needs-readiness-verification', decisionKeys: ['choose'], oneTouch: false })
    expect(build(snapshot([], [], [hold()])).items[0]?.readiness).toBe('ready-now')
    const unkeyed = task([]); unkeyed.current_state.state = 'needs-decision'
    expect(build(snapshot([], [unkeyed])).items[0]?.readiness).toBe('needs-readiness-verification')
    for (const s of [snapshot([], [], [hold({ captain_actionable: false })]), snapshot([], [task([{ key: 'block', verb: 'blocked', summary: 'Needs review' }])]), snapshot([], [task([{ verb: 'needs-decision', summary: 'No explicit key' }])])]) {
      expect(build(s).items[0]?.readiness).toBe('needs-readiness-verification')
    }
  })

  it('does not route an unrelated worker question through card ownership', () => {
    const worker = task([{ key: 'formatter', verb: 'needs-decision', summary: 'Choose the formatter' }])
    worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    const result = build(snapshot([card({ Owner: 'Will', 'Next action': 'Review proposal' })], [worker]))
    expect(result.items.find(item => item.decisionKeys.includes('formatter'))).toMatchObject({
      action: 'Choose the formatter', readiness: 'needs-readiness-verification', oneTouch: false,
    })
    expect(result.items.find(item => item.action === 'Review proposal')?.readiness).toBe('ready-now')
  })

  it.each(['worker', 'worker-decision-formatter', 'origin-hold'])('does not route formatter through unrelated hold %s', id => {
    const worker = task([{ key: 'formatter', verb: 'needs-decision', summary: 'Choose the formatter' }])
    const held = hold({ id, hold_reason: 'Review proposal', ...queueSignals({ hold_kind: 'captain', body_lines: ['Origin: worker'] }) })
    const result = build(snapshot([], [worker], [held]))
    expect(result.items.find(item => item.decisionKeys.includes('formatter'))).toMatchObject({
      action: 'Choose the formatter', readiness: 'needs-readiness-verification', oneTouch: false,
    })
    expect(result.items.find(item => item.decisionKeys.includes(id))).toMatchObject({ action: 'Review proposal', readiness: 'ready-now' })
  })

  it('requires exact request identity even when a same-task hold has identical text', () => {
    const result = build(snapshot([], [task()], [hold({ id: 'worker' })]))
    expect(result.items.find(item => item.decisionKeys.includes('choose'))).toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false })
    expect(result.items).toHaveLength(2)
  })

  it('routes a keyed decision only through its exact owner-actionable hold', () => {
    for (const captain_actionable of [true, false]) {
      const result = build(snapshot([], [task()], [hold({ id: 'choose', captain_actionable })]))
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({ decisionKeys: ['choose'], readiness: captain_actionable ? 'ready-now' : 'needs-readiness-verification', oneTouch: captain_actionable })
    }
  })

  it('retains separate source targets for an identical question and same-task hold', () => {
    const result = build(snapshot([], [task()], [hold({ id: 'worker' })]))
    expect(result.items).toHaveLength(2)
    const requests = result.items.flatMap(item => item.sources.flatMap(source => source.request ? [source.request] : []))
    expect(requests).toEqual(expect.arrayContaining([
      { home: '/farm/hulk', taskId: 'worker', id: 'choose', kind: 'decision' },
      { home: '/farm/hulk', taskId: 'worker', id: 'worker', kind: 'hold' },
    ]))
  })

  it('does not promote or combine two workers sharing a bare decision key', () => {
    const first = task(), second = task(undefined, 'second')
    first.cardReferences = second.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    const result = build(snapshot([card({ Owner: 'Will', 'Next action': 'Choose A or B' })], [first, second], [hold({ id: 'choose' })]))
    expect(result.items).toHaveLength(4)
    const questions = result.items.flatMap(item => item.sources).filter(source => source.request?.kind === 'decision')
    expect(questions.map(source => source.request?.taskId).sort()).toEqual(['second', 'worker'])
    expect(questions.every(source => source.readiness === 'needs-readiness-verification' && !source.responseAnchor)).toBe(true)
  })

  it('binds a shared key to only the hold’s explicitly named origin task', () => {
    const held = hold({ id: 'choose', ...queueSignals({ hold_kind: 'captain', body_lines: ['Origin: worker'] }) })
    const result = build(snapshot([], [task(), task(undefined, 'second')], [held]))
    expect(result.items).toHaveLength(2)
    const matched = result.items.find(item => item.readiness === 'ready-now')!
    expect(matched.sources.map(source => source.request)).toEqual(expect.arrayContaining([
      { home: '/farm/hulk', taskId: 'worker', id: 'choose', kind: 'decision' },
      { home: '/farm/hulk', taskId: 'worker', id: 'choose', kind: 'hold' },
    ]))
    expect(matched.sources.filter(source => source.request).every(source => source.readiness === 'ready-now' && source.responseAnchor)).toBe(true)
    const unrelated = result.items.find(item => item.readiness !== 'ready-now')!
    expect(unrelated.sources[0]?.request?.taskId).toBe('second')
    expect(unrelated.sources[0]?.responseAnchor).toBeUndefined()
  })

  it('never merges a card and question just because the owner action has identical text', () => {
    const worker = task(); worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    const result = build(snapshot([card({ Owner: 'Will', 'Next action': 'Choose A or B' })], [worker]))
    expect(result.items).toHaveLength(2)
    const question = result.items.find(item => item.decisionKeys.includes('choose'))!
    expect(question.sources.filter(source => source.request)).toHaveLength(1)
    expect(question.sources[0]).toMatchObject({ readiness: 'needs-readiness-verification', request: { home: '/farm/hulk', taskId: 'worker', id: 'choose', kind: 'decision' } })
    expect(question.sources[0]?.responseAnchor).toBeUndefined()
  })

  it('preserves source readiness when an explicit PR matches a ready card and unrouted question', () => {
    const worker = task([{ key: 'choose', verb: 'needs-decision', summary: `Review ${pull}` }])
    const result = build(snapshot([card({ Owner: 'Will', 'Next action': 'Review proposal', Link: pull })], [worker]))
    expect(result.items).toHaveLength(1)
    const sources = result.items[0]!.sources
    expect(sources.find(source => source.kind === 'notion')).toMatchObject({ readiness: 'ready-now', request: { home: null, taskId: null, id: a, kind: 'notion-card' } })
    expect(sources.find(source => source.kind === 'firstmate')).toMatchObject({ readiness: 'needs-readiness-verification' })
    expect(sources.find(source => source.kind === 'firstmate')?.responseAnchor).toBeUndefined()
  })

  it('deduplicates a request/PR bridge transitively while preserving all exact source identities', () => {
    const worker = task([{ key: 'choose', verb: 'needs-decision', summary: 'Choose A or B' }])
    const held = hold({ id: 'choose', pr_url: pull })
    const result = build(snapshot([card({ Owner: 'Will', 'Next action': 'Choose A or B', Link: pull })], [worker], [held]))
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.sources.filter(source => source.request)).toHaveLength(3)
    expect(new Set(result.items[0]?.sources.filter(source => source.request).map(source => source.id)).size).toBe(3)
  })

  it('honors hold timing, blockers, completion, and disappearance of answered keys', () => {
    expect(build(snapshot([], [], [hold({ hold_until: '2026-12-01' })])).items[0]?.readiness).toBe('future-or-conditional')
    expect(build(snapshot([], [], [hold({ blocked_by: 'release' })])).items[0]?.readiness).toBe('future-or-conditional')
    expect(build(snapshot([], [], [hold({ hold_until: 'after release' })])).items[0]?.readiness).toBe('needs-readiness-verification')
    expect(build(snapshot([], [], [hold({ state: 'done' })])).items).toEqual([])
    const worker = task(); expect(build(snapshot([], [worker])).items).toHaveLength(1)
    worker.queue!.decisions = []; expect(build(snapshot([], [worker])).items).toEqual([])
    worker.queue = queueSignals({ merged: true, hints: { open_decisions: [{ key: 'old', verb: 'needs-decision', summary: 'Old call' }] } }).queue
    expect(build(snapshot([], [worker])).items).toEqual([])
  })

  it('does not resurrect a completed decision through its same-ID hold', () => {
    const worker = task(); worker.queue!.completed = true
    const held = hold({ id: 'choose', hold_reason: 'Captain still has this request' })
    expect(build(snapshot([], [worker], [held])).items).toEqual([])

    // A blocked status cannot represent the distinct captain request.
    worker.queue!.decisions[0]!.verb = 'blocked'
    expect(build(snapshot([], [worker], [held])).items).toMatchObject([
      { action: 'Captain still has this request', decisionKeys: ['choose'] },
    ])
  })

  it('deduplicates exact keyed calls and captain holds using First Mate hold identity', () => {
    const worker = task([{ key: 'hold', verb: 'needs-decision', summary: 'Choose A or B' }])
    expect(build(snapshot([], [worker], [hold()])).items).toHaveLength(1)
    const origin = hold({ id: 'origin-hold', ...queueSignals({ hold_kind: 'captain', body_lines: ['Origin: worker'] }) })
    expect(build(snapshot([], [task()], [origin])).items).toHaveLength(2)
  })

  it('deduplicates a Notion and First Mate merge request by canonical PR identity', () => {
    const worker = task([{ key: 'merge', verb: 'needs-decision', summary: 'Merge this PR' }]); worker.pr.url = `${pull}/`
    worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    const result = build(snapshot([mergeCard()], [worker], [hold({ id: 'merge', hold_reason: 'Merge this PR', pr_url: pull })]), new Map([[pull, readyPull()]]))
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ readiness: 'ready-now', cardIds: [a], homeIds: ['/farm/hulk'], decisionKeys: ['merge'] })
    expect(result.items[0]?.sources.map(s => s.kind)).toEqual(expect.arrayContaining(['firstmate', 'notion', 'github']))
  })

  it('uses a real First Mate request to corroborate a tag-only Notion merge candidate', () => {
    const worker = task([{ key: 'merge', verb: 'needs-decision', summary: 'Merge this PR' }]); worker.pr.url = pull
    worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    expect(build(snapshot([mergeCard({ 'Next action': null, Owner: 'Firstmate' })], [worker], [hold({ id: 'merge', hold_reason: 'Merge this PR', pr_url: pull })]), new Map([[pull, readyPull()]])).items[0])
      .toMatchObject({ action: 'Merge this PR', readiness: 'ready-now', oneTouch: true })
  })

  it('retains textually conditional and multi-step actions until prerequisites are verified', () => {
    for (const action of ['Merge after release', 'Merge when CI passes', 'Merge tomorrow', 'Merge if approved']) {
      expect(build(snapshot([mergeCard({ 'Next action': action })]), new Map([[pull, readyPull()]])).items[0]?.readiness).toBe('future-or-conditional')
    }
    expect(build(snapshot([mergeCard({ 'Next action': 'Review then merge' })]), new Map([[pull, readyPull()]])).items[0]?.readiness).toBe('needs-readiness-verification')
    const s = snapshot([mergeCard()])
    expect(build(s, new Map([[pull, readyPull({ expiresAt: at })]])).items[0]?.readiness).toBe('needs-readiness-verification')
    const worker = task([{ key: 'merge', verb: 'needs-decision', summary: 'Merge this PR' }]); worker.pr.url = pull; worker.pr.head = 'b'.repeat(40)
    expect(build(snapshot([], [worker]), new Map([[pull, readyPull()]])).items[0]?.readiness).toBe('needs-readiness-verification')
  })

  it.each([false, true])('preserves merge prerequisites across source orders: %s', reverse => {
    const actions = (reverse ? ['Merge after release', 'Merge this PR'] : ['Merge this PR', 'Merge after release']).map(action => `${action} ${pull}`)
    const worker = task([{ key: 'merge', verb: 'needs-decision', summary: actions[1] }]); worker.pr.url = pull
    const result = build(snapshot([mergeCard({ 'Next action': actions[0] })], [worker]), new Map([[pull, readyPull()]]))
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ readiness: 'future-or-conditional', oneTouch: false })
    const other = task([{ key: 'other', verb: 'needs-decision', summary: actions[1] }], 'other'); other.pr.url = pull
    const first = task([{ key: 'first', verb: 'needs-decision', summary: actions[0] }]); first.pr.url = pull
    expect(build(snapshot([], [first, other].reverse()), new Map([[pull, readyPull()]])).items[0])
      .toMatchObject({ readiness: 'future-or-conditional', oneTouch: false })
    expect(build(snapshot([mergeCard({ 'Next action': actions[0] }), card({ Owner: 'Will', 'Will action': ['Merge'], 'Next action': actions[1], Link: pull }, b)]), new Map([[pull, readyPull()]])).items[0])
      .toMatchObject({ readiness: 'future-or-conditional', oneTouch: false })
  })

  it.each(['Decide if we should ship', 'Choose when to launch'])('keeps decision subjects actionable: %s', action => {
    expect(build(snapshot([card({ Owner: 'Will', 'Next action': action })])).items[0])
      .toMatchObject({ readiness: 'ready-now', oneTouch: true })
    expect(build(snapshot([], [task([{ key: 'subject', verb: 'needs-decision', summary: action }])], [hold({ id: 'subject', hold_reason: action })])).items[0])
      .toMatchObject({ readiness: 'ready-now', oneTouch: true })
  })

  it.each(['Decide if we should ship after release', 'Choose when to launch once approved'])('retains prerequisites after a decision subject: %s', action => {
    expect(build(snapshot([card({ Owner: 'Will', 'Next action': action })])).items[0]?.readiness).toBe('future-or-conditional')
    expect(build(snapshot([], [task([{ key: 'subject', verb: 'needs-decision', summary: action }])], [hold({ id: 'subject', hold_reason: action })])).items[0]?.readiness).toBe('future-or-conditional')
  })

  it.each(['task', 'hold'] as const)('requires an unambiguous explicit completed-card relationship on %s', location => {
    for (const references of [
      [{ pageId: a, basis: 'textual' as const, source: 'backlog.raw' }],
      [{ pageId: a, basis: 'explicit' as const, source: 'notion_page_id' }, { pageId: b, basis: 'textual' as const, source: 'backlog.raw' }],
    ]) {
      const worker = task(); const held = hold()
      if (location === 'task') worker.cardReferences = references
      else held.cardReferences = references
      const result = build(snapshot([card({ Status: 'Done', 'Waiting For': 'release' }), card({ Status: 'Planned' }, b)], location === 'task' ? [worker] : [], location === 'hold' ? [held] : []))
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({ readiness: 'needs-readiness-verification', cardIds: [], oneTouch: false })
    }
    const held = hold({ cardReferences: [{ pageId: a, basis: 'explicit', source: 'notion_page_id' }] })
    expect(build(snapshot([card({ Status: 'Done' })], [], [held])).items).toEqual([])
  })

  it.each(['stale', 'expired'] as const)('retains %s completion evidence for verification', mode => {
    const stale = <T>(observation: Observation<T>) => {
      if (mode === 'stale') observation.status = 'stale'
      else observation.expiresAt = at
    }
    for (const values of [{}, { archived: true }, { in_trash: true }]) {
      const completed = card({ Owner: 'Will', 'Next action': 'Choose A or B', Status: 'Done' })
      Object.assign(completed, values)
      const worker = task(); worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
      const s = snapshot([completed], [worker]); stale(s.intentions)
      const result = build(s)
      // Card membership plus identical action text is context, not request identity.
      expect(result.items).toHaveLength(2)
      expect(result.items.every(item => item.readiness === 'needs-readiness-verification' && !item.oneTouch)).toBe(true)
      expect(result.items.find(item => item.decisionKeys.includes('choose'))).toBeTruthy()
      expect(build({ ...s, fleet: [] }).items[0]).toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false })
    }
    for (const completion of ['task-signal', 'task-backlog', 'runtime', 'hold-signal', 'hold-state'] as const) {
      const worker = task(); const held = hold({ id: 'choose' })
      if (completion === 'task-signal') worker.queue!.completed = true
      if (completion === 'task-backlog') worker.backlog.state = 'done'
      if (completion === 'runtime') worker.current_state.state = 'done'
      if (completion === 'hold-signal') held.queue!.completed = true
      if (completion === 'hold-state') held.state = 'done'
      const s = snapshot([], [worker], [held]); stale(s.fleet[0]!.observation)
      expect(build(s).items[0]).toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false })
      s.fleet[0]!.observation = obs(s.fleet[0]!.observation.data!)
      expect(build(s).items).toEqual([])
    }
    const s = snapshot([], [], [hold({ state: 'done' })]); stale(s.fleet[0]!.observation)
    expect(build(s).items[0]).toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false })
  })

  it.each(['exact', 'legacy', 'published', 'task-text', 'origin-text'] as const)('retains prerequisites without treating %s hold fallback as identity', route => {
    const key = route === 'published' ? 'captain-hold-release-123' : 'merge'
    const summary = route.endsWith('text') ? 'Merge after release' : 'Merge this PR'
    const id = route === 'exact' ? key : route === 'legacy' ? `worker-decision-${key}` : route === 'published' ? 'release' : route === 'task-text' ? 'worker' : 'origin-hold'
    const worker = task([{ key, verb: 'needs-decision', summary }]); worker.pr.url = pull
    const held = hold({ id, hold_reason: 'Merge after release', pr_url: pull,
      ...queueSignals({ hold_kind: 'captain', body_lines: route === 'origin-text' ? ['Origin: worker'] : [] }) })
    const result = build(snapshot([], [worker], [held]), new Map([[pull, readyPull()]]))
    expect(result.items).toHaveLength(route === 'exact' ? 1 : 2)
    expect(result.items.find(item => item.sources.some(source => source.request?.kind === 'hold'))).toMatchObject({ readiness: 'future-or-conditional', oneTouch: false })
    expect(result.items.find(item => item.sources.some(source => source.request?.kind === 'decision'))?.sources.find(source => source.kind === 'firstmate')?.readiness).not.toBe('ready-now')
    held.hold_reason = summary === 'Merge this PR' ? 'Review then merge' : summary
    if (summary === 'Merge this PR') expect(build(snapshot([], [worker], [held]), new Map([[pull, readyPull()]])).items[0])
      .toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false })
  })

  it.each(['Next action', 'Next Action'])('preserves linked %s restrictions without a Notion queue candidate', field => {
    for (const route of ['task', 'hold'] as const) {
      const worker = task([{ key: 'merge', verb: 'needs-decision', summary: 'Merge this PR' }]); worker.pr.url = pull
      const held = hold({ id: 'merge', hold_reason: 'Merge this PR', pr_url: pull })
      const refs = [{ pageId: a, basis: 'explicit' as const, source: 'notion_page_id' }]
      if (route === 'task') worker.cardReferences = refs
      else held.cardReferences = refs
      const linked = card({ [field]: 'Merge after release' })
      const s = snapshot([linked], route === 'task' ? [worker] : [], route === 'hold' ? [held] : [])
      expect(build(s, new Map([[pull, readyPull()]])).items).toEqual([
        expect.objectContaining({ readiness: 'future-or-conditional', oneTouch: false, cardIds: [a] }),
      ])
      linked.properties[field]!.value = 'Review then merge'
      expect(build(s, new Map([[pull, readyPull()]])).items[0]).toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false })
      linked.properties[field]!.value = 'Merge this PR'
      expect(build(s, new Map([[pull, readyPull()]])).items[0]).toMatchObject({ readiness: route === 'hold' ? 'ready-now' : 'needs-readiness-verification', oneTouch: route === 'hold' })
    }
  })

  it('preserves restrictions when both next-action properties are published', () => {
    const worker = task([{ key: 'merge', verb: 'needs-decision', summary: 'Merge this PR' }]); worker.pr.url = pull
    worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    for (const Owner of ['Will', 'Firstmate']) {
      const linked = card({ Owner, 'Next action': 'Merge this PR', 'Next Action': 'Merge after release', Link: pull })
      const items = build(snapshot([linked], [worker]), new Map([[pull, readyPull()]])).items
      expect(items).toHaveLength(Owner === 'Will' ? 2 : 1)
      expect(items.every(item => item.readiness === 'future-or-conditional' && !item.oneTouch)).toBe(true)
    }
  })

  it.each(['keyed', 'unkeyed', 'blocked', 'hold'] as const)('preserves task backlog restrictions for %s calls', route => {
    const worker = task(route === 'unkeyed' || route === 'hold' ? [] : [{ key: 'merge', verb: route === 'blocked' ? 'blocked' : 'needs-decision', summary: 'Merge this PR' }])
    worker.pr.url = pull; worker.backlog.hold_reason = 'Merge after release'
    if (route === 'unkeyed') { worker.current_state.state = 'needs-decision'; worker.current_state.detail = 'Merge this PR' }
    const held = hold({ id: 'worker', hold_reason: 'Merge this PR', pr_url: pull })
    const s = snapshot([], [worker], route === 'hold' ? [held] : [])
    expect(build(s, new Map([[pull, readyPull()]])).items).toEqual([
      expect.objectContaining({ readiness: 'future-or-conditional', oneTouch: false }),
    ])
  })

  it.each(['textual', 'conflicting'] as const)('does not apply linked action restrictions through %s references', relationship => {
    const worker = task([{ key: 'merge', verb: 'needs-decision', summary: 'Merge this PR' }]); worker.pr.url = pull
    worker.cardReferences = relationship === 'textual'
      ? [{ pageId: a, basis: 'textual', source: 'task.backlog.raw' }]
      : [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }, { pageId: b, basis: 'explicit', source: 'backlog.notion_page_id' }]
    const s = snapshot([card({ 'Next action': 'Merge after release' }), card({}, b)], [worker])
    expect(build(s, new Map([[pull, readyPull()]])).items).toEqual([
      expect.objectContaining({ readiness: 'needs-readiness-verification', oneTouch: false, cardIds: [] }),
    ])
  })

  it.each(['task', 'matched-hold', 'standalone-hold'] as const)('verifies every published hold time on %s', route => {
    for (const [timing, readiness] of [
      ['after release', 'needs-readiness-verification'],
      ['2026-12-01T00:00:00Z', 'future-or-conditional'],
      ['2026-10-01T00:00:00Z', 'ready-now'],
      [null, 'ready-now'],
    ] as const) {
      const worker = task()
      const held = hold({ id: 'choose' })
      if (route === 'task') worker.backlog.hold_until = timing
      else held.hold_until = timing
      const s = snapshot([], route === 'standalone-hold' ? [] : [worker], [held])
      expect(build(s).items).toEqual([expect.objectContaining({ readiness, oneTouch: readiness === 'ready-now' })])
    }
  })

  it.each(['none', 'card', 'holds', 'pull'] as const)('preserves distinct blocked keys with shared %s context', context => {
    const summaries = context === 'card' ? ['Need access', 'Need access'] : context === 'pull' ? ['Merge this PR', 'Merge this PR'] : ['Need repository access', 'Need reviewer']
    const worker = task([
      { key: 'access', verb: 'blocked', summary: summaries[0] },
      { key: 'reviewer', verb: 'blocked', summary: summaries[1] },
    ])
    if (context === 'card') worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    if (context === 'pull') worker.pr.url = pull
    const s = snapshot(context === 'card' ? [card()] : [], [worker], context === 'holds' ? [hold({ id: 'access' }), hold({ id: 'reviewer' })] : [])
    const result = build(s, new Map([[pull, readyPull()]]))
    expect(result.items).toHaveLength(context === 'holds' ? 4 : 2)
    expect(new Set(result.items.map(item => item.id)).size).toBe(result.items.length)
    const blocked = result.items.filter(item => item.kind === 'blocked')
    expect(blocked.map(item => item.action).sort()).toEqual([...summaries].sort())
    expect(blocked.every(item => !item.oneTouch && item.decisionKeys.length === 0)).toBe(true)
    worker.queue!.decisions.reverse()
    expect(build(s).items.map(item => item.id)).toEqual(result.items.map(item => item.id))
    s.fleet.unshift({ ...s.fleet[0]!, source: { ...s.fleet[0]!.source, home: '/farm/empty' }, observation: obs({ ...s.fleet[0]!.observation.data!, tasks: [], backlog: [] }) })
    expect(build(s).items.map(item => item.id)).toEqual(result.items.map(item => item.id))
  })

  it('retains the distinct captain hold when a blocked call shares its key', () => {
    const worker = task([{ key: 'access', verb: 'blocked', summary: 'Need repository access' }])
    const held = hold({ id: 'access', hold_reason: 'Approve the access proposal', pr_url: pull,
      cardReferences: [{ pageId: a, basis: 'explicit', source: 'backlog.notion_page_id' }],
      ...queueSignals({ hold_kind: 'captain', body_lines: ['Origin: worker'] }) })
    const result = build(snapshot([card()], [worker], [held]))
    expect(result.items).toHaveLength(2)
    expect(result.items.find(item => item.kind === 'blocked')).toMatchObject({ action: 'Need repository access', decisionKeys: [] })
    const request = result.items.find(item => item.decisionKeys.includes('access'))!
    expect(request).toMatchObject({ action: 'Approve the access proposal', cardIds: [a] })
    expect(request.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ url: pull }), expect.objectContaining({ kind: 'card' })]))
    expect(request.sources.find(source => source.kind === 'firstmate')?.request).toEqual({ home: '/farm/hulk', taskId: 'worker', id: 'access', kind: 'hold' })
  })

  it('does not deduplicate separate decisions sharing a card, PR or title', () => {
    const first = task(); first.pr.url = pull; first.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    const second = task([{ key: 'other', verb: 'needs-decision', summary: 'Choose C or D' }], 'other'); second.cardReferences = first.cardReferences; second.pr.url = pull
    expect(build(snapshot([card()], [first, second])).items).toHaveLength(2)
    const s = snapshot([], [task()]); const other = structuredClone(s.fleet[0]!); other.source.home = '/farm/other'; s.fleet.push(other)
    expect(build(s).items).toHaveLength(2)
  })

  it('retains stale candidates without claiming ready; missing sources never create an all-clear', () => {
    const s = snapshot([mergeCard()], [task()]); s.intentions.status = 'stale'; s.fleet[0]!.observation.status = 'stale'
    expect(build(s, new Map([[pull, readyPull()]])).items.every(item => item.readiness !== 'ready-now')).toBe(true)
    s.intentions.data = null; s.intentions.status = 'unknown'
    expect(build(s).coverage.intentions.status).toBe('unknown')
    expect(build(s).items[0]?.readiness).toBe('needs-readiness-verification')
    s.fleet[0]!.observation.data = null
    expect(build(s)).toMatchObject({ items: [], coverage: { intentions: { status: 'unknown' }, wholeFarm: 'not-certified' } })
  })

  it('does not confirm textual/missing/conflicting card context or expose source body text', () => {
    const worker = task(); worker.cardReferences = [{ pageId: a, basis: 'textual', source: 'task.backlog.raw' }]
    expect(build(snapshot([card()], [worker])).items[0]?.readiness).toBe('needs-readiness-verification')
    worker.cardReferences = [{ pageId: b, basis: 'explicit', source: 'task.notion_page_id' }]
    expect(build(snapshot([card()], [worker])).items[0]?.readiness).toBe('needs-readiness-verification')
    const signals = queueSignals({ hints: { open_decisions: [{ key: 'k', verb: 'resolved', summary: 'secret' }] }, body_lines: ['private text', 'Origin: worker'], raw: 'secret', hold_kind: 'captain' })
    expect(signals.queue).toMatchObject({ decisions: [], originTaskId: 'worker' })
    expect(JSON.stringify(signals)).not.toContain('secret')
  })

  it('orders ready, verification, future, then checkpoint and stable ID; reads do not mutate input', () => {
    const s = snapshot([mergeCard({ 'Start Date': { start: '2026-12-01' } }), card({ Owner: 'Will' }, b)], [task()], [hold({ id: 'choose' })])
    const before = structuredClone(s)
    const first = build(s); const next = build(s)
    expect(first.items.map(i => i.readiness)).toEqual(['ready-now', 'needs-readiness-verification', 'future-or-conditional'])
    expect(next).toEqual(first); expect(s).toEqual(before)
    expect(first.readOnly).toBe(true)
  })
})

describe('bounded cached PR reads', () => {
  const info = { state: 'open', merged: false, draft: false, head: 'a'.repeat(40), mergeable: true, mergeable_state: 'clean' }
  const response = (path: string) => path.includes('/check-runs') ? { total: 2, returned: 2, pending: 0, failed: 0 } : path.includes('/status') ? { total: 0, state: 'pending' } : info
  it('reads checks against the observed head, caches and coalesces reads, bounds refresh work', async () => {
    const read = vi.fn(async (path: string) => response(path))
    const reader = new QueuePullReader(read, () => now)
    const urls = Array.from({ length: 9 }, (_, i) => `https://github.com/except-pass/tinstar/pull/${i + 1}`)
    const [first, concurrent] = await Promise.all([reader.get(urls), reader.get(urls)])
    expect(read).toHaveBeenCalledTimes(12)
    expect(first.size).toBe(4); expect(concurrent.size).toBe(4)
    expect(first.get(urls[0]!)).toMatchObject({ status: 'fresh', checks: 'passed', mergeability: 'ready' })
    expect(read.mock.calls.some(([path]) => path.includes(`/commits/${info.head}/check-runs`))).toBe(true)
    await reader.get([urls[0]!]); expect(read).toHaveBeenCalledTimes(12)
  })

  it.each([false, true])('shares the refresh budget fairly across expired reads, failure=%s', async fail => {
    let clock = now
    const read = vi.fn(async (path: string) => {
      if (fail) throw new Error('Unavailable')
      return response(path)
    })
    const reader = new QueuePullReader(read, () => clock)
    const urls = Array.from({ length: 5 }, (_, i) => `https://github.com/except-pass/tinstar/pull/${i + 1}`)
    await reader.get(urls)
    const firstCount = read.mock.calls.length
    expect(firstCount).toBe(fail ? 4 : 12)
    clock += 61_000
    const [next, concurrent] = await Promise.all([reader.get(urls), reader.get(urls)])
    expect(read.mock.calls.length - firstCount).toBe(fail ? 4 : 12)
    expect(next.get(urls[4]!)?.status).toBe(fail ? 'unknown' : 'fresh')
    expect(concurrent.get(urls[4]!)).toEqual(next.get(urls[4]!))
    const attempted = read.mock.calls.map(([path]) => path).filter(path => /\/pulls\/\d+$/.test(path))
    expect(attempted.slice(4)).toEqual([5, 1, 2, 3].map(id => `/repos/except-pass/tinstar/pulls/${id}`))
    clock += 61_000
    await reader.get(urls)
    const later = read.mock.calls.map(([path]) => path).filter(path => /\/pulls\/\d+$/.test(path))
    expect(later[8]).toBe('/repos/except-pass/tinstar/pulls/4')
  })

  it.each([69, 73])('rotates through %s persistent PRs across cache eviction', async count => {
    let clock = now
    let active = 0
    let peak = 0
    const attempts: string[] = []
    const read = vi.fn(async (path: string) => {
      attempts.push(path)
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return { ...info, state: 'closed' }
    })
    const reader = new QueuePullReader(read, () => clock)
    const urls = Array.from({ length: count }, (_, i) => `https://github.com/except-pass/tinstar/pull/${i + 1}`)
    for (let window = 0; window < Math.ceil(count / 4) * 2; window++) {
      const before = attempts.length
      const [first, concurrent] = await Promise.all([reader.get(urls), reader.get(urls)])
      expect(attempts.length - before).toBe(4)
      for (const path of attempts.slice(before)) {
        const url = `https://github.com/except-pass/tinstar/pull/${path.split('/').at(-1)}`
        expect(first.get(url)?.status).toBe('fresh')
        expect(concurrent.get(url)).toEqual(first.get(url))
      }
      clock += 61_000
    }
    expect(peak).toBe(4)
    for (let id = 1; id <= count; id++) {
      expect(attempts.filter(path => path === `/repos/except-pass/tinstar/pulls/${id}`).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('retains only 64 cached PRs while rotation handles changing and empty candidates', async () => {
    const read = vi.fn(async () => ({ ...info, state: 'closed' }))
    const reader = new QueuePullReader(read, () => now)
    const urls = Array.from({ length: 69 }, (_, i) => `https://github.com/except-pass/tinstar/pull/${i + 1}`)
    for (let window = 0; window < 18; window++) await reader.get(urls)
    expect(read).toHaveBeenCalledTimes(72)
    expect(await reader.get([])).toEqual(new Map())
    expect(await reader.get(['https://example.com/unsupported'])).toEqual(new Map())
    await reader.get(urls.slice(8))
    expect(read).toHaveBeenCalledTimes(72)
    await reader.get([urls[3]!])
    expect(read).toHaveBeenCalledTimes(73)
  })

  it('does not mistake no CI, truncated checks, pending or failed checks for readiness', async () => {
    for (const [check, expected] of [
      [{ total: 0, returned: 0, pending: 0, failed: 0 }, 'unknown'],
      [{ total: 101, returned: 100, pending: 0, failed: 0 }, 'unknown'],
      [{ total: 2, returned: 2, pending: 1, failed: 0 }, 'pending'],
      [{ total: 2, returned: 2, pending: 0, failed: 1 }, 'failed'],
    ] as const) {
      const reader = new QueuePullReader(async path => path.includes('/check-runs') ? check : response(path), () => now)
      expect((await reader.get([pull])).get(pull)?.checks).toBe(expected)
    }
  })

  it('retains last-known data as stale on an outage and caches failure; closed PRs require no check calls', async () => {
    let clock = now
    const read = vi.fn(async (path: string) => response(path))
    const reader = new QueuePullReader(read, () => clock)
    await reader.get([pull]); read.mockRejectedValue(new Error('private secret'))
    clock += 61_000
    expect((await reader.get([pull])).get(pull)).toMatchObject({ status: 'stale', state: 'open' })
    await reader.get([pull]); expect(read).toHaveBeenCalledTimes(4)
    const closed = vi.fn(async () => ({ ...info, state: 'closed', merged: true }))
    expect((await new QueuePullReader(closed, () => now).get([pull])).get(pull)?.state).toBe('merged')
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

it('serves queue through the same read-only HTTP boundary and never calls domain-write scripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tinstar-queue-'))
  const home = join(dir, 'home')
  await mkdir(join(home, 'bin'), { recursive: true })
  const raw = { schema: 'fm-fleet-snapshot.v1', fm_home: home, generated: new Date().toISOString(), tasks: [{ id: 'live', spawn_gen: 'gen', hints: { open_decisions: [{ key: 'choose', verb: 'needs-decision', summary: 'Choose A or B' }] } }], backlog: { records: [] } }
  await writeFile(join(home, 'bin/fm-fleet-snapshot.sh'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(raw)}\nJSON\n`, { mode: 0o755 })
  const sources = new ReconciliationSources({ fleet: [{ home }], warnings: [] })
  const server = createServer((req, res) => { void handleReconciliationRequest(sources, req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
  seedOriginAllowlist(address.port)
  const url = `http://127.0.0.1:${address.port}/api/reconciliation/queue`
  try {
    const restricted = await fetch(url)
    expect(restricted.status).toBe(200)
    expect(await restricted.json()).toMatchObject({ ok: true, data: { warnings: expect.arrayContaining(['PR details require owner authorization']) } })
    const response = await fetch(url, { headers: { 'X-Tinstar-UI': '1' } })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ ok: true, data: { readOnly: true, items: [expect.objectContaining({ action: 'Choose A or B', readiness: 'needs-readiness-verification' })], coverage: { intentions: { status: 'unknown' } } } })
    for (const method of ['POST', 'PATCH', 'DELETE']) expect((await fetch(url, { method })).status).toBe(400)
    expect((await fetch(url, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
    expect((await fetch(url, { method: 'OPTIONS' })).status).toBe(204)
    // This home has only a read executable: a hidden write would fail this route.
    expect((await fetch(url, { headers: { 'X-Tinstar-UI': '1' } })).status).toBe(200)
    await writeFile(join(dir, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
    const api = new PullsApi(sources, undefined, dir)
    sources.authorizePulls = req => api.authorized(req)
    vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot([mergeCard()]), diagnostics: { notion: sources.notionApi.diagnostics } })
    const context = vi.spyOn(CardContextReader.prototype, 'commentDetails').mockResolvedValue({ outcome: 'available', blocks: [] })
    const read = vi.fn(async () => ({ pulls: [{ id: 'except-pass/tinstar#999', repository: 'except-pass/tinstar', number: 999, url: pull, title: 'Private PR title', author: 'private-author', head: 'a'.repeat(40), base: 'private-branch', draft: false, createdAt: at, updatedAt: at, observedAt: at, freshness: 'fresh' as const, links: [] }], repositories: [], warnings: [], associationsComplete: true }))
    const readiness = vi.fn(async () => new Map<string, PullReadiness>())
    sources.readPulls = read
    sources.readPullReadiness = readiness
    try {
      for (const headers of [{}, { 'X-Tinstar-UI': '1' }, { 'Tailscale-User-Login': 'stranger@example.test' }] as Record<string, string>[]) {
        const response = await fetch(url, { headers })
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.data.needsWill).toEqual([expect.objectContaining({ cardIds: [a], pulls: [], prDetails: 'PR details require owner authorization' })])
        expect(JSON.stringify(body)).not.toContain('Private PR title')
      }
      expect(read).not.toHaveBeenCalled()
      expect(readiness).not.toHaveBeenCalled()
      const owner = await fetch(url, { headers: { 'Tailscale-User-Login': 'owner@example.test' } })
      expect(owner.status).toBe(200)
      const body = await owner.json()
      expect(body.data.needsWill[0].pulls).toEqual([expect.objectContaining({ title: 'Private PR title', author: 'private-author', head: 'a'.repeat(40), base: 'private-branch' })])
      expect(body.data.needsWill[0].prDetails).toBeUndefined()
      expect(read).toHaveBeenCalledTimes(1)
      expect(readiness).toHaveBeenCalledWith([pull])
    } finally {
      context.mockRestore()
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

it('retains canonical PR selection as corroborating sources join and leave', () => {
  const worker = task([{ key: 'choose', verb: 'needs-decision', summary: `Review ${pull}` }])
  const alone = build(snapshot([], [worker]))
  const combined = build(snapshot([mergeCard()], [worker]))
  const cardOnly = build(snapshot([mergeCard()]))
  expect(alone.items[0]!.id).toBe(`pr:${pull}`)
  expect(combined.items[0]!.id).toBe(alone.items[0]!.id)
  expect(cardOnly.items[0]!.id).toBe(alone.items[0]!.id)
  const withoutPull = build(snapshot([card({ Owner: 'Will', 'Next action': 'Choose color' })]))
  expect(retainedQueueItemId(combined, withoutPull, combined.items[0]!.id)).toBe(withoutPull.items[0]!.id)
  expect(retainedQueueItemId(withoutPull, combined, withoutPull.items[0]!.id)).toBe(combined.items[0]!.id)
  const unrelated = build(snapshot([card({ Owner: 'Will', 'Next action': 'Choose color' }, b)]))
  expect(retainedQueueItemId(withoutPull, unrelated, withoutPull.items[0]!.id)).toBe(withoutPull.items[0]!.id)
})


it.each(['merged', 'closed'] as const)('suppresses only the merge ask when a linked PR is %s', state => {
  for (const associationOnly of [false, true]) for (const remaining of ['Decision', 'Elevated command', 'wait']) {
    const mixed = mergeCard({ 'Will action': remaining === 'wait' ? ['Merge'] : ['Merge', remaining],
      'Waiting For': remaining === 'wait' ? 'Will to approve access; Firstmate follows up' : '',
      ...(associationOnly ? { Link: '' } : {}) })
    const s = snapshot([mixed])
    const inventory = { pulls: [{ id: 'except-pass/tinstar#999', repository: 'except-pass/tinstar', number: 999, url: pull,
      title: 'Linked PR', author: 'agent', draft: false, head: 'a'.repeat(40), base: 'main', createdAt: at, updatedAt: at, observedAt: at, freshness: 'fresh' as const,
      links: [{ cardId: a, active: true, sources: ['Manual association'], events: [] }] }], repositories: [], warnings: [], associationsComplete: true }
    const readiness = new Map([[pull, readyPull({ state })]])
    const queue = buildQueue(s, readiness, now, inventory)
    expect(queue.items).toHaveLength(1)
    const item = queue.items[0]!
    expect(item.kind).toBe('decision')
    expect(item.sources.find(source => source.request?.kind === 'notion-card')?.actions).toEqual(remaining === 'wait' ? [] : [remaining])
    expect(item.action).not.toMatch(/^merge/i)
    const contexts = new Map([[a, { outcome: 'available' as const, blocks: ['Merge', 'Decision', 'Elevated command'].map(action => ({
      id: action, type: 'comment', text: `Requested from: Will\nQuestion: ${action} question\nTin Star request: ${JSON.stringify({ id: action, action, preserve_action: false })}`,
    })) }]])
    const view = needsWill(queue, reconcileScene(s, now), contexts, inventory, readiness, true)
    expect(view).toHaveLength(1)
    expect(view[0]!.requests.map(request => request.action)).toEqual(remaining === 'wait' ? [] : [remaining])
    expect(view[0]!.cardIds).toEqual([a])
    if (remaining === 'Elevated command') expect(item.readiness).toBe('needs-readiness-verification')
    if (remaining === 'wait') expect(item.readiness).toBe('future-or-conditional')
    for (const unknown of [readyPull({ state, status: 'stale' }), readyPull({ state, status: 'unknown' }), readyPull({ state, expiresAt: at })]) {
      const retained = buildQueue(s, new Map([[pull, unknown]]), now, inventory)
      expect(retained.items[0]!.kind).toBe('merge')
      expect(retained.items[0]!.sources.find(source => source.request?.kind === 'notion-card')?.actions).toContain('Merge')
    }
  }
})

it.each(['merged', 'closed'] as const)('retains an independent worker question after its card merge ask is %s', state => {
  const worker = task([{ key: 'accept', verb: 'needs-decision', summary: `Choose the acceptance outcome for ${pull}` }])
  const result = build(snapshot([mergeCard()], [worker]), new Map([[pull, readyPull({ state })]]))
  expect(result.items).toHaveLength(1)
  expect(result.items[0]!.kind).toBe('decision')
  expect(result.items[0]!.sources.some(source => source.kind === 'firstmate' && source.request?.id === 'accept')).toBe(true)
  expect(result.items[0]!.sources.some(source => source.request?.kind === 'notion-card')).toBe(false)
})
