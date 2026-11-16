import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardLeases } from '../../reconciliation/cardLeases'
import { WorkReader } from '../../reconciliation/workReader'
import { NotionApi } from '../../reconciliation/notionApi'
import { notionReleaseTransport } from '../writer'
import { waitLine } from '../../../shared/waitingForPolicy'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { releaseAssociations } from '../../../shared/releases'
import type { ReleaseObject } from '../../../shared/releaseObjects'
import { productionWaits, ProductionWaitWriter } from '../productionWaits'
import type { ReleaseTransport } from '../writer'

function fixture() {
  const scene = fixtureScene(); scene.cards = scene.cards.slice(0, 1)
  const card = scene.cards[0]!.source, url = 'https://github.com/owner/repo/pull/1'
  card.properties.Status!.value = 'Waiting for Prod Release'
  card.properties['GitHub PRs'] = { type: 'rich_text', value: url, hasMore: false, id: 'prs' }
  const data = releaseAssociations(scene)
  data.releaseSource = { status: 'fresh', observedAt: new Date().toISOString(), warnings: [] }
  const release: ReleaseObject = { id: 'owner/repo:tag:v1.0.0', repository: 'owner/repo', version: 'v1.0.0', sourceSha: 'a'.repeat(40), kind: 'production', candidateId: null, planId: null, executionId: null,
    scope: [], targets: [], state: 'Awaiting PROD verification', observedAt: new Date().toISOString(), provenance: { historical: false, source: 'GitHub', asOf: new Date().toISOString() }, evidenceUrl: 'https://github.com/owner/repo/releases/tag/v1.0.0',
    membership: { status: 'complete', baseline: 'v0.9.0', baselineSha: 'b'.repeat(40), observedAt: new Date().toISOString(), reason: null }, pulls: structuredClone(data.pulls), gaps: [],
    github: { record: 'available', url: 'https://github.com/owner/repo/releases/tag/v1.0.0', publishedAt: new Date().toISOString(), body: '', snapshotAt: null, componentResults: [], runsStatus: 'fresh', runs: [] } }
  data.releases = [release]
  const notes = new Set<string>()
  const transport: ReleaseTransport = { card: vi.fn(async () => card), hasNote: async (_id, marker) => notes.has(marker), note: vi.fn(async (_id, _text, marker) => { notes.add(marker) }), transition: vi.fn(async (_card, proposal) => { card.properties.Status!.value = proposal.to }) }
  return { scene, card, data, release, notes, transport, read: async () => ({ data, scene }) }
}
it('advances a release wait with an audited native production membership and never replays it', async () => {
  const f = fixture(), writer = new ProductionWaitWriter(f.transport, f.read)
  expect(await writer.run()).toEqual({ completed: [f.card.id], unconfirmed: [] })
  expect(f.card.properties.Status!.value).toBe('Done')
  expect(f.transport.note).toHaveBeenCalledWith(f.card.id, expect.stringContaining(f.release.evidenceUrl!), expect.stringContaining('Tin Star production wait: membership:'))
  await writer.run(); expect(f.transport.transition).toHaveBeenCalledTimes(1)
})
it('routes explicit production verification through In Progress', async () => {
  const f = fixture()
  f.card.properties['Requires production verification'] = { id: 'verify', type: 'checkbox', hasMore: false, value: true }
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.card.properties.Status!.value).toBe('In Progress')
})
it.each(['draft', 'partial', 'stale', 'unpublished', 'unknown-source', 'incomplete-associations', 'another-pr'] as const)('holds %s evidence', async condition => {
  const f = fixture()
  if (condition === 'draft') f.release.kind = 'draft'
  if (condition === 'partial') f.release.membership.status = 'partial'
  if (condition === 'stale') f.release.provenance.historical = true
  if (condition === 'unpublished') f.release.github!.publishedAt = null
  if (condition === 'unknown-source') f.data.releaseSource!.status = 'unknown'
  if (condition === 'incomplete-associations') f.data.associationsComplete = false
  if (condition === 'another-pr') f.data.pulls.push({ ...f.data.pulls[0]!, url: 'https://github.com/owner/repo/pull/2', id: 'owner/repo#2' })
  expect(productionWaits(f.data, f.scene)).toEqual([])
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.transport.note).not.toHaveBeenCalled(); expect(f.transport.transition).not.toHaveBeenCalled()
})
it('revalidates newly added required PRs after recording its audit', async () => {
  const f = fixture()
  f.transport.note = async () => { f.data.pulls.push({ ...f.data.pulls[0]!, url: 'https://github.com/owner/repo/pull/2', id: 'owner/repo#2' }) }
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.transport.transition).not.toHaveBeenCalled()
})
it('recovers a failed transition using the same card audit marker', async () => {
  const f = fixture(), transition = f.transport.transition
  f.transport.transition = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(transition)
  expect(await new ProductionWaitWriter(f.transport, f.read).run()).toEqual({ completed: [], unconfirmed: [f.card.id] })
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.transport.note).toHaveBeenCalledTimes(1)
  expect(f.card.properties.Status!.value).toBe('Done')
})

