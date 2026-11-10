import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { reconcileScene } from '../scene'
import { CachedObservation } from '../observation'
import { loadReconciliationConfig } from '../config'
import { fleetObservation } from '../fleet'
import { executionStatus, retainedExecutionLiveness } from '../../../shared/executionLiveness'
import { floorWorkerStatus } from '../../../shared/floorStatus'
import { notionObservation, NOTION_QUERY_PAGE_LIMIT } from '../notion'
import { handleReconciliationRequest, ReconciliationSources } from '..'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
import { readFleetSnapshot, MAX_SNAPSHOT_BYTES } from '../../fleet/snapshot'

const dirs: string[] = []
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'tinstar-sources-')); dirs.push(dir); return dir }
afterEach(async () => { vi.useRealTimers(); resetOriginAllowlistForTests(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const id = '40d50ce6d422814aa741c102cd00aaae'
const timestamp = '2026-11-03T18:32:18Z'
const snapshot = (home = '/farm/hulk') => ({
  schema: 'fm-fleet-snapshot.v1', generated: timestamp, fm_home: home, backlog: { present: true, records: [] }, main_inventory: { valid: true },
  tasks: [{ id: 'same-task', spawn_gen: 'attempt-1', branch: 'fm/example', current_state: { state: 'unknown', freshness: 'fresh' },
    remote: { host: 'bandit', root: '/farm/kdf' }, raw_transcript: 'private' }],
})

describe('source freshness', () => {
  it('coalesces reads, caches failures, and retains last-known data without claiming coverage', async () => {
    let now = Date.parse(timestamp)
    const read = vi.fn().mockResolvedValue({ data: { tasks: ['real'] }, observedAt: timestamp, coverage: 'complete' })
    const cache = new CachedObservation(read, 20_000, 60_000, 'Unavailable', () => now)
    const [a, b] = await Promise.all([cache.get(), cache.get()])
    expect(a).toEqual(b); expect(read).toHaveBeenCalledTimes(1)
    read.mockRejectedValue(new Error('secret'))
    now += 21_000
    const stale = await cache.get()
    expect(stale).toMatchObject({ status: 'stale', coverage: 'unknown', data: { tasks: ['real'] }, error: 'Unavailable' })
    await cache.get(); expect(read).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(stale)).not.toContain('secret')
  })

  it('keeps initial failure unknown and expired successful reads stale', async () => {
    const failure = new CachedObservation(async () => { throw new Error('no access') }, 20, 60, 'Unavailable')
    expect(await failure.get()).toMatchObject({ status: 'unknown', data: null, coverage: 'unknown' })
    const old = new CachedObservation(async () => ({ data: [], observedAt: timestamp, coverage: 'complete' }), 20, 60, 'Unavailable', () => Date.parse(timestamp) + 1000)
    expect(await old.get()).toMatchObject({ status: 'stale', coverage: 'unknown' })
  })
})

describe('fleet collection', () => {
  it.each([120, 180, 299, 300, 360])('ages published snapshots from generated time at %i seconds', async ageSeconds => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = Date.parse(timestamp) + ageSeconds * 1000
    vi.setSystemTime(now)
    const dir = await temp(); const file = join(dir, 'published.json')
    // Writing the file now must not renew an old snapshot's observation time.
    await writeFile(file, JSON.stringify(snapshot()))
    const sources = new ReconciliationSources({ fleet: [{ home: '/farm/hulk', snapshotFile: file }], warnings: [] })
    const result = await sources.snapshot()
    const observation = result.fleet[0]!.observation
    expect(observation).toMatchObject({
      status: ageSeconds < 300 ? 'fresh' : 'stale',
      coverage: ageSeconds < 300 ? 'complete' : 'unknown',
      observedAt: timestamp,
      attemptedAt: new Date(now).toISOString(),
      expiresAt: new Date(Date.parse(timestamp) + 300_000).toISOString(),
      data: { generated: timestamp, tasks: [expect.objectContaining({ identity: { fm_home: '/farm/hulk', task_id: 'same-task', spawn_gen: 'attempt-1' } })] },
    })
    if (ageSeconds >= 300) {
      expect(reconcileScene(result, now).coverage.absenceConclusions).toBe('suppressed')
      // Re-reading the same publication must not make it fresh again.
      vi.setSystemTime(now + 21_000)
      expect((await sources.snapshot()).fleet[0]!.observation.status).toBe('stale')
    }
  })

  it('preserves readiness lists including explicit empties and never fills absent or malformed lists', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(), file = join(dir, 'readiness.json')
    await writeFile(file, JSON.stringify({ ...snapshot(), main_inventory: { valid: true }, backlog: { present: true, records: [
      { id: 'same-task', state: 'in_flight', unresolved_blocker_ids: ['one', 'two'], blocked_by_ids: ['one'], current_role: 'crewmate', hold_bucket: 'captain' },
      { id: 'empty', state: 'queued', unresolved_blocker_ids: [], blocked_by_ids: [] },
      { id: 'absent', state: 'queued' },
      { id: 'malformed', state: 'queued', unresolved_blocker_ids: [null] },
    ] } }))
    const observation = await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()
    expect(observation).toMatchObject({ status: 'fresh', coverage: 'complete' })
    const rows = observation.data!.backlog!
    expect(rows[0]).toMatchObject({ unresolved_blocker_ids: ['one', 'two'], blocked_by_ids: ['one'], current_role: 'crewmate', hold_bucket: 'captain' })
    expect(rows[1]).toMatchObject({ unresolved_blocker_ids: [], blocked_by_ids: [] })
    expect(rows[2]).not.toHaveProperty('unresolved_blocker_ids')
    expect(rows[2]).not.toHaveProperty('blocked_by_ids')
    expect(rows[3]).not.toHaveProperty('unresolved_blocker_ids')
    expect(reconcileScene({ generatedAt: timestamp, scope: 'configured-homes-only', warnings: [], intentions: {
      data: null, status: 'unknown', coverage: 'unknown', observedAt: null, attemptedAt: timestamp, expiresAt: null, error: null,
    }, fleet: [{ source: { home: '/farm/hulk', machineBasis: 'configured' }, observation }] }, Date.parse(timestamp)).backlog[0]!.source.unresolved_blocker_ids).toEqual(['one', 'two'])
  })

  it.each(['inventory', 'backlog'] as const)('does not certify missing %s completeness metadata', async missing => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(), file = join(dir, 'incomplete.json')
    const raw = snapshot()
    await writeFile(file, JSON.stringify({ ...raw,
      ...(missing === 'inventory' ? { main_inventory: undefined } : { backlog: { records: [] } }),
    }))
    expect(await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()).toMatchObject({ coverage: 'partial', status: 'partial' })
  })

  it('keeps the local-exec default at 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const home = await temp(); await mkdir(join(home, 'bin'))
    await writeFile(join(home, 'bin/fm-fleet-snapshot.sh'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(snapshot(home))}\nJSON\n`, { mode: 0o755 })
    const cache = fleetObservation({ home })
    const fresh = await cache.get()
    expect(fresh).toMatchObject({ status: 'fresh', expiresAt: new Date(Date.parse(timestamp) + 60_000).toISOString() })
    vi.setSystemTime(Date.parse(timestamp) + 60_000)
    expect(await cache.get()).toMatchObject({ status: 'stale', coverage: 'unknown', data: fresh.data })
  })

  it('shares the local executable contract and bounds published files', async () => {
    const home = await temp()
    await mkdir(join(home, 'bin'))
    await writeFile(join(home, 'bin/fm-fleet-snapshot.sh'), `#!/bin/sh\n[ "$1" = "--json" ] || exit 9\ncat <<'JSON'\n${JSON.stringify(snapshot(home))}\nJSON\n`, { mode: 0o755 })
    expect((await readFleetSnapshot(home)).fm_home).toBe(home)
    const file = join(home, 'large.json')
    await writeFile(file, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1))
    await expect(readFleetSnapshot(home, file)).rejects.toThrow('exceeds')
  })

  it('keeps home/task/attempt identity and per-home outages across machines', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp()
    const file = join(dir, 'published.json')
    await writeFile(file, JSON.stringify(snapshot()))
    const cache = fleetObservation({ home: '/farm/hulk', machine: 'hulk', snapshotFile: file })
    const first = await cache.get()
    expect(first.status).toBe('fresh')
    expect(first.data?.tasks[0]).toMatchObject({ identity: { fm_home: '/farm/hulk', task_id: 'same-task', spawn_gen: 'attempt-1' }, remote: { host: 'bandit' } })
    expect(JSON.stringify(first)).not.toContain('raw_transcript')
    await writeFile(file, JSON.stringify(snapshot('/wrong/home')))
    vi.setSystemTime(new Date(Date.parse(timestamp) + 21_000))
    expect(await cache.get()).toMatchObject({ status: 'stale', data: first.data, coverage: 'unknown' })
    const sources = new ReconciliationSources({ fleet: [
      { home: '/farm/hulk', machine: 'hulk', snapshotFile: file },
      { home: '/farm/other', machine: 'optimus', snapshotFile: join(dir, 'missing.json') },
    ], warnings: [] })
    const result = await sources.snapshot()
    expect(result.scope).toBe('configured-homes-only')
    expect(result.fleet).toHaveLength(2)
    expect(result.fleet.map(row => row.observation.status)).toEqual(['unknown', 'unknown'])
    expect(result.fleet[1]?.source).toMatchObject({ machine: 'optimus', machineBasis: 'configured' })
    expect(result.intentions.status).toBe('unknown')
  })

  it('preserves codex event hints and labels a missing endpoint as liveness not observed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'liveness.json')
    const raw = snapshot()
    await writeFile(file, JSON.stringify({ ...raw, tasks: [
      { ...raw.tasks[0], id: 'paused-codex', endpoint: { exists: true }, hints: { last_event_text: 'paused [at=1]: waiting on CI' } },
      { ...raw.tasks[0], id: 'legacy-no-endpoint' },
      { ...raw.tasks[0], id: 'finished-window', endpoint: { exists: true }, hints: { last_event_text: 'done [at=1]: finished' } },
    ] }))
    const sources = new ReconciliationSources({ fleet: [{ home: '/farm/hulk', snapshotFile: file }], warnings: [] })
    const scene = reconcileScene(await sources.snapshot(), Date.parse(timestamp))
    expect(scene.executions.map(e => e.liveness)).toEqual(['waiting', 'liveness-not-observed', 'finished'])
    expect(scene.counts).toMatchObject({ running: 0, waiting: 1, finished: 1, absent: 0, 'liveness-not-observed': 1, attempts: 3 })
    expect(scene.findings.some(f => f.kind === 'untracked-worker' || f.kind === 'task-execution-gap')).toBe(false)
  })

  it('projects additive Codex facts into live counts and ignores private payload fields', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(), file = join(dir, 'codex.json'), raw = snapshot()
    await writeFile(file, JSON.stringify({ ...raw, tasks: [true, false, null].map((turn, index) => ({
      ...raw.tasks[0], id: `codex-${index}`, harness: 'codex', endpoint: { exists: true },
      hints: { last_event_text: 'paused [at=1]: historical wait' },
      codex: turn === null ? null : { turn_open: turn, observed_at: timestamp, last_activity_at: '2026-11-02T00:00:00Z', session_file: 'rollout-test.jsonl', prompt: 'PRIVATE' },
      codex_reason: turn === null ? 'no_matching_session_today_or_yesterday' : null,
    })) }))
    const sources = new ReconciliationSources({ fleet: [{ home: '/farm/hulk', snapshotFile: file }], warnings: [] })
    const result = await sources.snapshot(), scene = reconcileScene(result, Date.parse(timestamp))
    expect(scene.executions.map(worker => worker.liveness)).toEqual(['running', 'waiting', 'liveness-not-observed'])
    expect(scene.counts).toMatchObject({ running: 1, waiting: 1, 'liveness-not-observed': 1 })
    expect(scene.executions[0]!.source.codex).toMatchObject({ turn_open: true, observed_at: timestamp, last_activity_at: '2026-11-02T00:00:00Z' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(scene.executions[2]!.source.codex_reason).toBe('no_matching_session_today_or_yesterday')
  })

  it.each(['paused', 'done'])('distinguishes absent Codex facts from explicit null for %s reports', async report => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(), file = join(dir, 'legacy-codex.json'), raw = snapshot()
    await writeFile(file, JSON.stringify({ ...raw, tasks: [false, true].flatMap(published =>
      ['unknown', 'working'].map(state => ({
        ...raw.tasks[0], id: `${published}-${state}`, harness: 'codex', endpoint: { exists: true },
        current_state: { state, source: 'pane', freshness: 'fresh' },
        hints: { last_event_text: `${report} [at=1]: historical report` },
        ...(published ? { codex: null, codex_reason: 'no_matching_session_modified_within_7_days' } : {}),
      }))) }))
    const sources = new ReconciliationSources({ fleet: [{ home: '/farm/hulk', snapshotFile: file }], warnings: [] })
    const result = await sources.snapshot(), scene = reconcileScene(result, Date.parse(timestamp))
    const legacyLiveness = report === 'done' ? 'finished' : 'waiting'
    const legacyStatus = report === 'done' ? 'Finished' : 'Waiting'
    for (const worker of scene.executions) {
      const published = worker.identity.task_id!.startsWith('true-')
      const unknownCrew = worker.source.current_state.state === 'unknown'
      const missingSignal = published && unknownCrew
      expect(worker.liveness).toBe(missingSignal ? 'liveness-not-observed' : legacyLiveness)
      expect(retainedExecutionLiveness(worker.source, Date.parse(timestamp))).toBe(worker.liveness)
      expect(executionStatus(worker)).toBe(missingSignal ? 'Unknown' : legacyStatus)
      expect(floorWorkerStatus(worker)).toBe(missingSignal ? 'Unknown' : legacyStatus)
      const normalized = result.fleet[0]!.observation.data!.tasks.find(task => task.id === worker.identity.task_id)!
      if (published) {
        expect(normalized).toHaveProperty('codex', null)
        expect(worker.source).toHaveProperty('codex', null)
      } else {
        expect(normalized).not.toHaveProperty('codex')
        expect(worker.source).not.toHaveProperty('codex')
      }
    }
  })

  it('preserves structured child outcome provenance through fleet normalization', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'manager.json')
    const raw = snapshot()
    await writeFile(file, JSON.stringify({ ...raw, tasks: [{
      ...raw.tasks[0], kind: 'secondmate', endpoint: { exists: true },
      current_state: { state: 'working', source: 'pane', freshness: 'fresh' },
      paths: { status_log: { last_event: {
        state: 'done', raw: 'done [key=child-outcome-child-done-05b032a1]: child child done: complete',
      } } },
    }] }))
    const sources = new ReconciliationSources({ fleet: [{ home: '/farm/hulk', snapshotFile: file }], warnings: [] })
    const scene = reconcileScene(await sources.snapshot(), Date.parse(timestamp))
    expect(scene.executions[0]?.liveness).toBe('running')
    expect(scene.counts).toMatchObject({ running: 1, finished: 0 })
  })

  it('reads complete when only second-mate rows lack a spawn generation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'mates.json')
    const task = snapshot().tasks[0]!
    await writeFile(file, JSON.stringify({ ...snapshot(), tasks: [
      { ...task, id: 'worker', spawn_gen: 'attempt-1' },
      { ...task, id: 'catalog', kind: 'secondmate', spawn_gen: null },
      { ...task, id: 'cmsh', role: 'secondmate', spawn_gen: null },
      { ...task, id: 'kdf', spawn_gen: '' },
    ], secondmate_current: { records: [{ id: 'kdf' }] } }))
    const result = await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()
    expect(result).toMatchObject({ status: 'fresh', coverage: 'complete' })
    expect(result.data?.tasks.map(row => [row.identity.task_id, row.kind, row.identity.spawn_gen])).toEqual([
      ['worker', null, 'attempt-1'],
      ['catalog', 'secondmate', null],
      ['cmsh', 'secondmate', null],
      ['kdf', 'secondmate', ''],
    ])
    const sources = new ReconciliationSources({ fleet: [{ home: '/farm/hulk', snapshotFile: file }], warnings: [] })
    const scene = reconcileScene(await sources.snapshot(), Date.parse(timestamp))
    expect(scene.counts.workers).toBe(1)
    expect(scene.executions.filter(row => row.kind === 'secondmate').map(row => row.identity.task_id)).toEqual(['catalog', 'cmsh', 'kdf'])
  })

  it('stays partial when a normal task row lacks a spawn generation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'task-gap.json')
    const task = snapshot().tasks[0]!
    await writeFile(file, JSON.stringify({ ...snapshot(), tasks: [
      { ...task, id: 'hulk', spawn_gen: null },
      { ...task, id: 'catalog', kind: 'secondmate', spawn_gen: null },
    ] }))
    const result = await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()
    expect(result).toMatchObject({ status: 'partial', coverage: 'partial' })
    expect(result.data?.tasks.map(row => row.identity.task_id)).toEqual(['hulk', 'catalog'])
  })

  it('stays partial when spawned task rows repeat an id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'duplicate-tasks.json')
    const task = snapshot().tasks[0]!
    await writeFile(file, JSON.stringify({ ...snapshot(), tasks: [
      { ...task, id: 'worker', spawn_gen: 'attempt-1' },
      { ...task, id: 'worker', spawn_gen: 'attempt-2' },
      { ...task, id: 'catalog', kind: 'secondmate', spawn_gen: null },
    ] }))
    const result = await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()
    expect(result).toMatchObject({ status: 'partial', coverage: 'partial' })
    expect(result.data?.tasks).toHaveLength(3)
  })

  it('marks missing attempt/backlog inventory partial', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'partial.json')
    await writeFile(file, JSON.stringify({ ...snapshot(), backlog: null, tasks: [{ id: 'legacy-task' }] }))
    expect(await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()).toMatchObject({ coverage: 'partial', data: { backlog: null } })
  })

  it('preserves structured and textual linking evidence without publishing raw backlog text', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'references.json')
    const raw = snapshot()
    await writeFile(file, JSON.stringify({ ...raw,
      tasks: [{ ...raw.tasks[0], notion_page_id: '40d50ce6-d422-814a-a741-c102cd00aaae', backlog: { raw: `private body (card ${id})`, body_excerpt: `private excerpt https://www.notion.so/${id}`, body_lines: ['private line'] } }],
      backlog: { records: [{ id: 'same-task', notion_page_id: id, title: `Work (card ${id})`, raw: 'private standalone body' }] },
    }))
    const result = await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()
    expect(result.data?.tasks[0]?.cardReferences).toEqual([
      { pageId: id, basis: 'explicit', source: 'task.notion_page_id' },
      { pageId: id, basis: 'textual', source: 'task.backlog.raw' },
      { pageId: id, basis: 'textual', source: 'task.backlog.body_excerpt' },
    ])
    expect(result.data?.backlog?.[0]?.cardReferences).toEqual([
      { pageId: id, basis: 'explicit', source: 'backlog.notion_page_id' }, { pageId: id, basis: 'textual', source: 'backlog.title' },
    ])
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('retains identical task IDs in distinct homes and follows attempt changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const first = join(dir, 'first.json'); const second = join(dir, 'second.json')
    await writeFile(first, JSON.stringify(snapshot('/farm/hulk')))
    await writeFile(second, JSON.stringify(snapshot('/farm/optimus')))
    const sources = new ReconciliationSources({ warnings: [], fleet: [
      { home: '/farm/hulk', snapshotFile: first }, { home: '/farm/optimus', snapshotFile: second },
    ] })
    const initial = await sources.snapshot()
    expect(initial.fleet.map(row => row.observation.data?.tasks[0]?.identity)).toEqual([
      { fm_home: '/farm/hulk', task_id: 'same-task', spawn_gen: 'attempt-1' },
      { fm_home: '/farm/optimus', task_id: 'same-task', spawn_gen: 'attempt-1' },
    ])
    const changed = snapshot('/farm/hulk'); changed.tasks[0]!.spawn_gen = 'attempt-2'
    await writeFile(first, JSON.stringify(changed))
    vi.setSystemTime(new Date(Date.parse(timestamp) + 21_000))
    const next = await sources.snapshot()
    expect(next.fleet[0]?.observation.data?.tasks).toHaveLength(1)
    expect(next.fleet[0]?.observation.data?.tasks[0]?.identity.spawn_gen).toBe('attempt-2')
    expect(next.fleet[1]?.observation.data?.tasks[0]?.identity.spawn_gen).toBe('attempt-1')
  })

  it('discloses unavailable backlog and inventory contradictions without losing workers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'inventory.json')
    await writeFile(file, JSON.stringify({ ...snapshot(), backlog: { present: false, records: [] }, main_inventory: { valid: false } }))
    const result = await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()
    expect(result).toMatchObject({ status: 'partial', coverage: 'partial' })
    expect(result.data?.tasks).toHaveLength(1)
  })
})

