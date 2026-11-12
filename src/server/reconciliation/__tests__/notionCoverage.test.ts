import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notionObservation, NOTION_QUERY_PAGE_LIMIT } from '../notion'
import { ReconciliationSources } from '..'
import { CheckInWatchdog, checkInDecisions } from '../checkInWatchdog'

const dataSourceId = 'a'.repeat(32)
const id = (n: number) => n.toString(16).padStart(32, '0')
const schema = (statusType = 'select') => ({ object: 'data_source', properties: Object.fromEntries(Object.entries({
  Name: 'title', Status: statusType, Owner: 'select', 'Next check-in': 'date', 'Last touched by': 'select',
  'Will action': 'multi_select', 'Parent item': 'relation', 'Sub-item': 'relation', Link: 'url',
}).map(([name, type]) => [name, { id: name, type }])) })
const page = (n: number, status = 'In Progress', statusType = 'select') => ({
  object: 'page', id: id(n), last_edited_time: new Date().toISOString(), parent: { data_source_id: dataSourceId },
  properties: { Name: { type: 'title', title: [{ plain_text: `Fixture work ${n}` }] }, Owner: { type: 'select', select: { name: 'Firstmate' } },
    Status: { type: statusType, [statusType]: { name: status } }, 'Next check-in': { type: 'date', date: { start: '2026-11-09T10:00:00Z' } } },
})
const response = (value: unknown) => new Response(JSON.stringify(value))
let root: string | undefined
afterEach(async () => { vi.unstubAllGlobals(); if (root) await rm(root, { recursive: true, force: true }); root = undefined })

function fixture(total: number, scoped = 72, statusType = 'select', scopedMore = false) {
  const calls: Array<{ filter?: unknown; start_cursor?: string }> = []
  let closed = false
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === `/v1/data_sources/${dataSourceId}`) return response(schema(statusType))
    if (path === `/v1/data_sources/${dataSourceId}/query`) {
      const body = JSON.parse(String(init?.body)); calls.push(body)
      const start = Number(body.start_cursor ?? 0), count = body.filter ? scoped : total
      const end = Math.min(start + 100, count)
      return response({ results: Array.from({ length: end - start }, (_, offset) => page((body.filter ? 2000 : 0) + start + offset + 1, 'In Progress', statusType)),
        has_more: body.filter && scopedMore || end < count, next_cursor: String(end) })
    }
    if (path.startsWith('/v1/pages/')) return response(page(Number.parseInt(path.split('/').at(-1)!, 16), closed ? 'Done' : 'In Progress', statusType))
    return response({ results: [], has_more: false }) // card paragraphs/comments, never a writer
  })
  return { fetcher, calls, close: () => { closed = true } }
}

it.each([1008, 1500])('reads every card of a %i-card board beyond the old cap', async count => {
  const f = fixture(count)
  const result = await notionObservation({ token: 'fixture-token', dataSourceId }, f.fetcher).get()
  expect(result).toMatchObject({ status: 'fresh', coverage: 'complete', data: { hasMore: false } })
  expect(result.data!.cards).toHaveLength(count)
  expect(result.data!.cards.at(-1)!.id).toBe(id(count))
  expect(f.calls).toHaveLength(Math.ceil(count / 100))
  expect(f.calls.every(call => !call.filter)).toBe(true)
  expect(new Set(f.fetcher.mock.calls.map(([, init]) => init?.signal)).size).toBe(1)
})

it('keeps a board over the new bound explicitly partial', async () => {
  const f = fixture(2500)
  const result = await notionObservation({ token: 'fixture-token', dataSourceId }, f.fetcher).get()
  expect(result).toMatchObject({ status: 'partial', coverage: 'partial', data: { hasMore: true } })
  expect(result.data!.cards).toHaveLength(NOTION_QUERY_PAGE_LIMIT * 100)
  expect(f.calls).toHaveLength(NOTION_QUERY_PAGE_LIMIT)
})

