import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage } from 'node:http'
import { ReconciliationSources, handleReconciliationRequest } from '../index'
import { WorkReader } from '../workReader'
import { buildQueue } from '../queue'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'

afterEach(() => vi.restoreAllMocks())

it('serves known requests over HTTP while slow enrichment is shared, then publishes the complete result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'queue-display-'))
  const snapshot = fixtureSources({ now: Date.now() })
  const card = snapshot.intentions.data!.cards[0]!
  card.properties.Owner!.value = 'Will'
  card.properties['Will action'] = { id: 'action', type: 'multi_select', value: ['Decision'], hasMore: false }
  vi.spyOn(WorkReader.prototype, 'declarations').mockReturnValue(snapshot.intentions)
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, fetch, undefined, root)
  vi.spyOn(sources, 'snapshot').mockImplementation(() => new Promise(() => {}))
  const complete = buildQueue(snapshot)
  let finish!: (value: typeof complete) => void
  const enrich = vi.spyOn(sources, 'queue').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const server = createServer((req, res) => { void handleReconciliationRequest(sources, req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/queue`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
    const first = (await response.json()).data
    expect(first.refreshing).toBe(true)
    expect(first.needsWill.some((item: { cardIds: string[] }) => item.cardIds.includes(card.id))).toBe(true)
    expect(first.needsWill.every((item: { oneTouch: boolean; proposalHistoryComplete: boolean }) => !item.oneTouch && !item.proposalHistoryComplete)).toBe(true)
    expect(first.warnings).toContainEqual(expect.stringContaining('Refreshing request evidence'))
    expect((await (await fetch(url)).json()).data.needsWill).toEqual(first.needsWill)
    expect(enrich).toHaveBeenCalledTimes(1)
    finish(complete)
    await vi.waitFor(async () => expect((await sources.queueDisplay()).refreshing).toBe(false))
    const final = (await (await fetch(url)).json()).data
    expect(final.items).toEqual(complete.items)
    expect(final.warnings).toEqual(complete.warnings)
    expect(enrich).toHaveBeenCalledTimes(1)
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('retains previously enriched requests during failure and never shares owner evidence with anonymous readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'queue-display-owner-'))
  const snapshot = fixtureSources({ now: Date.now() }), sources = new ReconciliationSources({ fleet: [], warnings: [] }, fetch, undefined, root)
  vi.spyOn(WorkReader.prototype, 'declarations').mockReturnValue({ ...snapshot.intentions, data: null, status: 'unknown', coverage: 'unknown' })
  vi.spyOn(sources, 'snapshot').mockImplementation(() => new Promise(() => {}))
  const owner = { headers: { 'tailscale-user-login': 'owner@example.test' } } as unknown as IncomingMessage
  sources.authorizePulls = async req => req === owner
  const complete = buildQueue(snapshot)
  const item = complete.items[0]!
  complete.needsWill = [{ ...item, requestSince: null, ageBasis: 'unknown', requests: [], pulls: [], prDetails: 'owner PR evidence' }]
  vi.spyOn(sources, 'queue').mockImplementation(async req => { if (req === owner) return complete; throw new Error('Source unavailable') })
  await sources.queueDisplay(owner)
  await vi.waitFor(async () => expect((await sources.queueDisplay(owner)).refreshing).toBe(false))
  const anonymous = await sources.queueDisplay()
  expect(JSON.stringify(anonymous)).not.toContain('owner PR evidence')
  vi.mocked(sources.queue).mockRejectedValue(new Error('Source unavailable'))
  const refreshing = await sources.queueDisplay(owner, true)
  expect(refreshing.needsWill?.map(row => row.id)).toContain(item.id)
  await vi.waitFor(async () => expect((await sources.queueDisplay(owner)).refreshing).toBe(false))
  const retained = await sources.queueDisplay(owner)
  expect(retained.needsWill?.find(row => row.id === item.id)).toMatchObject({ oneTouch: false, proposalHistoryComplete: false })
  expect(retained.warnings).toContainEqual(expect.stringContaining('could not refresh'))
  await rm(root, { recursive: true, force: true })
})
