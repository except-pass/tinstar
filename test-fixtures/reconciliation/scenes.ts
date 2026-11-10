/** Explicit synthetic data for UI/reducer acceptance. Never imported by production. */
import type { Worker } from '../../src/cockpit/shell/types'
import type { SourceSnapshot } from '../../src/server/reconciliation'
import type { Observation } from '../../src/server/reconciliation/observation'
import { buildQueue } from '../../src/server/reconciliation/queue'
import { SceneReconciler } from '../../src/server/reconciliation/scene'

type FleetData = NonNullable<SourceSnapshot['fleet'][number]['observation']['data']>
type Card = NonNullable<SourceSnapshot['intentions']['data']>['cards'][number]
type Task = FleetData['tasks'][number]
export const fixtureId = (n: number) => n.toString(16).padStart(32, '0')
export const fixtureHomes = ['/fixture/mac', '/fixture/hulk', '/fixture/bandit']
export const fixtureNames = { linked: 'Build live reconciliation', gap: 'Authorized execution gap', inferred: 'Candidate relationship', wait: 'Waiting for input', backlog: 'Roadmap: planned integration' }
function observation<T>(data: T, now: number): Observation<T> {
  const at = new Date(now).toISOString()
  return { data, status: 'fresh', coverage: 'complete', observedAt: at, attemptedAt: at, expiresAt: new Date(now + 60_000).toISOString(), error: null }
}
function card(id: number, name: string, now: number, values: Record<string, unknown> = {}): Card {
  return { id: fixtureId(id), url: `https://www.notion.so/${fixtureId(id)}`, last_edited_time: new Date(now).toISOString(), archived: false, in_trash: false,
    properties: Object.fromEntries(Object.entries({ Name: name, Owner: 'Firstmate', Status: 'In Progress', 'First Mate tasks': JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks: [] }), 'Parent item': [fixtureId(100)], ...values }).map(([key, value]) => [key, { id: key, type: key === 'Parent item' ? 'relation' : key === 'First Mate tasks' ? 'rich_text' : 'select', value, hasMore: false }])) }
}
function task(id: string, page: number | null, home: string, now: number, state = 'working'): Task {
  const at = new Date(now).toISOString()
  return { id, kind: 'ship', spawn_gen: 'attempt-1', harness: 'codex', model: null, branch: 'fixture/example', project: 'fixture/tinstar', backend: 'fixture', remote: null,
    identity: { fm_home: home, task_id: id, spawn_gen: 'attempt-1' }, cardReferences: page === null ? [] : [{ pageId: fixtureId(page), basis: 'explicit', source: 'task.notion_page_id' }],
    current_state: { state, source: 'run-step', detail: 'Fixture recorded state', observed_at: at, freshness: 'fresh' }, endpoint: { exists: true, agent_alive: 'alive', status: 'live', observed_at: at, freshness: 'fresh' },
    paths: { home: null, worktree: null }, lastEventText: null, last_event: { raw: null, state, note: `Published activity for ${id}`, age_seconds: 12 }, pr: { head: null, source: null, url: null },
    backlog: { id: null, title: null, state: null, hold_reason: null, blocked_by: null, hold_until: null } }
}
export function fixtureSources({ now = Date.now(), size = 0, unavailable = false }: { now?: number; size?: number; unavailable?: boolean } = {}): SourceSnapshot {
  const homes = fixtureHomes.map((home, index) => ({ source: { home, machine: ['Mac', 'Hulk', 'Bandit'][index]!, machineBasis: 'configured', ...(index ? { parentHome: fixtureHomes[0] } : {}) }, observation: observation<FleetData>({
    fm_home: home, schema: 'fm-fleet-snapshot.v1', generated: new Date(now).toISOString(), coverageScope: 'fixture', main_inventory: { valid: true, reason: null, unstructured_current_count: 0 },
    backlogPresent: true, ledger: { role: 'change-signal-only', cursor: null, scope: 'not-collected' }, tasks: [], backlog: [],
  }, now) }))
  homes[1]!.observation.data!.tasks = [task('linked-worker', 1, fixtureHomes[1]!, now), task('untracked-worker', 900, fixtureHomes[1]!, now), task('candidate-worker', null, fixtureHomes[1]!, now), task('blocked-worker', 4, fixtureHomes[1]!, now, 'blocked')]
  homes[1]!.observation.data!.tasks[2]!.backlog.title = fixtureNames.inferred
  homes[2]!.observation.data!.tasks = [task('helper-worker', 1, fixtureHomes[2]!, now)]
  homes[1]!.observation.data!.backlog = [{ id: 'gap', title: fixtureNames.gap, state: 'in_flight', kind: 'ship', repo: null, hold_reason: null, hold_until: null, blocked_by: null, captain_actionable: null, pr_url: null,
    cardReferences: [{ pageId: fixtureId(2), basis: 'explicit', source: 'backlog.notion_page_id' }] }]
  const cards = [card(100, 'Reconciliation initiative', now, { Status: 'Planned', 'Parent item': [] }), card(1, fixtureNames.linked, now), card(2, fixtureNames.gap, now), card(3, fixtureNames.inferred, now),
    card(4, fixtureNames.wait, now, { Status: 'Waiting For', 'Waiting For': 'Input from reviewer', 'Next check-in': { start: new Date(now + 3600_000).toISOString() } }),
    card(5, fixtureNames.backlog, now, { Status: 'Backlog', 'Parent item': [] }), card(6, 'Human-owned work', now, { Owner: 'Will', 'Parent item': [] })]
  for (let i = 0; i < size; i++) {
    cards.push(card(1000 + i, `Roadmap fixture ${i + 1}`, now, { Status: i % 7 === 0 ? 'In Progress' : 'Backlog', 'Parent item': i % 3 ? [fixtureId(100)] : [] }))
    if (i < 80) homes[1 + i % 2]!.observation.data!.tasks.push(task(`fleet-worker-${i}`, 1000 + i, fixtureHomes[1 + i % 2]!, now, i % 5 ? 'working' : 'waiting'))
  }
  // Fixture declarations belong to Notion. Candidate and intentionally omitted
  // worker records keep testing the independent source stacks.
  for (const card of cards) {
    const tasks = homes.flatMap(home => home.observation.data!.tasks)
      .filter(task => task.cardReferences.some(ref => ref.pageId === card.id && ref.basis === 'explicit'))
      .map(task => ({ fm_home: task.identity.fm_home, task_id: task.identity.task_id, first_observed_spawn_gen: task.identity.spawn_gen }))
    card.properties['First Mate tasks']!.value = JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks })
  }
  if (unavailable) homes[2]!.observation = { ...homes[2]!.observation, status: 'stale', coverage: 'unknown', error: 'Fixture: home publication unavailable' }
  return { generatedAt: new Date(now).toISOString(), scope: 'configured-homes-only', warnings: ['Explicit controlled fixture — not production incidents'], fleet: homes,
    intentions: observation({ dataSourceId: fixtureId(999), schema: {}, cards, hasMore: false, truncatedRelations: [], missingSchemaProperties: [], scope: 'fixture' }, now) }
}
export const fixtureScene = (options: Parameters<typeof fixtureSources>[0] = {}) => new SceneReconciler().reconcile(fixtureSources(options), options.now ?? Date.now())

