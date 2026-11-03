import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
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

  it('marks missing attempt/backlog inventory partial', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(timestamp))
    const dir = await temp(); const file = join(dir, 'partial.json')
    await writeFile(file, JSON.stringify({ ...snapshot(), backlog: null, tasks: [{ id: 'legacy-task' }] }))
    expect(await fleetObservation({ home: '/farm/hulk', snapshotFile: file }).get()).toMatchObject({ coverage: 'partial', data: { backlog: null } })
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
  it('honors the config root, falls back to existing homes, and reports invalid source config', async () => {
    const root = await temp()
    await writeFile(join(root, 'config.json'), JSON.stringify({ firstmate: { homes: ['/farm/hulk'] } }))
    expect(loadReconciliationConfig(root).fleet).toEqual([{ home: '/farm/hulk' }])
    await writeFile(join(root, 'config.json'), JSON.stringify({ firstmate: { homes: ['/farm/hulk'] }, reconciliation: { notion: { token: 'missing-data-source' } } }))
    expect(loadReconciliationConfig(root)).toMatchObject({ fleet: [{ home: '/farm/hulk' }], notion: undefined, warnings: [expect.any(String)] })
    await writeFile(join(root, 'config.json'), JSON.stringify({ reconciliation: { fleet: [{ home: 'relative' }] } }))
    expect(loadReconciliationConfig(root)).toMatchObject({ fleet: [], warnings: [expect.any(String)] })
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
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})