it.each(['select', 'status'])('keeps operational and check-in reads scoped independently of history size (%s)', async statusType => {
  const f = fixture(2500, 72, statusType)
  vi.stubGlobal('fetch', f.fetcher)
  const sources = new ReconciliationSources({ fleet: [], notion: { token: 'fixture-token', dataSourceId }, warnings: [] })
  const snapshot = await sources.checkInSnapshot()
  // A cold watchdog read must not fetch the broader operational declarations.
  expect(snapshot.intentions).toMatchObject({ status: 'unknown', coverage: 'unknown', data: null })
  expect(snapshot.checkIns).toMatchObject({ status: 'fresh', coverage: 'complete', data: { hasMore: false } })
  expect(f.calls.every(call => !!call.filter)).toBe(true)
  const filtered = f.calls.filter(call => JSON.stringify(call.filter).includes('Firstmate'))
  expect(filtered).toHaveLength(1)
  expect(filtered[0]!.filter).toEqual({ and: [
    { property: 'Owner', select: { equals: 'Firstmate' } },
    { or: [{ property: 'Status', [statusType]: { equals: 'In Progress' } }, { property: 'Status', [statusType]: { equals: 'Waiting For' } }] },
  ] })
  const decisions = checkInDecisions(snapshot)
  expect(decisions).toHaveLength(72)
  expect(decisions.every(d => d.due && d.route.worker === null && d.route.via === 'firstmate')).toBe(true)
  expect(decisions[0]!.cardId).toBe(id(2001)) // absent from the capped full-board graph

  const operational = await sources.snapshot()
  expect(operational.intentions).toMatchObject({ coverage: 'complete', data: { hasMore: false } })
  const cached = await sources.checkInSnapshot()
  expect(cached.intentions).toEqual(operational.intentions)
  expect(cached.checkIns).toEqual(snapshot.checkIns)
  expect(checkInDecisions(cached)).toEqual(decisions)
  expect(f.calls).toHaveLength(2) // one scoped census and one explicit operational read
  expect(f.calls.every(call => !!call.filter)).toBe(true)
})

it('does not use a truncated scoped census to authorize eligibility', async () => {
  const f = fixture(1008, 2100)
  const scoped = await notionObservation({ token: 'fixture-token', dataSourceId }, f.fetcher, 'check-ins').get()
  expect(scoped).toMatchObject({ coverage: 'partial', data: { hasMore: true } })
  const source = new ReconciliationSources({ fleet: [], warnings: [] })
  const snapshot = await source.snapshot()
  expect(checkInDecisions({ ...snapshot, checkIns: scoped }).some(d => d.due)).toBe(false)
})

it('does not let unrelated truncated hierarchy properties invalidate a complete scoped census', async () => {
  const card = page(1)
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(schema())).mockResolvedValueOnce(response({ results: [{ ...card,
    properties: { ...card.properties, 'Parent item': { id: 'parent', type: 'relation', relation: [], has_more: true } },
  }], has_more: false }))
  const result = await notionObservation({ token: 'fixture-token', dataSourceId }, fetcher, 'check-ins').get()
  expect(result).toMatchObject({ coverage: 'complete', status: 'fresh', data: { hasMore: false, truncatedRelations: [{ property: 'Parent item' }] } })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('requires the scoped query required properties even when its pagination completed', async () => {
  const incomplete = schema()
  delete incomplete.properties['Next check-in']
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response({ results: [page(1)], has_more: false }))
  const scoped = await notionObservation({ token: 'fixture-token', dataSourceId }, fetcher, 'check-ins').get()
  expect(scoped).toMatchObject({ coverage: 'partial', data: { hasMore: false, missingSchemaProperties: ['Next check-in'] } })
  const snapshot = await new ReconciliationSources({ fleet: [], warnings: [] }).snapshot()
  expect(checkInDecisions({ ...snapshot, checkIns: scoped }).some(d => d.due)).toBe(false)
})

it('delivers an eligible scoped card missing from an incomplete board, then suppresses a changed exact card', async () => {
  const f = fixture(2500, 1)
  vi.stubGlobal('fetch', f.fetcher)
  const sources = new ReconciliationSources({ fleet: [], notion: { token: 'fixture-token', dataSourceId }, warnings: [] })
  root = await mkdtemp(join(tmpdir(), 'checkin-coverage-'))
  const watchdog = new CheckInWatchdog(sources, root, async () => ({ deliveryEnabled: true }))
  await watchdog.sweep()
  expect(await watchdog.rows()).toHaveLength(1)
  const first = await watchdog.bridgeWork()
  expect(first.pending).toHaveLength(1)
  expect(first.pending[0]!.body).toContain(`"card_id":"${id(2001)}"`)
  expect(first.pending[0]!.body).toContain('"worker":null')
  f.close()
  await watchdog.sweep(true)
  expect((await watchdog.bridgeWork()).pending).toEqual([])
  expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || ['GET', 'POST'].includes(init.method))).toBe(true)
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').every(([url]) => String(url).endsWith('/query'))).toBe(true)
})
