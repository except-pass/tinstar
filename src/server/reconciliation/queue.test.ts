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
import { queueSignals } from './queueInputs'
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
    endpoint: { exists: true, agent_alive: null, status: null, observed_at: at, freshness: 'fresh' }, paths: { home: null, worktree: null },
    last_event: { state: null, note: null, age_seconds: null }, pr: { url: null, head: null, source: null },
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
    expect(build(snapshot([], [task()])).items[0]).toMatchObject({ readiness: 'ready-now', decisionKeys: ['choose'], oneTouch: true })
    expect(build(snapshot([], [], [hold()])).items[0]?.readiness).toBe('ready-now')
    const unkeyed = task([]); unkeyed.current_state.state = 'needs-decision'
    expect(build(snapshot([], [unkeyed])).items[0]?.readiness).toBe('needs-readiness-verification')
    for (const s of [snapshot([], [], [hold({ captain_actionable: false })]), snapshot([], [task([{ key: 'block', verb: 'blocked', summary: 'Needs review' }])]), snapshot([], [task([{ verb: 'needs-decision', summary: 'No explicit key' }])])]) {
      expect(build(s).items[0]?.readiness).toBe('needs-readiness-verification')
    }
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

  it('deduplicates exact keyed calls and captain holds using First Mate hold identity', () => {
    const worker = task([{ key: 'hold', verb: 'needs-decision', summary: 'Choose A or B' }])
    expect(build(snapshot([], [worker], [hold()])).items).toHaveLength(1)
    const origin = hold({ id: 'origin-hold', ...queueSignals({ hold_kind: 'captain', body_lines: ['Origin: worker'] }) })
    expect(build(snapshot([], [task()], [origin])).items).toHaveLength(1)
  })

  it('deduplicates a Notion and First Mate merge request by canonical PR identity', () => {
    const worker = task([{ key: 'merge', verb: 'needs-decision', summary: 'Merge this PR' }]); worker.pr.url = `${pull}/`
    worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    const result = build(snapshot([mergeCard()], [worker]), new Map([[pull, readyPull()]]))
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ readiness: 'ready-now', cardIds: [a], homeIds: ['/farm/hulk'], decisionKeys: ['merge'] })
    expect(result.items[0]?.sources.map(s => s.kind)).toEqual(expect.arrayContaining(['firstmate', 'notion', 'github']))
  })

  it('uses a real First Mate request to corroborate a tag-only Notion merge candidate', () => {
    const worker = task([{ key: 'merge', verb: 'needs-decision', summary: 'Merge this PR' }]); worker.pr.url = pull
    worker.cardReferences = [{ pageId: a, basis: 'explicit', source: 'task.notion_page_id' }]
    expect(build(snapshot([mergeCard({ 'Next action': null, Owner: 'Firstmate' })], [worker]), new Map([[pull, readyPull()]])).items[0])
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
    const actions = reverse ? ['Merge after release', 'Merge this PR'] : ['Merge this PR', 'Merge after release']
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
    expect(build(snapshot([], [task([{ key: 'subject', verb: 'needs-decision', summary: action }])])).items[0])
      .toMatchObject({ readiness: 'ready-now', oneTouch: true })
  })

  it.each(['Decide if we should ship after release', 'Choose when to launch once approved'])('retains prerequisites after a decision subject: %s', action => {
    expect(build(snapshot([card({ Owner: 'Will', 'Next action': action })])).items[0]?.readiness).toBe('future-or-conditional')
    expect(build(snapshot([], [task([{ key: 'subject', verb: 'needs-decision', summary: action }])])).items[0]?.readiness).toBe('future-or-conditional')
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
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false, decisionKeys: ['choose'] })
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

  it.each(['exact', 'legacy', 'published', 'task-text', 'origin-text'] as const)('preserves prerequisites from %s matched holds', route => {
    const key = route === 'published' ? 'captain-hold-release-123' : 'merge'
    const summary = route.endsWith('text') ? 'Merge after release' : 'Merge this PR'
    const id = route === 'exact' ? key : route === 'legacy' ? `worker-decision-${key}` : route === 'published' ? 'release' : route === 'task-text' ? 'worker' : 'origin-hold'
    const worker = task([{ key, verb: 'needs-decision', summary }]); worker.pr.url = pull
    const held = hold({ id, hold_reason: 'Merge after release', pr_url: pull,
      ...queueSignals({ hold_kind: 'captain', body_lines: route === 'origin-text' ? ['Origin: worker'] : [] }) })
    const result = build(snapshot([], [worker], [held]), new Map([[pull, readyPull()]]))
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ decisionKeys: [key], readiness: 'future-or-conditional', oneTouch: false })
    held.hold_reason = summary === 'Merge this PR' ? 'Review then merge' : summary
    if (summary === 'Merge this PR') expect(build(snapshot([], [worker], [held]), new Map([[pull, readyPull()]])).items[0])
      .toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false })
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
    const s = snapshot([mergeCard({ 'Start Date': { start: '2026-12-01' } }), card({ Owner: 'Will' }, b)], [task()])
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
    const response = await fetch(url)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ ok: true, data: { readOnly: true, items: [expect.objectContaining({ action: 'Choose A or B', readiness: 'needs-readiness-verification' })], coverage: { intentions: { status: 'unknown' } } } })
    for (const method of ['POST', 'PATCH', 'DELETE']) expect((await fetch(url, { method })).status).toBe(400)
    expect((await fetch(url, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
    expect((await fetch(url, { method: 'OPTIONS' })).status).toBe(204)
    // This home has only a read executable: a hidden write would fail this route.
    expect((await fetch(url)).status).toBe(200)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
