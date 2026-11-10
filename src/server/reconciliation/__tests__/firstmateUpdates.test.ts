import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AskApi } from '../../ask/routes'
import { FirstmateUpdates } from '../firstmateUpdates'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { inboxRequestId } from '../../../shared/ask'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-updates-')); roots.push(root)
  const observation = fixtureSources().intentions
  const card = structuredClone(observation.data!.cards[0]!)
  card.properties.Owner = { ...card.properties.Owner!, value: 'Firstmate' }
  card.properties.Status = { ...card.properties.Status!, value: 'Queued' }
  card.properties['Last touched by'] = { ...card.properties['Last touched by']!, value: 'Owner' }
  observation.status = 'fresh'; observation.coverage = 'complete'; observation.data!.cards = [card]
  let now = Date.now()
  const context = { outcome: 'available' as const, blocks: [] as Array<{ id: string; type: string; text: string; author?: string; createdAt?: string }> }
  const sources = { firstmateWork: vi.fn(async () => structuredClone(observation)), currentCard: vi.fn(async (id: string) => {
    const found = observation.data!.cards.find(card => card.id === id)
    if (!found) throw new Error('unavailable')
    return structuredClone(found)
  }), updateContext: vi.fn(async () => structuredClone(context)) }
  const settings = async () => ({ deliveryEnabled: true })
  const feed = new FirstmateUpdates(sources, root, settings, () => now)
  return { root, observation, card, sources, context, feed, settings, now: () => now, advance: (ms = 10_001) => { now += ms }, restarted: () => new FirstmateUpdates(sources, root, settings, () => now) }
}
const payload = (body: string) => JSON.parse(body.slice(body.indexOf('\n') + 1))
async function delivered(feed: FirstmateUpdates, notice: { request_id: string }) {
  await feed.ingest({ request_id: notice.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', saved: true, acknowledged: false, id: '42', request_id: inboxRequestId(notice.request_id), announced: true } })
}

describe('Firstmate current-state pickup/update bridge', () => {
  it('delivers only Queued pickups, retries the same inbox identity across restart, and accepts legitimate later requeues', async () => {
    const f = await fixture()
    await f.feed.sweep(true); f.advance()
    const first = (await f.feed.bridgeWork()).pending
    expect(first).toHaveLength(1); expect(payload(first[0]!.body).changes[0]).toMatchObject({ kind: 'pickup', card_id: f.card.id })
    expect((await f.restarted().bridgeWork()).pending).toEqual(first)
    await delivered(f.feed, first[0]!)
    await f.feed.sweep(true); expect((await f.feed.bridgeWork()).pending).toEqual([])
    const before = structuredClone(f.card)
    f.card.properties.Status!.value = 'In Progress'
    await f.feed.confirmed({ before, card: structuredClone(f.card), actor: 'Firstmate', operationId: 'real-start' })
    const active = structuredClone(f.card)
    f.card.properties.Status!.value = 'Queued'
    await f.feed.confirmed({ before: active, card: structuredClone(f.card), actor: 'Owner', operationId: 'requeue' })
    f.advance()
    const requeued = (await f.feed.bridgeWork()).pending
    expect(requeued).toHaveLength(1)
    expect(requeued[0]!.request_id).not.toBe(first[0]!.request_id)
    expect(payload(requeued[0]!.body).changes[0].kind).toBe('pickup')
  })
  it('coalesces actor batches, includes available property/comment/body changes, and suppresses authenticated Firstmate self-edits', async () => {
    const f = await fixture()
    f.card.properties.Status!.value = 'In Progress'
    const other = structuredClone(f.card); other.id = 'e'.repeat(32)
    f.observation.data!.cards.push(other)
    await f.feed.sweep(true)
    for (const card of [f.card, other]) {
      const before = structuredClone(card)
      card.properties['Last touched by']!.value = 'Firstmate' // Not the authenticated actor.
      card.properties['Waiting For'] = { ...card.properties['Waiting For']!, value: 'Owner supplied acceptance' }
      await f.feed.confirmed({ before, card: structuredClone(card), actor: 'ChatGPT', operationId: `update-${card.id}`, notes: ['Customer accepted output'], sections: ['brief'] })
    }
    f.advance()
    const notices = (await f.feed.bridgeWork()).pending
    expect(notices).toHaveLength(1)
    const batch = payload(notices[0]!.body)
    expect(batch.actor).toBe('ChatGPT'); expect(batch.changes).toHaveLength(2)
    expect(batch.changes[0]).toMatchObject({ kind: 'update', properties: { 'Waiting For': { after: 'Owner supplied acceptance' } }, comments: [{ author: 'ChatGPT', text: 'Customer accepted output' }], body_sections: ['brief'] })
    await delivered(f.feed, notices[0]!)
    const before = structuredClone(f.card)
    f.card.properties['Last touched by']!.value = 'Owner'
    await f.feed.confirmed({ before, card: structuredClone(f.card), actor: 'Firstmate', operationId: 'self-update', notes: ['No self wake'] })
    f.advance(); expect((await f.feed.bridgeWork()).pending).toHaveLength(0)
  })
  it('coalesces the latest current context and URL with the final property diff', async () => {
    const f = await fixture(); f.card.properties.Status!.value = 'In Progress'
    await f.feed.sweep(true)
    for (const status of ['Waiting For', 'In Progress']) {
      const before = structuredClone(f.card)
      f.card.properties.Status!.value = status
      f.card.url = `https://notion.so/${status}`
      await f.feed.confirmed({ before, card: structuredClone(f.card), actor: 'Owner', operationId: status })
    }
    f.advance()
    const notices = (await f.feed.bridgeWork()).pending
    const update = notices.flatMap(notice => payload(notice.body).changes).find((item: any) => item.kind === 'update')
    expect(update).toMatchObject({ current: { Status: 'In Progress' }, card_url: 'https://notion.so/In Progress', properties: { Status: { before: 'In Progress', after: 'In Progress' } } })
  })
  it('uses a small targeted property census; direct edits fetch details only after a relevant active change', async () => {
    const f = await fixture(); f.card.properties.Status!.value = 'Waiting For'
    await f.feed.sweep(true)
    expect(f.sources.updateContext).not.toHaveBeenCalled()
    f.advance(60_000)
    f.card.last_edited_time = new Date(f.now()).toISOString()
    f.card.properties['Last touched by']!.value = 'Owner'
    f.context.blocks.push({ id: 'comment-new', type: 'comment', text: 'Approved version', author: 'author-id', createdAt: new Date(f.now()).toISOString() })
    await f.feed.sweep(true); f.advance()
    const updates = (await f.feed.bridgeWork()).pending
    expect(updates).toHaveLength(1)
    expect(payload(updates[0]!.body).changes[0]).toMatchObject({ kind: 'update', comments: [{ author: 'author-id', text: 'Approved version' }] })
    expect(f.sources.updateContext).toHaveBeenCalledTimes(1)
    await delivered(f.feed, updates[0]!)
    await f.feed.sweep(true)
    expect(f.sources.updateContext).toHaveBeenCalledTimes(1)
    f.observation.status = 'unavailable' as typeof f.observation.status
    f.observation.data!.cards = []
    await f.feed.sweep(true)
    const persisted = JSON.parse(await readFile(f.feed.path, 'utf8'))
    expect(persisted.cards[f.card.id]).toBeDefined() // Source failure is not deletion.
  })
  it('does not deliver stale pickups or turn active updates into a new dispatch', async () => {
    const f = await fixture(); await f.feed.sweep(true)
    f.card.properties.Status!.value = 'In Progress'; f.advance()
    expect((await f.feed.bridgeWork()).pending).toHaveLength(0)
    const before = structuredClone(f.card); f.card.properties.Status!.value = 'Waiting For'
    await f.feed.confirmed({ before, card: structuredClone(f.card), actor: 'Consumer', operationId: 'wait', notes: ['Dependency not yet accepted'] })
    f.advance()
    const notices = (await f.feed.bridgeWork()).pending
    expect(notices).toHaveLength(1); expect(payload(notices[0]!.body).changes.map((item: { kind: string }) => item.kind)).toEqual(['update'])
  })
  it('disables preview delivery and preserves failed wakes for the same request retry', async () => {
    const f = await fixture(); await f.feed.sweep(true); f.advance()
    const disabled = new FirstmateUpdates(f.sources, f.root, async () => ({ deliveryEnabled: false }), f.now)
    expect(await disabled.bridgeWork()).toEqual({ pending: [], tracked: [] })
    const notice = (await f.feed.bridgeWork()).pending[0]!
    await f.feed.ingest({ request_id: notice.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', saved: true, acknowledged: false, id: '42', request_id: inboxRequestId(notice.request_id), announced: false } })
    expect((await f.feed.bridgeWork()).pending[0]).toEqual(notice)
    await expect(f.feed.ingest({ request_id: notice.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', saved: true, acknowledged: false, id: '999', request_id: inboxRequestId(notice.request_id), announced: true } })).rejects.toThrow('does not match')
    await delivered(f.feed, notice); expect((await f.feed.bridgeWork()).pending).toEqual([])
  })
  it.each(['6.0.0', '6.0.1'])('delivers via the existing authenticated Ask route and unchanged published %s puller', async version => {
    const f = await fixture(); await f.feed.sweep(true); f.advance()
    const token = 'fixture-bridge-token-'.repeat(3)
    const api = new AskApi({ scene: async () => { throw new Error('No UI needed') } }, f.root, async () => ({ ownerLogins: ['owner@example.test'], bridgeToken: token }), undefined, undefined, f.feed)
    const server = createServer((req, res) => { void api.handle(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      expect((await fetch(`${base}/api/ask/bridge`)).status).toBe(401)
      const home = join(f.root, 'fixture-firstmate'), bin = join(home, 'bin')
      await mkdir(bin, { recursive: true })
      const exec = promisify(execFile), python = (await exec('python3', ['-c', 'import sys; print(sys.executable)'])).stdout.trim()
      await writeFile(join(bin, 'fm-inbox.sh'), `#!${python}
import json,pathlib,sys
p=pathlib.Path(__file__).parent.parent/'notes.json'
rows=json.loads(p.read_text()) if p.exists() else []
if sys.argv[1]=='note':
    rid=sys.argv[sys.argv.index('--request-id')+1];body=sys.stdin.read()
    assert 'Tin Star WORKFLOW NOTICE' in body
    existing=next((r for r in rows if r['request_id']==rid),None)
    if existing is None:
        existing={'id':'fixture-note','request_id':rid,'body':body};rows.append(existing);p.write_text(json.dumps(rows))
    print(json.dumps({'schema':'fm-inbox-note.v1','outcome':'created','id':existing['id'],'request_id':rid,'saved':True,'announced':True,'acknowledged':False}))
else:
    print(json.dumps({'schema':'fm-inbox-receipts.v1','pending':[],'handled':[],'omitted':[]}))
`)
      await chmod(join(bin, 'fm-inbox.sh'), 0o700)
      const driver = `import importlib.util,pathlib,sys,json
s=importlib.util.spec_from_file_location('puller',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.pull_once(sys.argv[2],sys.argv[3],pathlib.Path(sys.argv[4]))))`
      const run = async () => JSON.parse((await exec(python, ['-B', '-c', driver, resolve(`test-fixtures/published-puller/${version}/ask-puller.py`), base, token, home], { env: { HOME: home, PATH: bin }, timeout: 20_000 })).stdout)
      expect(await run()).toMatchObject({ captured: 1, replied: 0, failed: 0 })
      expect(await run()).toMatchObject({ captured: 0, replied: 0, failed: 0 })
      expect(JSON.parse(await readFile(join(home, 'notes.json'), 'utf8'))).toHaveLength(1)
      expect(await api.store.list('owner@example.test')).toHaveLength(0) // No second Ask inbox.
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })

})

it('bounds slow pickup preflight and rotates to later ready batches without losing notices', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const f = await fixture()
    await f.feed.sweep(true)
    const other = structuredClone(f.card); other.id = 'e'.repeat(32)
    await f.feed.confirmed({ card: other, actor: 'Other', operationId: 'other-pickup' })
    f.sources.currentCard.mockImplementation(async id => {
      if (id === f.card.id) return await new Promise<never>(() => {})
      return structuredClone(other)
    })
    f.advance()
    const first = f.feed.bridgeWork()
    await vi.waitFor(() => expect(f.sources.currentCard).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(5000)
    expect((await first).pending).toEqual([])
    const second = (await f.feed.bridgeWork()).pending
    expect(second).toHaveLength(1)
    expect(payload(second[0]!.body).changes[0].card_id).toBe(other.id)
    const state = JSON.parse(await readFile(f.feed.path, 'utf8'))
    expect(state.batches.find((b: any) => b.items.some((item: any) => item.card_id === f.card.id)).announced).toBe(false)
  } finally { vi.useRealTimers() }
})

it('delivers healthy siblings from a twenty-card batch and rotates past an inaccessible pickup', async () => {
  const f = await fixture()
  const cards = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(f.card), id: index.toString(16).padStart(32, '0') }))
  for (const card of cards) await f.feed.confirmed({ card, actor: 'Owner', operationId: card.id })
  f.sources.currentCard.mockImplementation(async id => {
    if (id === cards[0]!.id) throw new Error('Unavailable')
    return structuredClone(cards.find(card => card.id === id)!)
  })
  f.advance()
  const seen = new Set<string>()
  for (let pull = 0; pull < 7; pull++) {
    f.sources.currentCard.mockClear()
    const notices = (await f.feed.bridgeWork()).pending
    expect(f.sources.currentCard.mock.calls.length).toBeLessThanOrEqual(4)
    for (const notice of notices) {
      for (const item of payload(notice.body).changes) {
        expect(seen.has(item.card_id)).toBe(false)
        seen.add(item.card_id)
      }
      await f.feed.ingest({ request_id: notice.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', saved: true, acknowledged: false, id: notice.request_id, request_id: inboxRequestId(notice.request_id), announced: true } })
    }
  }
  expect([...seen].sort()).toEqual(cards.slice(1).map(card => card.id).sort())
  const state = JSON.parse(await readFile(f.feed.path, 'utf8'))
  expect(state.batches.filter((batch: any) => !batch.announced).flatMap((batch: any) => batch.items.map((item: any) => item.card_id))).toEqual([cards[0]!.id])
  f.sources.currentCard.mockResolvedValue(structuredClone(cards[0]!))
  const recovered = (await f.restarted().bridgeWork()).pending
  expect(recovered).toHaveLength(1)
  expect(payload(recovered[0]!.body).changes[0].card_id).toBe(cards[0]!.id)
  expect((await f.restarted().bridgeWork()).pending).toEqual(recovered)
})

it.each(['dependency', 'body'])('delivers a direct human %s edit after a confirmed self-edit despite retained Last touched by', async edit => {
  const f = await fixture(); f.card.properties.Status!.value = 'In Progress'
  await f.feed.sweep(true)
  const before = structuredClone(f.card)
  f.advance()
  f.card.last_edited_time = new Date(f.now()).toISOString()
  f.card.properties['Last touched by']!.value = 'Firstmate'
  await f.feed.confirmed({ before, card: structuredClone(f.card), actor: 'Firstmate', operationId: 'confirmed-self', notes: ['Self update'] })
  await f.feed.sweep(true); f.advance()
  expect((await f.feed.bridgeWork()).pending).toEqual([])
  expect(f.sources.updateContext).not.toHaveBeenCalled()
  f.card.last_edited_time = new Date(f.now()).toISOString()
  if (edit === 'dependency') f.card.properties['Waiting For'] = { id: 'wait', type: 'rich_text', value: 'Human supplied dependency', hasMore: false }
  else f.context.blocks.push({ id: 'human-body', type: 'paragraph', text: 'Human revised acceptance' })
  await f.feed.sweep(true); f.advance()
  const notices = (await f.feed.bridgeWork()).pending
  expect(notices).toHaveLength(1)
  expect(payload(notices[0]!.body)).toMatchObject({ actor: 'Notion actor unknown', changes: [{ kind: 'update', current: { 'Last touched by': 'Firstmate' } }] })
  if (edit === 'dependency') expect(payload(notices[0]!.body).changes[0].properties['Waiting For'].after).toBe('Human supplied dependency')
  expect(f.sources.updateContext).toHaveBeenCalledTimes(1)
  await delivered(f.feed, notices[0]!)
  await f.feed.sweep(true); f.advance()
  expect((await f.feed.bridgeWork()).pending).toEqual([])
})