it.each([false, true])('preserves typed blockers before planning (production verification: %s)', async verify => {
  for (const field of ['Waiting For Type', 'Waiting For ID', 'Waiting For']) {
    const f = fixture()
    f.card.properties['Requires production verification'] = { id: 'verify', type: 'checkbox', hasMore: false, value: verify }
    const value = field === 'Waiting For Type' ? 'Event' : field === 'Waiting For ID' ? 'external-cutover' : waitLine({ type: 'Event', id: 'external-cutover', dependency: 'External cutover', unblocks_when: 'Operator confirms cutover', follow_up_by: 'Ada' })
    f.card.properties[field] = { id: field, type: field === 'Waiting For Type' ? 'select' : 'rich_text', hasMore: false, value }
    const writer = new ProductionWaitWriter(f.transport, f.read)
    expect(productionWaits(f.data, f.scene)).toEqual([])
    await writer.run()
    expect(f.transport.note).not.toHaveBeenCalled(); expect(f.transport.transition).not.toHaveBeenCalled()
    expect(f.card.properties[field]!.value).toBe(value)
    delete f.card.properties[field]
    await writer.run()
    expect(f.card.properties.Status!.value).toBe(verify ? 'In Progress' : 'Done')
  }
})

it.each([false, true])('holds a blocker added after the audit (production verification: %s)', async verify => {
  const f = fixture(), note = f.transport.note
  f.card.properties['Requires production verification'] = { id: 'verify', type: 'checkbox', hasMore: false, value: verify }
  f.transport.note = async (...args) => {
    await note(...args)
    f.card.properties['Waiting For Type'] = { id: 'type', type: 'select', hasMore: false, value: 'Event' }
  }
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.transport.transition).not.toHaveBeenCalled()
  expect(f.card.properties.Status!.value).toBe('Waiting for Prod Release')
  expect(f.card.properties['Waiting For Type']!.value).toBe('Event')
})

it('holds a blocker found only in the fresh pre-write source scan', async () => {
  const f = fixture()
  f.transport.card = async () => structuredClone(f.card)
  let reads = 0
  const read = async () => {
    if (++reads === 2) f.card.properties['Waiting For ID'] = { id: 'blocker', type: 'rich_text', hasMore: false, value: 'independent-event' }
    return f.read()
  }
  await new ProductionWaitWriter(f.transport, read).run()
  expect(f.transport.transition).not.toHaveBeenCalled()
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** Exercise the real reservation, source-operation and Notion receipt path. */
async function reservedFixture() {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'production-wait-reservations-')); roots.push(root)
  const sourceId = 'd'.repeat(32), comments: Array<{ id: string; rich_text: unknown }> = []
  let loseNote = true, losePatch = false, patches = 0
  const page = () => ({ object: 'page', id: f.card.id, parent: { data_source_id: sourceId }, last_edited_time: new Date().toISOString(),
    properties: Object.fromEntries(Object.entries(f.card.properties).map(([name, prop]) => [name, { type: prop.type,
      [prop.type!]: ['select', 'status'].includes(prop.type!) ? prop.value ? { name: prop.value } : null : ['rich_text', 'title'].includes(prop.type!) ? [{ text: { content: String(prop.value ?? '') } }] : prop.value }])) })
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : null
    if (path === '/v1/comments' && method === 'POST') {
      comments.push({ id: `comment-${comments.length}`, rich_text: body.rich_text })
      if (loseNote) { loseNote = false; throw new Error('Applied audit, lost response') }
      return Response.json(comments.at(-1))
    }
    if (path === '/v1/comments') return Response.json({ results: comments, has_more: false })
    if (path === `/v1/pages/${f.card.id}`) {
      if (method === 'PATCH') {
        patches++
        f.card.properties.Status!.value = body.properties.Status.status?.name ?? body.properties.Status.select?.name
        if (losePatch) { losePatch = false; throw new Error('Applied mutable status, lost response') }
      }
      return Response.json(page())
    }
    return Response.json({}, { status: 404 })
  }
  const reader = new WorkReader({ token: 'test-token', dataSourceId: sourceId }, new NotionApi(fetcher, 0))
  reader.leases = new CardLeases(root)
  const transport = notionReleaseTransport(reader)
  return { ...f, root, reader, transport, comments, patches: () => patches, losePatch: () => { loseNote = false; losePatch = true } }
}

it.each([false, true])('recovers an applied audit across restart with a durable reservation (new production release: %s)', async newerRelease => {
  const f = await reservedFixture()
  expect(await new ProductionWaitWriter(f.transport, f.read).run()).toEqual({ completed: [], unconfirmed: [f.card.id] })
  expect(f.reader.leases!.pendingWrites()).toEqual([expect.objectContaining({ card: f.card.id, source_operation: expect.any(String) })])
  expect(f.comments).toHaveLength(1)
  if (newerRelease) { f.release.sourceSha = 'e'.repeat(40); f.release.version = 'v1.1.0'; f.release.id = 'owner/repo:tag:v1.1.0' }
  const reader = new WorkReader(f.reader.config, f.reader.api); reader.leases = new CardLeases(f.root)
  expect(await new ProductionWaitWriter(notionReleaseTransport(reader), f.read).run()).toEqual({ completed: [f.card.id], unconfirmed: [] })
  expect(reader.leases.pendingWrites()).toEqual([])
  expect(reader.leases.events().some(event => (event as { type: string }).type === 'write-marker-recovered')).toBe(true)
  expect(f.comments).toHaveLength(newerRelease ? 2 : 1)
  expect(f.patches()).toBe(1)
  expect(f.card.properties.Status!.value).toBe('Done')
})

it('retains the source fence for an uncertain mutable status PATCH', async () => {
  const f = await reservedFixture(); f.losePatch()
  expect(await new ProductionWaitWriter(f.transport, f.read).run()).toEqual({ completed: [], unconfirmed: [f.card.id] })
  expect(f.reader.leases!.pendingWrites()).toEqual([expect.objectContaining({ intent: expect.stringContaining('"kind":"properties"') })])
  await new ProductionWaitWriter(f.transport, f.read).run()
  expect(f.reader.leases!.pendingWrites()).toHaveLength(1)
  expect(f.patches()).toBe(1)
})