const names: Record<string, string> = { Name: 'title', Status: 'select', Owner: 'select', 'Last touched by': 'select', 'Will action': 'multi_select', 'Parent item': 'relation', 'Sub-item': 'relation', Link: 'url' }
const schema = { object: 'data_source', properties: Object.fromEntries(Object.entries(names).map(([name, type]) => [name, { id: name, type }])) }
const page = { object: 'page', id, last_edited_time: timestamp, properties: {
  Name: { id: 'title', type: 'title', title: [{ plain_text: 'Actual intention' }] },
  Status: { type: 'select', select: { name: 'Backlog' } },
  'Parent item': { type: 'relation', relation: [{ id: '30950ce6-d422-80d3-a541-cbd66c274f6a' }], has_more: false },
}, raw_transcript: 'private' }
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('Notion reader', () => {
  it('queries only the configured source, paginates, canonicalizes IDs, deduplicates and caches', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema))
      .mockResolvedValueOnce(response({ results: [page], has_more: true, next_cursor: 'next' }))
      .mockResolvedValueOnce(response({ results: [page], has_more: false }))
    const reader = notionObservation({ token: 'test-secret', dataSourceId: id }, fetcher)
    const result = await reader.get(); await reader.get()
    expect(result.status).toBe('fresh'); expect(result.data?.cards).toHaveLength(1)
    expect(result.data?.cards[0]?.properties['Parent item']?.value).toEqual(['30950ce6d42280d3a541cbd66c274f6a'])
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`https://api.notion.com/v1/data_sources/${id}`, 'GET'],
      [`https://api.notion.com/v1/data_sources/${id}/query`, 'POST'],
      [`https://api.notion.com/v1/data_sources/${id}/query`, 'POST'],
    ])
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({ start_cursor: 'next', page_size: 100 })
    expect(JSON.stringify(result)).not.toMatch(/test-secret|raw_transcript/)
  })

  it.each(['status', 'select'])('retains unpopulated %s options for presentation filters', async type => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...schema, properties: { ...schema.properties,
      Status: { id: 'status', type, [type]: { options: [{ name: 'In review' }, { name: 'Queued' }] } },
    } })).mockResolvedValueOnce(response({ results: [page], has_more: false }))
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    expect(result.data!.schema.Status!.options).toEqual(['In review', 'Queued'])
    expect(result.data!.cards[0]!.properties.Status!.value).toBe('Backlog')
  })

  it('bounds pagination and reports truncated relations as partial', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === 'GET' ? response(schema)
      : response({ results: [{ ...page, properties: { ...page.properties, 'Parent item': { type: 'relation', relation: [], has_more: true } } }], has_more: true, next_cursor: `cursor-${fetcher.mock.calls.length}` }))
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    expect(fetcher).toHaveBeenCalledTimes(NOTION_QUERY_PAGE_LIMIT + 1)
    expect(result).toMatchObject({ status: 'partial', coverage: 'partial', data: { hasMore: true } })
  })

  it('does not publish partial successful pages as complete when a later read fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema))
      .mockResolvedValueOnce(response({ results: [page], has_more: true, next_cursor: 'next' }))
      .mockResolvedValueOnce(new Response('private error', { status: 403 }))
    expect(await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()).toMatchObject({ status: 'unknown', coverage: 'unknown', data: null })
  })

  it('does not read a relation property when has_more is false', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema))
      .mockResolvedValueOnce(response({ results: [page], has_more: false }))
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    expect(result).toMatchObject({ status: 'fresh', coverage: 'complete', data: { truncatedRelations: [] } })
    expect(fetcher.mock.calls.map(([url]) => String(url)).some(url => url.includes('/properties/'))).toBe(false)
  })

  it('pages an encoded property ID unchanged and reports complete relation coverage', async () => {
    const inline = '3fb50ce6d422812ea3fbfe3a4b2fae58'
    const third = '30950ce6d42280d3a541cbd66c274f6a'
    const propertyId = 'f%5C%5C%3Ap'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema))
      .mockResolvedValueOnce(response({ results: [{ ...page, properties: { ...page.properties, 'Sub-item': {
        id: propertyId, type: 'relation', relation: [{ id: inline }], has_more: true,
      } } }], has_more: false }))
      .mockResolvedValueOnce(response({ object: 'list', has_more: true, next_cursor: 'more', results: [
        { type: 'relation', relation: { id: inline } },
      ] }))
      .mockResolvedValueOnce(response({ object: 'list', has_more: false, results: [
        { type: 'relation', relation: { id: third } },
      ] }))
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    expect(result).toMatchObject({ status: 'fresh', coverage: 'complete', data: { hasMore: false, truncatedRelations: [], missingSchemaProperties: [] } })
    expect(result.data!.cards[0]!.properties['Sub-item']).toMatchObject({ hasMore: false, value: [inline, third] })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer secret', 'Notion-Version': '2025-09-03' } })
    expect(String(fetcher.mock.calls[2]?.[0])).toBe(`https://api.notion.com/v1/pages/${id}/properties/${propertyId}?page_size=100`)
    const next = new URL(String(fetcher.mock.calls[3]?.[0]))
    expect(next.pathname).toBe(`/v1/pages/${id}/properties/${propertyId}`)
    expect(next.searchParams.get('page_size')).toBe('100')
    expect(next.searchParams.get('start_cursor')).toBe('more')
  })

  it('reads every truncated relation property before reporting complete coverage', async () => {
    const parent = '30950ce6d42280d3a541cbd66c274f6a'
    const child = '3fb50ce6d422812ea3fbfe3a4b2fae58'
    const other = '3f850ce6d4228145bf16d59da8ce4a3c'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema))
      .mockResolvedValueOnce(response({ results: [{ ...page, id, properties: { ...page.properties,
        'Parent item': { id: 'parent', type: 'relation', relation: [{ id: parent }], has_more: true },
        'Sub-item': { id: 'sub', type: 'relation', relation: [{ id: child }], has_more: true },
      } }], has_more: false }))
      .mockResolvedValueOnce(response({ has_more: false, results: [
        { type: 'relation', relation: { id: parent } },
        { type: 'relation', relation: { id: other } },
      ] }))
      .mockResolvedValueOnce(response({ has_more: false, results: [
        { type: 'relation', relation: { id: child } },
        { type: 'relation', relation: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      ] }))
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    expect(result).toMatchObject({ status: 'fresh', coverage: 'complete', data: { truncatedRelations: [] } })
    expect(result.data!.cards[0]!.properties['Parent item']!.value).toEqual([parent, other])
    expect(result.data!.cards[0]!.properties['Sub-item']!.value).toEqual([child, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
    expect(fetcher.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/properties/'))).toEqual([
      `https://api.notion.com/v1/pages/${id}/properties/parent?page_size=100`,
      `https://api.notion.com/v1/pages/${id}/properties/sub?page_size=100`,
    ])
  })

  it('keeps the named relation truncated when the property read fails', async () => {
    const inline = '3fb50ce6d422812ea3fbfe3a4b2fae58'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema))
      .mockResolvedValueOnce(response({ results: [{ ...page, properties: { ...page.properties, 'Sub-item': {
        id: 'sub', type: 'relation', relation: [{ id: inline }], has_more: true,
      } } }], has_more: false }))
      .mockResolvedValueOnce(new Response('private error', { status: 500 }))
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    expect(result).toMatchObject({
      status: 'partial', coverage: 'partial',
      data: { hasMore: false, missingSchemaProperties: [], truncatedRelations: [{ pageId: id, property: 'Sub-item' }] },
    })
    expect(result.data!.cards[0]!.properties['Sub-item']).toMatchObject({ hasMore: true, value: [inline] })
    expect(JSON.stringify(result)).not.toContain('private error')
  })

  it('records each relation still truncated when paging exceeds its bounds', async () => {
    const inline = '30950ce6d42280d3a541cbd66c274f6a'
    const relation = (propertyId: string) => ({ id: propertyId, type: 'relation', relation: [{ id: inline }], has_more: true })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const target = String(url)
      if (target.includes('/properties/')) return response({
        object: 'list', has_more: true, next_cursor: `cursor-${fetcher.mock.calls.length}`,
        results: [{ type: 'relation', relation: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }],
      })
      if (init?.method === 'GET') return response(schema)
      return response({ results: [{ ...page, properties: { ...page.properties,
        'Parent item': relation('parent'), 'Sub-item': relation('sub'), Initiative: relation('initiative'),
      } }], has_more: false })
    })
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    const propertyCalls = fetcher.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/properties/'))
    expect(propertyCalls.filter(url => url.includes('/properties/parent'))).toHaveLength(10)
    expect(propertyCalls.filter(url => url.includes('/properties/sub'))).toHaveLength(10)
    expect(propertyCalls.filter(url => url.includes('/properties/initiative'))).toHaveLength(0)
    expect(result).toMatchObject({
      status: 'partial', coverage: 'partial',
      data: { hasMore: false, truncatedRelations: [
        { pageId: id, property: 'Parent item' },
        { pageId: id, property: 'Sub-item' },
        { pageId: id, property: 'Initiative' },
      ] },
    })
    for (const name of ['Parent item', 'Sub-item', 'Initiative']) {
      expect(result.data!.cards[0]!.properties[name]).toMatchObject({ hasMore: true, value: [inline] })
    }
  })
})