/** Matching cockpit record for verifying the existing safe viewer route. */
export function fixtureViewerWorkers(): Worker[] {
  return [{ key: 'fixture-linked-worker', id: 'linked-worker', home: fixtureHomes[1]!, kind: 'ship', state: 'working', detail: 'Fixture state',
    observedAt: new Date().toISOString(), freshness: 'fresh', objective: fixtureNames.linked, project: 'fixture/tinstar', direct: false,
    worktree: '/fixture/worktree', branch: 'fixture/example', prUrl: null, terminalAvailable: true, terminalPid: 1 }]
}

/** Explicit desk fixture with two ready actions, a verification candidate and
 * future work. This changes fixture intentions only, never a live board. */
export function fixtureQueue(now = Date.now()) {
  const sources = fixtureSources({ now })
  for (const n of [1, 2, 5]) {
    const item = sources.intentions.data!.cards.find(c => c.id === fixtureId(n))!
    item.properties.Owner!.value = 'Will'
    item.properties['Next action'] = { id: 'next', type: 'rich_text', value: `Choose option ${n}`, hasMore: false }
  }
  return buildQueue(sources, new Map(), now)
}

/** Complete readiness census for the compact dial: one Active, one Stalled.
 * Every task has an explicit blocker list; the stale variant retains the payload
 * while withdrawing freshness, just as a failed home read does. */
export function fixtureReadinessScene({ now = Date.now(), stale = false }: { now?: number; stale?: boolean } = {}) {
  const sources = fixtureSources({ now })
  sources.intentions.data!.cards = sources.intentions.data!.cards.filter(card => [fixtureId(1), fixtureId(4)].includes(card.id))
  for (const card of sources.intentions.data!.cards) {
    card.properties['Parent item']!.value = []
    card.properties.Status!.value = 'In Progress'
    if (card.properties['Waiting For']) card.properties['Waiting For']!.value = ''
  }
  for (const home of sources.fleet) {
    const data = home.observation.data!
    data.backlog = data.tasks.map(task => ({ id: task.identity.task_id, title: String(task.id), state: 'in_flight', kind: 'ship', repo: null,
      hold_reason: null, hold_until: null, blocked_by: null, captain_actionable: false, pr_url: null, unresolved_blocker_ids: [], blocked_by_ids: [], cardReferences: [] }))
    for (const task of data.tasks) if (task.id === 'blocked-worker') {
      task.current_state.state = 'paused'; task.last_event.state = 'paused'
    }
  }
  if (stale) sources.fleet[1]!.observation = { ...sources.fleet[1]!.observation, status: 'stale', coverage: 'unknown', error: 'Fixture: readiness publication unavailable' }
  return new SceneReconciler().reconcile(sources, now)
}

/** Owner's rejected dial cases, with real tri-state results from shared work health. */
export function fixturePatternCoverageScene({ now = Date.now(), confirmed = 8, unavailable = 11 }: { now?: number; confirmed?: number; unavailable?: number } = {}) {
  const scene = fixtureReadinessScene({ now, stale: true })
  const cards = scene.cards, claims = scene.claims
  scene.cards = []; scene.claims = []
  for (let i = 0; i < confirmed + unavailable; i++) {
    const template = cards.find(card => card.id === fixtureId(i < confirmed ? 1 : 4))!
    const id = fixtureId(2000 + i)
    const card = structuredClone(template)
    card.id = id; card.source.id = id
    card.source.properties.Name!.value = `${i < confirmed ? 'Confirmed active' : 'Not evaluated'} card ${i + 1}`
    scene.cards.push(card)
    scene.claims.push(...claims.filter(claim => claim.cardId === template.id).map(claim => ({ ...claim, id: `${claim.id}-${i}`, cardId: id })))
  }
  return scene
}
