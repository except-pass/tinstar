import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixtureSources, fixtureId } from '../../../../test-fixtures/reconciliation/scenes'
import { namesMain, mainWaitField, MAIN_WAIT_INTERVAL as FOUR_HOURS, waitAlertDue, type MainWaitItem } from '../../../shared/waitingOnMain'
import { MAIN_WAIT_CARD, MAIN_WAIT_OWNER, mainWaitCandidates, mainWaitComment, mainWaitNotifier, parentAskClosed, WaitingOnMain } from '../waitingOnMain'
import { NotionApi } from '../notionApi'
import { fleetObservation } from '../fleet'
import { ReconciliationSources } from '../index'

const now = Date.parse('2026-11-11T12:00:00Z')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'main-wait-')); roots.push(path); return path }
function snapshot(at = now) {
  const value = fixtureSources({ now: at })
  value.fleet[0]!.source.label = 'main'
  for (const row of value.fleet.slice(1)) row.observation.data!.parent_asks = { status: 'known', observed_at: new Date(at).toISOString(), items: [] }
  const card = value.intentions.data!.cards.find(card => card.id === fixtureId(4))!
  card.properties['Waiting For']!.value = 'First Mate (main): approve rollout'
  card.last_edited_time = new Date(now - FOUR_HOURS).toISOString()
  value.fleet[1]!.observation.data!.parent_asks!.items = [{ key: 'approve-api', corr: '1234567890abcdef', state: 'needs-decision', at: (now - FOUR_HOURS - 3600_000) / 1000, text: 'Choose the API' }]
  return value
}
const item = (key = fixtureId(4)): MainWaitItem => ({ id: 'card:' + key, source: 'board', kind: 'card', label: 'Rollout', key, text: 'First Mate: approve', since: new Date(now - FOUR_HOURS).toISOString(), ageBasis: 'at least', url: null, fresh: true })
const askAt = (now - FOUR_HOURS - 3600_000) / 1000
const mateItems = (value: ReturnType<typeof snapshot>) => mainWaitCandidates(value, now).items.filter(row => row.kind === 'mate')
function publishResolutions(value: ReturnType<typeof snapshot>, keys: { key: string; at: number }[], status: 'known' | 'unknown' = 'known') {
  const child = value.fleet[1]!
  const mate = structuredClone(child.observation.data!.tasks[0]!)
  mate.id = 'hulk'
  mate.kind = 'secondmate'
  mate.paths = { home: child.source.home, worktree: mate.paths.worktree }
  const main = value.fleet[0]!.observation.data!
  main.tasks = [mate]
  main.parent_resolutions = { status: 'known', observed_at: new Date(now).toISOString(), mates: { hulk: { status, keys } } }
  return value
}