describe('First Mate tasks source property', () => {
  it('reads concatenated rich text into the source model without requiring worker metadata', async () => {
    const payload = JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks: [
      { fm_home: '/farm/hulk', task_id: 'one', first_observed_spawn_gen: 'g1' },
      { fm_home: '/farm/hulk', task_id: 'two', first_observed_spawn_gen: 'g2' },
    ] })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema)).mockResolvedValueOnce(response({
      results: [{ ...page, properties: { ...page.properties, 'First Mate tasks': { type: 'rich_text', rich_text: [
        { plain_text: payload.slice(0, 80) }, { text: { content: payload.slice(80) } },
      ] } } }], has_more: false,
    }))
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    expect(result.data!.cards[0]!.properties['First Mate tasks']).toMatchObject({ type: 'rich_text', value: payload,
      workerLinks: { status: 'valid', tasks: [
        { fm_home: '/farm/hulk', task_id: 'one', first_observed_spawn_gen: 'g1' },
        { fm_home: '/farm/hulk', task_id: 'two', first_observed_spawn_gen: 'g2' },
      ] } })
  })
})

describe('config and HTTP boundary', () => {
  it('honors the config root, falls back to existing homes, and reports invalid source config', async () => {
    const root = await temp()
    await writeFile(join(root, 'config.json'), JSON.stringify({ firstmate: { homes: ['/farm/hulk'] } }))
    expect(loadReconciliationConfig(root).fleet).toEqual([{ home: '/farm/hulk' }])
    await writeFile(join(root, 'config.json'), JSON.stringify({ firstmate: { homes: ['/farm/hulk'] }, reconciliation: { notion: { token: 'missing-data-source' } } }))
    expect(loadReconciliationConfig(root)).toMatchObject({ fleet: [{ home: '/farm/hulk' }], notion: undefined, warnings: [expect.any(String)] })
    await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: { fleet: [{ home: 'relative' }] } }))
    expect(loadReconciliationConfig(root)).toMatchObject({ fleet: [], warnings: [expect.any(String)] })
  })

  it('preserves optional display labels without changing stable home identities', async () => {
    const root = await temp()
    await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: { fleet: [{ home: '/farm/fm-home', label: 'hulk' }, { home: '/farm/fm-fleet', label: '' }] } }))
    const config = loadReconciliationConfig(root)
    expect(config.fleet).toEqual([{ home: '/farm/fm-home', label: 'hulk' }, { home: '/farm/fm-fleet', label: '' }])
    expect(config.warnings).toEqual([])
  })

  it('serves the envelope and unknown coverage, rejects writes and foreign origins', async () => {
    const sources = new ReconciliationSources({ fleet: [], warnings: [] })
    const server = createServer((req, res) => { void handleReconciliationRequest(sources, req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
    seedOriginAllowlist(address.port)
    const url = `http://127.0.0.1:${address.port}/api/reconciliation/sources`
    try {
      const res = await fetch(url); expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toMatchObject({ ok: true, data: { scope: 'configured-homes-only', intentions: { status: 'unknown', data: null }, warnings: [expect.any(String)] } })
      expect((await fetch(url, { method: 'POST' })).status).toBe(400)
      expect((await fetch(url, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
      const sceneUrl = url.replace('/sources', '/scene')
      const scene = await fetch(sceneUrl)
      expect(scene.headers.get('cache-control')).toBe('no-store')
      expect(await scene.json()).toMatchObject({ ok: true, data: { coverage: { absenceConclusions: 'suppressed', wholeFarm: 'not-certified' },
        cards: [], executions: [], claims: [], findings: [expect.any(Object), expect.any(Object)],
        arrangements: { initiative: [expect.objectContaining({ label: 'Unassigned / unknown' })] } } })
      expect((await fetch(sceneUrl, { method: 'POST' })).status).toBe(400)
      expect((await fetch(sceneUrl, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
      expect((await fetch(sceneUrl, { method: 'OPTIONS' })).status).toBe(204)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})

it('forces a source read past its TTL while coalescing concurrent manual refreshes', async () => {
  const read = vi.fn().mockResolvedValue({ data: ['known'], observedAt: new Date().toISOString(), coverage: 'complete' })
  const cache = new CachedObservation(read, 30_000, 120_000, 'Unavailable')
  await cache.get(); await cache.get()
  expect(read).toHaveBeenCalledTimes(1)
  const [a, b] = await Promise.all([cache.get(true), cache.get(true)])
  expect(a).toEqual(b)
  expect(read).toHaveBeenCalledTimes(2)
})

it('retains missing cards on an incomplete Notion read while accepting changed status, then removes them on a complete read', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(timestamp))
  let generation = 0
  const other = { ...page, id: '30950ce6d42280d3a541cbd66c274f6a' }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    if (init?.method === 'GET') {
      const properties = { ...schema.properties }
      if (generation === 1) delete (properties as Partial<typeof schema.properties>).Link
      return response({ ...schema, properties })
    }
    return response({ results: generation === 0 ? [page, other] : generation === 1 ? [{ ...page, properties: { ...page.properties, Status: { type: 'select', select: { name: 'Done' } } } }] : [other], has_more: false })
  })
  const cache = notionObservation({ token: 'secret', dataSourceId: id }, fetcher)
  const initial = await cache.get()
  expect(initial.coverage).toBe('complete')
  generation++
  vi.setSystemTime(Date.parse(timestamp) + 30_000)
  const partial = await cache.get(true)
  expect(partial).toMatchObject({ status: 'stale', coverage: 'partial', observedAt: initial.observedAt, expiresAt: initial.expiresAt })
  expect(partial.data!.cards).toHaveLength(2)
  expect(partial.data!.cards.find(card => card.id === initial.data!.cards[0]!.id)!.properties.Status!.value).toBe('Done')
  vi.setSystemTime(Date.parse(timestamp) + 60_000)
  const repeated = await cache.get(true)
  expect(repeated).toMatchObject({ status: 'stale', observedAt: initial.observedAt, expiresAt: initial.expiresAt })
  expect(repeated.data!.cards).toHaveLength(2)
  generation++
  const recovered = await cache.get(true)
  expect(recovered.status).toBe('fresh')
  expect(recovered.observedAt).not.toBe(initial.observedAt)
  expect(recovered.data!.cards.map(card => card.id)).toEqual([other.id])
})

it('retains workers omitted by a partial home publication and accepts a complete removal', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(timestamp))
  const dir = await temp(), file = join(dir, 'fleet.json')
  const initial = { ...snapshot(), backlog: { present: true, records: [{ id: 'retained-wait', state: 'waiting' }] } }
  initial.tasks[0]!.current_state.state = 'running'
  initial.generated = new Date().toISOString()
  initial.tasks.push({ ...initial.tasks[0]!, id: 'other-task' })
  await writeFile(file, JSON.stringify(initial))
  const cache = fleetObservation({ home: '/farm/hulk', snapshotFile: file })
  const first = await cache.get()
  expect(first.data!.tasks).toHaveLength(2)
  vi.setSystemTime(Date.parse(timestamp) + 30_000)
  const next = { ...initial, generated: new Date().toISOString(), tasks: [], backlog: { present: true, records: [] }, main_inventory: { valid: false } }
  await writeFile(file, JSON.stringify(next))
  const partial = await cache.get(true)
  expect(partial).toMatchObject({ status: 'stale', coverage: 'partial', observedAt: first.observedAt, expiresAt: first.expiresAt })
  expect(partial.data!.tasks).toHaveLength(2)
  expect(partial.data!.backlog).toHaveLength(1)
  vi.setSystemTime(Date.parse(timestamp) + 60_000)
  await writeFile(file, JSON.stringify({ ...next, generated: new Date().toISOString() }))
  const repeated = await cache.get(true)
  expect(repeated).toMatchObject({ status: 'stale', observedAt: first.observedAt, expiresAt: first.expiresAt })
  expect(repeated.data!.tasks).toHaveLength(2)
  expect(repeated.data!.backlog).toHaveLength(1)
  const empty = await new ReconciliationSources({ fleet: [], warnings: [] }).snapshot()
  const scene = reconcileScene({ ...empty, fleet: [{ source: { home: '/farm/hulk', machineBasis: 'unknown' }, observation: repeated }] })
  expect(scene.executions).toHaveLength(2)
  expect(scene.executions.every(worker => worker.liveness === 'liveness-not-observed' && worker.observation.status === 'stale')).toBe(true)
  await writeFile(file, JSON.stringify({ ...next, main_inventory: { valid: true } }))
  const recovered = await cache.get(true)
  expect(recovered.status).toBe('fresh')
  expect(recovered.data!.tasks).toHaveLength(0)
  expect(recovered.data!.backlog).toHaveLength(0)
})

it('routes a manual refresh through the existing scene endpoint', async () => {
  const sources = new ReconciliationSources({ fleet: [], warnings: [] })
  const scene = await sources.scene()
  const read = vi.spyOn(sources, 'scene').mockResolvedValue(scene)
  const server = createServer((req, res) => { void handleReconciliationRequest(sources, req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port')
  seedOriginAllowlist(address.port)
  try {
    await fetch(`http://127.0.0.1:${address.port}/api/reconciliation/scene`)
    await fetch(`http://127.0.0.1:${address.port}/api/reconciliation/scene?refresh=1`)
    expect(read.mock.calls).toEqual([[false], [true]])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
