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
import { notionObservation } from '../notion'
import { handleReconciliationRequest, ReconciliationSources } from '..'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
import { readFleetSnapshot, MAX_SNAPSHOT_BYTES } from '../../fleet/snapshot'

const dirs: string[] = []
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'tinstar-sources-')); dirs.push(dir); return dir }
afterEach(async () => { vi.useRealTimers(); resetOriginAllowlistForTests(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const id = '40d50ce6d422814aa741c102cd00aaae'
const timestamp = '2026-11-03T18:32:18Z'
const snapshot = (home = '/farm/hulk') => ({
  schema: 'fm-fleet-snapshot.v1', generated: timestamp, fm_home: home, backlog: { records: [] },
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

  it.each([60, 600])('honors a per-home published snapshot age of %i seconds', async maxAgeSeconds => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(timestamp) + 360_000)
    const dir = await temp(); const file = join(dir, 'published.json')
    await writeFile(file, JSON.stringify(snapshot()))
    const result = await fleetObservation({ home: '/farm/hulk', snapshotFile: file, maxAgeSeconds }).get()
    expect(result.status).toBe(maxAgeSeconds === 600 ? 'fresh' : 'stale')
    expect(result.expiresAt).toBe(new Date(Date.parse(timestamp) + maxAgeSeconds * 1000).toISOString())
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
      tasks: [{ ...raw.tasks[0], notion_page_id: '40d50ce6-d422-814a-a741-c102cd00aaae', backlog: { raw: `private body (card ${id})` } }],
      backlog: { records: [{ id: 'same-task', notion_page_id: id, title: `Work (card ${id})`, raw: 'private standalone body' }] },
    }))
    const result = await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()
    expect(result.data?.tasks[0]?.cardReferences).toEqual([
      { pageId: id, basis: 'explicit', source: 'task.notion_page_id' }, { pageId: id, basis: 'textual', source: 'task.backlog.raw' },
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

  it('bounds pagination and reports truncated relations as partial', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === 'GET' ? response(schema)
      : response({ results: [{ ...page, properties: { ...page.properties, 'Parent item': { type: 'relation', relation: [], has_more: true } } }], has_more: true, next_cursor: `cursor-${fetcher.mock.calls.length}` }))
    const result = await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()
    expect(fetcher).toHaveBeenCalledTimes(11)
    expect(result).toMatchObject({ status: 'partial', coverage: 'partial', data: { hasMore: true } })
  })

  it('does not publish partial successful pages as complete when a later read fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema))
      .mockResolvedValueOnce(response({ results: [page], has_more: true, next_cursor: 'next' }))
      .mockResolvedValueOnce(new Response('private error', { status: 403 }))
    expect(await notionObservation({ token: 'secret', dataSourceId: id }, fetcher).get()).toMatchObject({ status: 'unknown', coverage: 'unknown', data: null })
  })
})

describe('config and HTTP boundary', () => {
  it.each([30, 300, 3600])('accepts maxAgeSeconds of %i', async maxAgeSeconds => {
    const root = await temp()
    const source = { home: '/farm/main', snapshotFile: '/snapshots/main.json', maxAgeSeconds }
    await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: { fleet: [source] } }))
    expect(loadReconciliationConfig(root)).toMatchObject({ fleet: [source], warnings: [] })
  })

  it.each([29, 3601, 30.5, '300', null])('rejects invalid maxAgeSeconds %s', async maxAgeSeconds => {
    const root = await temp()
    await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: { fleet: [{ home: '/farm/main', maxAgeSeconds }] } }))
    expect(loadReconciliationConfig(root)).toMatchObject({ fleet: [], warnings: [expect.stringContaining('maxAgeSeconds')] })
  })

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