describe('Waiting on main', () => {
  it.each(['First Mate', ' first mate (MAIN) ', 'Main', 'main firstmate'])('matches the whole main identity %s', value => expect(namesMain(value)).toBe(true))
  it.each(['mainly', 'domain:', 'First Mate (hulk)', 'Will', 'main firstmates', 'via mainframe', 'firstmate maintainer', 'Firstmate', 'via main', 'First Mate: decide'])('does not match identity %s', value => expect(namesMain(value)).toBe(false))
  it.each(['First Mate: review', 'First Mate (main): fix ...', 'Main - choose', 'main firstmate: decide', 'waiting via main for review'])('matches routed text only when ID is empty: %s', value => {
    expect(mainWaitField(value, '  ')).toBe('Waiting For')
    expect(mainWaitField(value, 'Will')).toBeNull()
  })
  it.each([
    ['Will', 'Will: press refresh tools, then the ChatGPT -> Tin Star -> Notion -> First Mate handoff proof'],
    ['firstmate maintainer', 'A First Mate decision cannot carry the proof'],
    ['', 'Firstmate: fix the second mate'],
    ['', 'The proof needs a First Mate decision'],
  ])('excludes prose mentions and non-main actors (%s)', (id, text) => {
    const value = snapshot(), card = value.intentions.data!.cards.find(card => card.id === fixtureId(4))!
    card.properties['Waiting For']!.value = text
    card.properties['Waiting For ID'] = { id: 'id', type: 'rich_text', value: id, hasMore: false }
    expect(mainWaitCandidates(value, now).items.filter(item => item.kind === 'card')).toHaveLength(0)
  })
  it('matches Waiting For ID and excludes completed cards and asks to a different parent', () => {
    const value = snapshot()
    const card = value.intentions.data!.cards.find(card => card.id === fixtureId(4))!
    card.properties['Waiting For']!.value = 'Review'
    card.properties['Waiting For ID'] = { id: 'id', type: 'rich_text', value: ' First Mate ', hasMore: false }
    expect(mainWaitField('Review', ' First Mate ')).toBe('Waiting For ID')
    expect(mainWaitCandidates(value, now).items).toHaveLength(2)
    card.properties.Status!.value = 'Done'
    value.fleet[1]!.source.parentHome = value.fleet[2]!.source.home
    expect(mainWaitCandidates(value, now).items).toHaveLength(0)
  })
  it('keeps missing and stale parent asks unknown, independently of backlog coverage', () => {
    const value = snapshot()
    delete value.fleet[1]!.observation.data!.parent_asks
    expect(mainWaitCandidates(value, now).unknown.join(' ')).toMatch(/parent asks unknown/)
    value.fleet[1]!.observation.status = 'stale'
    value.fleet[1]!.observation.error = 'Read failed'
    value.fleet[1]!.observation.data!.parent_asks = snapshot().fleet[1]!.observation.data!.parent_asks
    expect(mainWaitCandidates(value, now).items.find(item => item.kind === 'mate')?.fresh).toBe(false)
  })
  it('shows an open ageless ask without inventing an overdue age', () => {
    const value = snapshot(), asks = value.fleet[1]!.observation.data!.parent_asks!
    asks.status = 'unknown'
    asks.items[0]!.at = null
    const projected = mainWaitCandidates(value, now)
    const ask = projected.items.find(row => row.kind === 'mate')!
    expect(ask).toMatchObject({ key: 'approve-api', since: null, fresh: false })
    expect(projected.unknown.join(' ')).toMatch(/parent asks unknown/)
    expect(waitAlertDue(ask.since, null, now)).toBe(false)
  })
  it('accepts fresh ask coverage even when unrelated task metadata is partial', () => {
    const value = snapshot()
    value.fleet[1]!.observation.status = 'stale'
    value.fleet[1]!.observation.coverage = 'partial'
    expect(mainWaitCandidates(value, now).items.find(row => row.kind === 'mate')?.fresh).toBe(true)
    value.fleet[1]!.observation.data!.generated = new Date(now - 300_000).toISOString()
    expect(mainWaitCandidates(value, now).items.find(row => row.kind === 'mate')?.fresh).toBe(false)
  })
  it('keeps the backstop global when a tool asks for a filtered scene', async () => {
    const directory = await root(), full = snapshot(), filtered = snapshot()
    filtered.intentions.data!.cards = []
    const sources = new ReconciliationSources({ fleet: [], warnings: [] }, fetch, undefined, directory)
    vi.spyOn(sources, 'snapshot').mockImplementation(async (_force, scope) => ({ ...(scope?.owner ? filtered : full), diagnostics: { notion: sources.notionApi.diagnostics } }))
    const waiting = vi.fn(async (value: typeof full) => ({ items: mainWaitCandidates(value, now).items, unknown: [] }))
    sources.waitingOnMain = waiting
    const scene = await sources.scene(false, { owner: 'Will' })
    expect(scene.cards).toHaveLength(0)
    expect(scene.waitingOnMain?.items).toHaveLength(2)
    expect(waiting.mock.calls[0]?.[0].intentions).toBe(full.intentions)
  })
  it('enforces the exact four-hour boundary', () => {
    expect(waitAlertDue(new Date(now - FOUR_HOURS + 1).toISOString(), null, now)).toBe(false)
    expect(waitAlertDue(item().since, null, now)).toBe(true)
    expect(waitAlertDue(item().since, now - FOUR_HOURS + 1, now)).toBe(false)
    expect(waitAlertDue(item().since, now - FOUR_HOURS, now)).toBe(true)
    expect(waitAlertDue(null, null, now)).toBe(false)
  })
  it('posts one first-run summary, persists every throttle across restart, and repeats per item at 4h', async () => {
    const directory = await root(), notify = vi.fn<ReturnType<typeof mainWaitNotifier>>(async () => 'mentioned' as const)
    let time = now
    const read = () => Promise.resolve(snapshot(time))
    const create = () => new WaitingOnMain(read, notify, directory, async () => true, () => time)
    await create().refresh(snapshot()) // A browser read must not consume initialization.
    await create().sweep()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toHaveLength(2)
    expect((await create().sweep()).items.every(row => row.alert === 'mentioned')).toBe(true)
    time += FOUR_HOURS - 1
    await create().sweep()
    expect(notify).toHaveBeenCalledTimes(1)
    time++
    await create().sweep()
    expect(notify).toHaveBeenCalledTimes(3)
    expect(Array.isArray(notify.mock.calls[1]![0])).toBe(false)
  })
  it('starts with an empty census then alerts a newly crossing item individually', async () => {
    const directory = await root(), notify = vi.fn<ReturnType<typeof mainWaitNotifier>>(async () => 'mentioned' as const)
    let time = now
    const value = snapshot()
    value.fleet[1]!.observation.data!.parent_asks!.items = []
    const card = value.intentions.data!.cards.find(card => card.id === fixtureId(4))!
    card.last_edited_time = new Date(now - FOUR_HOURS + 60_000).toISOString()
    const service = new WaitingOnMain(async () => value, notify, directory, async () => true, () => time)
    await service.sweep()
    expect(notify).not.toHaveBeenCalled()
    time += 60_000
    value.intentions.expiresAt = new Date(time + 60_000).toISOString()
    await service.sweep()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(Array.isArray(notify.mock.calls[0]![0])).toBe(false)
  })
  it('reserves before a lost delivery response and does not spam after restart', async () => {
    const directory = await root(), notify = vi.fn<ReturnType<typeof mainWaitNotifier>>(async () => { throw new Error('lost response') })
    const service = () => new WaitingOnMain(async () => snapshot(), notify, directory, async () => true, () => now)
    expect((await service().sweep()).error).toBeTruthy()
    await service().sweep()
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('retains unknown records and stable card age, and closes only after fresh absence', async () => {
    const directory = await root(), notify = vi.fn<ReturnType<typeof mainWaitNotifier>>(async () => 'mentioned' as const)
    const service = new WaitingOnMain(async () => snapshot(), notify, directory, async () => false, () => now)
    await service.sweep()
    const value = snapshot()
    value.intentions.data!.cards.find(card => card.id === fixtureId(4))!.last_edited_time = new Date(now).toISOString()
    expect((await service.refresh(value)).items.find(item => item.kind === 'card')!.since).toBe(item().since)
    value.fleet[1]!.observation.data!.parent_asks = { status: 'unknown', observed_at: new Date(now).toISOString(), items: [] }
    expect((await service.refresh(value)).items).toHaveLength(2)
    value.fleet[1]!.observation.data!.parent_asks.status = 'known'
    expect((await service.refresh(value)).items).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled()
  })
  it('builds mentioned card, mate and complete startup-summary comment payloads', () => {
    const payload = mainWaitComment(item(), true, now)
    expect(payload.parent.page_id).toBe(fixtureId(4))
    expect(payload.rich_text[0]).toEqual({ type: 'mention', mention: { type: 'user', user: { object: 'user', id: MAIN_WAIT_OWNER } } })
    const mate = { ...item('decision'), kind: 'mate' as const, text: 'x'.repeat(3000) }
    expect(mainWaitComment(mate, false, now).parent.page_id).toBe(MAIN_WAIT_CARD)
    const summary = mainWaitComment([item(), mate], true, now)
    expect(summary.parent.page_id).toBe(MAIN_WAIT_CARD)
    expect(JSON.stringify(summary)).toContain('2 existing overdue items')
    expect(summary.rich_text.filter(row => row.type === 'text').map(row => 'text' in row ? row.text.content : '').join('')).toContain('x'.repeat(199) + '…')
    expect(JSON.stringify(summary)).not.toContain('x'.repeat(201))
    expect(JSON.stringify(mainWaitComment(mate, false, now))).toContain('x'.repeat(199) + '…')
  })
  it('uses the existing client and falls back to a plain comment on missing person capability', async () => {
    const bodies: unknown[] = []
    const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') { bodies.push(JSON.parse(String(init.body))); return Response.json({ id: 'comment' }) }
      return Response.json({ code: 'restricted_resource' }, { status: 403 })
    })
    const notify = mainWaitNotifier({ token: 'test-only', dataSourceId: fixtureId(999) }, new NotionApi(transport as typeof fetch, 0))
    expect(await notify(item(), now)).toBe('plain-comment')
    expect(JSON.stringify(bodies)).not.toContain('mention')
    expect(transport.mock.calls).toHaveLength(2)
  })
  it('sends a real person mention payload and only retries a definite mention rejection as plain text', async () => {
    const bodies: unknown[] = []
    const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json({ id: MAIN_WAIT_OWNER, type: 'person' })
      bodies.push(JSON.parse(String(init.body)))
      return bodies.length === 1 ? Response.json({ code: 'validation_error' }, { status: 400 }) : Response.json({ id: 'plain-comment' })
    })
    const notify = mainWaitNotifier({ token: 'test-only', dataSourceId: fixtureId(999) }, new NotionApi(transport as typeof fetch, 0))
    expect(await notify([item()], now)).toBe('plain-comment')
    expect(JSON.stringify(bodies[0])).toContain(MAIN_WAIT_OWNER)
    expect(JSON.stringify(bodies[1])).not.toContain('mention')
  })
  it.each(['lookup', 'rejection'])('persists %s fallback as undelivered and retries mentions after four hours', async failure => {
    const directory = await root()
    let time = now, available = false
    const bodies: { rich_text: { type: string }[] }[] = []
    const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method !== 'POST') return !available && failure === 'lookup'
        ? Response.json({}, { status: 403 }) : Response.json({ id: MAIN_WAIT_OWNER, type: 'person' })
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      return !available && body.rich_text.some((row: { type: string }) => row.type === 'mention')
        ? Response.json({}, { status: 400 }) : Response.json({ id: 'comment' })
    })
    const notify = mainWaitNotifier({ token: 'test-only', dataSourceId: fixtureId(999) }, new NotionApi(transport as typeof fetch, 0))
    const create = () => new WaitingOnMain(async () => snapshot(time), notify, directory, async () => true, () => time)
    expect((await create().sweep()).items.every(row => row.alert === 'plain-comment')).toBe(true)
    const attempts = bodies.length
    available = true
    time += FOUR_HOURS - 1
    expect((await create().sweep()).items.every(row => row.alert === 'plain-comment')).toBe(true)
    expect(bodies).toHaveLength(attempts)
    time++
    expect((await create().sweep()).items.every(row => row.alert === 'mentioned')).toBe(true)
    expect(bodies).toHaveLength(attempts + 2)
    expect(bodies.slice(attempts).every(body => body.rich_text.some(row => row.type === 'mention'))).toBe(true)
  })
  it('reports ambiguous transport failure without posting a duplicate fallback', async () => {
    const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('response lost')
      return Response.json({ id: MAIN_WAIT_OWNER, type: 'person' })
    })
    const notify = mainWaitNotifier({ token: 'test-only', dataSourceId: fixtureId(999) }, new NotionApi(transport as typeof fetch, 0))
    expect(await notify(item(), now)).toBe('unconfirmed')
    expect(transport.mock.calls).toHaveLength(2)
  })
  it('omits an ask the mate channel already closed with a later resolved line', () => {
    const value = snapshot()
    value.fleet[1]!.observation.data!.parent_asks!.items = [
      { key: 'still-open', corr: null, state: 'blocked', at: askAt, text: 'access' },
    ]
    expect(mateItems(value).map(row => row.key)).toEqual(['still-open'])
  })
  it('closes an ask main resolved at or after the ask', () => {
    const value = publishResolutions(snapshot(), [{ key: 'approve-api', at: askAt }])
    expect(mateItems(value)).toHaveLength(0)
    value.fleet[1]!.observation.data!.parent_asks!.items[0]!.at = null
    expect(mateItems(value)).toHaveLength(1)
  })
  it('keeps an ask newer than main\'s resolution', () => {
    const value = publishResolutions(snapshot(), [{ key: 'approve-api', at: askAt - 1 }, { key: 'other', at: askAt + 10 }])
    expect(mateItems(value).map(row => row.key)).toEqual(['approve-api'])
  })
  it('keeps an ask when main data is missing, stale, or unknown', () => {
    expect(parentAskClosed({ key: 'approve-api', at: askAt }, undefined)).toBe(false)
    expect(mateItems(snapshot()).map(row => row.key)).toEqual(['approve-api'])
    const stale = publishResolutions(snapshot(), [{ key: 'approve-api', at: askAt }])
    stale.fleet[0]!.observation.data!.generated = new Date(now - 300_000).toISOString()
    expect(mateItems(stale).map(row => row.key)).toEqual(['approve-api'])
    const unknown = publishResolutions(snapshot(), [{ key: 'approve-api', at: askAt }], 'unknown')
    expect(mateItems(unknown).map(row => row.key)).toEqual(['approve-api'])
  })
  it('drops a retained ask once a fresh main resolution closes it', async () => {
    const directory = await root()
    const value = snapshot()
    const service = new WaitingOnMain(async () => value, async () => 'disabled', directory, async () => false, () => now)
    expect((await service.sweep()).items.some(row => row.key === 'approve-api')).toBe(true)
    publishResolutions(value, [{ key: 'approve-api', at: askAt }])
    expect((await service.refresh(value)).items.some(row => row.key === 'approve-api')).toBe(false)
  })
  it('carries parent asks on the snapshot read path and treats malformed fields as unknown', async () => {
    const directory = await root(), file = join(directory, 'snapshot.json')
    const raw = { schema: 'fm-fleet-snapshot.v1', fm_home: directory, generated: new Date().toISOString(), tasks: [], backlog: { present: true, records: [] }, main_inventory: { valid: true }, parent_asks: { status: 'known', observed_at: new Date().toISOString(), items: [] } }
    await writeFile(file, JSON.stringify(raw))
    expect((await fleetObservation({ home: directory, snapshotFile: file }).get()).data?.parent_asks?.status).toBe('known')
    const ageless = { status: 'unknown', observed_at: raw.generated, items: [
      { key: 'ageless', corr: null, state: 'blocked', at: null, text: 'Access needed' },
    ] }
    await writeFile(file, JSON.stringify({ ...raw, parent_asks: ageless }))
    expect((await fleetObservation({ home: directory, snapshotFile: file }).get()).data?.parent_asks).toEqual(ageless)
    await writeFile(file, JSON.stringify({ ...raw, parent_asks: { status: 'known' } }))
    expect((await fleetObservation({ home: directory, snapshotFile: file }).get()).data?.parent_asks).toBeUndefined()
    const resolutions = { status: 'known', observed_at: raw.generated, mates: { hulk: { status: 'known', keys: [{ key: 'approve-api', at: 200 }] } } }
    await writeFile(file, JSON.stringify({ ...raw, parent_resolutions: resolutions }))
    expect((await fleetObservation({ home: directory, snapshotFile: file }).get()).data?.parent_resolutions).toEqual(resolutions)
    await writeFile(file, JSON.stringify({ ...raw, parent_resolutions: { status: 'known' } }))
    expect((await fleetObservation({ home: directory, snapshotFile: file }).get()).data?.parent_resolutions).toBeUndefined()
  })
})
