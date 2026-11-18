import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fixtureId, fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { checkInCeiling, checkInKey, checkInTime, checkInIndicatorText } from '../../../shared/checkIn'
import { inboxRequestId } from '../../../shared/ask'
import { AskApi } from '../../ask/routes'
import { checkInDecisions, checkInReport, checkInSettings, CheckInWatchdog, CHECK_IN_GRACE_MS } from '../checkInWatchdog'
import { reconcileScene, SceneReconciler } from '../scene'
import { boundSearchDocuments, sceneSearchDocuments } from '../../../shared/searchDocuments'
import type { CheckInSnapshot } from '../index'
import type { CardContextRead } from '../cardContext'
import { readNotionCard } from '../notion'

const exec = promisify(execFile)
const baseline = Date.parse('2026-11-10T15:00:00Z')
const original = '2026-11-10T09:55:00-05:00'
const roots: string[] = []
let server: Server | undefined
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-checkin-test-')); roots.push(root)
  let now = baseline
  const snapshot = fixtureSources({ now })
  const card = snapshot.intentions.data!.cards.find(c => c.id === fixtureId(1))!
  for (const other of snapshot.intentions.data!.cards) delete other.properties['Next check-in']
  card.properties['Next check-in'] = { id: 'checkpoint', type: 'date', value: { start: original }, hasMore: false }
  card.properties['First Mate tasks']!.value = JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks: [{ fm_home: '/fixture/hulk', task_id: 'linked-worker', first_observed_spawn_gen: 'attempt-1' }] })
  let context: CardContextRead = { outcome: 'available', blocks: [{ id: 'previous', type: 'paragraph', text: 'Previous evidence-backed checkpoint' }] }
  const sources = {
    checkInSnapshot: async () => sources.snapshot(),
    snapshot: vi.fn(async () => {
      const current = structuredClone(snapshot)
      current.intentions.expiresAt = new Date(now + 60_000).toISOString()
      for (const home of current.fleet) home.observation.expiresAt = new Date(now + 60_000).toISOString()
      return current
    }),
    currentCard: vi.fn(async () => structuredClone(card)),
    currentCardContext: vi.fn(async () => structuredClone(context)),
  }
  let deliveryEnabled = true
  const make = (enabled?: boolean) => new CheckInWatchdog(sources, root, async () => ({ deliveryEnabled: enabled ?? deliveryEnabled }), () => now)
  const watchdog = make()
  const report = (requestId: string, next = '2026-11-10T17:00:00Z') => `Check-in request: ${requestId}\nDate: ${new Date(now).toISOString()}\nBy: Firstmate\nProgress: Implemented the checkpoint reader; delayed by a failing fixture.\nEvidence: https://example.test/pull/42 green test receipt\nBlocker/owner: none; Firstmate\nNext action: Validate the remaining delivery path\nNext check-in: ${next}`
  const publish = (requestId: string, next = '2026-11-10T17:00:00Z') => {
    context = { outcome: 'available', blocks: [{ id: 'actual-checkpoint', type: 'paragraph', created_time: new Date(now).toISOString(), text: report(requestId, next) }] }
    card.last_edited_time = new Date(now).toISOString()
    card.properties['Last touched by'] = { id: 'by', type: 'select', value: 'Firstmate', hasMore: false }
    card.properties['Next check-in']!.value = { start: next }
  }
  const note = async (id: string, announced = true) => watchdog.ingest({ request_id: id, note: {
    schema: 'fm-inbox-note.v1', outcome: 'created', id: 'note-' + id, request_id: inboxRequestId(id), saved: true, announced, acknowledged: false,
  } })
  const reply = async (id: string, body: string, cursor = '1') => watchdog.ingest({ request_id: id,
    reply: { id: 'note-' + id, body, at: new Date(now).toISOString(), cursor } })
  return { root, sources, snapshot, card, watchdog, make, report, publish, note, reply,
    setDeliveryEnabled: (enabled: boolean) => { deliveryEnabled = enabled },
    setContext: (value: CardContextRead) => { context = value }, time: () => now, advance: (ms: number) => { now += ms } }
}

describe('appointment clock and deterministic selection', () => {
  it.each([
    ['2026-03-07', '2026-03-07T14:00:00Z'], ['2026-03-08', '2026-03-08T13:00:00Z'],
    ['2026-11-01', '2026-11-01T14:00:00Z'], ['2026-10-31', '2026-10-31T13:00:00Z'],
    ['2026-11-10T10:00:00-05:00', '2026-11-10T15:00:00Z'], ['2026-11-10T17:00:00+02:00', '2026-11-10T15:00:00Z'],
    ['2026-11-10T10:00:00', '2026-11-10T15:00:00Z'],
  ])('interprets %s independently of host timezone', (value, expected) => {
    expect(checkInTime(value)).toBe(Date.parse(expected))
  })
  it('handles a Notion local timestamp with its explicit timezone and rejects malformed dates', () => {
    expect(checkInTime('2026-11-10T10:00:00', 'Europe/Paris')).toBe(Date.parse('2026-11-10T09:00:00Z'))
    expect(checkInTime('2026-11-10T10:00:00.123', 'Europe/Paris')).toBe(Date.parse('2026-11-10T09:00:00.123Z'))
    for (const value of [null, '', 'invalid', '2026-02-30', '2026-99-01']) expect(Number.isFinite(checkInTime(value))).toBe(false)
    expect(checkInKey(fixtureId(1), original)).toBe(checkInKey(fixtureId(1), '2026-11-10T14:55:00Z'))
  })
  it('uses the board ceiling across nights, weekends and DST', () => {
    expect(checkInCeiling(Date.parse('2026-11-10T15:00:00Z'))).toBe(Date.parse('2026-11-10T19:00:00Z'))
    expect(checkInCeiling(Date.parse('2026-11-10T02:00:00Z'))).toBe(Date.parse('2026-11-10T15:00:00Z'))
    expect(checkInCeiling(Date.parse('2026-11-10T11:00:00Z'))).toBe(Date.parse('2026-11-10T15:00:00Z'))
    expect(checkInCeiling(Date.parse('2026-10-31T02:00:00Z'))).toBe(Date.parse('2026-11-02T15:00:00Z'))
  })
  it.each(['Queued', 'Ready for Review', 'Waiting for Prod Release', 'Todo', 'Backlog', 'Spare tokens', 'Done', 'Archived', 'In review', 'Delegated to person'])('excludes %s', async status => {
    const h = await harness(); h.card.properties.Status!.value = status
    expect(checkInDecisions(h.snapshot, baseline).find(d => d.cardId === h.card.id)?.due).toBe(false)
  })
  it('requires an appointment strictly in the past, integrated owner and fresh Notion source', async () => {
    const h = await harness()
    const decision = () => checkInDecisions(h.snapshot, baseline).find(d => d.cardId === h.card.id)!
    expect(decision().due).toBe(true)
    h.card.properties['Next check-in']!.value = { start: '2026-11-10T15:00:00Z' }; expect(decision().due).toBe(false)
    h.card.properties['Next check-in']!.value = { start: '2026-11-10' }
    expect(decision().due).toBe(true)
    const card = reconcileScene(h.snapshot, Date.parse('2026-11-10T14:00:00Z')).cards.find(c => c.id === h.card.id)!
    expect(card.checkpoint.state).toBe('upcoming')
    expect(reconcileScene(h.snapshot, Date.parse('2026-11-10T14:00:00.001Z')).cards.find(c => c.id === h.card.id)!.checkpoint.state).toBe('overdue')
    h.card.properties.Owner!.value = 'Will'; expect(decision().due).toBe(false)
    h.card.properties.Owner!.value = 'Firstmate'; h.snapshot.intentions.status = 'stale'; expect(decision().due).toBe(false)
    h.snapshot.intentions.status = 'fresh'; h.card.archived = true; expect(decision().due).toBe(false)
  })
  it('selects a single exact active canonical worker and keeps all unresolved routes with First Mate', async () => {
    const h = await harness()
    const decision = () => checkInDecisions(h.snapshot, baseline).find(d => d.cardId === h.card.id)!
    expect(decision().route).toMatchObject({ via: 'firstmate', worker: { task: 'linked-worker', attempt: 'attempt-1', home: '/fixture/hulk' } })
    const task = h.snapshot.fleet[1]!.observation.data!.tasks[0]!
    for (const state of ['parked', 'done', 'waiting', 'blocked']) {
      task.current_state.state = state; task.last_event.state = state
      expect(decision().route.worker).toBeNull()
    }
    task.current_state.state = 'working'; task.last_event.state = 'working'
    h.snapshot.fleet[1]!.observation.status = 'stale'; expect(decision().route.worker).toBeNull()
    h.snapshot.fleet[1]!.observation.status = 'fresh'; task.identity.spawn_gen = 'new-attempt'; expect(decision().route.worker).toBeNull()
    task.identity.spawn_gen = 'attempt-1'; delete h.card.properties['First Mate tasks']; expect(decision().route.worker).toBeNull()
    h.card.properties['First Mate tasks'] = { id: 'links', type: 'rich_text', value: 'invalid', hasMore: false }; expect(decision().route.worker).toBeNull()
    h.snapshot.fleet[1]!.observation.data!.tasks = []; expect(decision().route.worker).toBeNull()
  })
  it('uses fresh Codex turn facts through the existing liveness classifier', async () => {
    const h = await harness(), task = h.snapshot.fleet[1]!.observation.data!.tasks[0]!
    task.current_state.state = 'unknown'
    task.codex = { turn_open: true, observed_at: new Date(baseline).toISOString(), last_activity_at: null, session_file: 'fixture' }
    const route = () => checkInDecisions(h.snapshot, baseline).find(d => d.cardId === h.card.id)!.route.worker
    expect(route()?.task).toBe('linked-worker')
    task.codex.turn_open = false; expect(route()).toBeNull()
    task.codex.turn_open = true; task.codex.observed_at = new Date(baseline - 300_000).toISOString(); expect(route()).toBeNull()
  })
  it('routes multiple canonical workers and a declared absent worker to First Mate', async () => {
    const h = await harness()
    const route = () => checkInDecisions(h.snapshot, baseline).find(d => d.cardId === h.card.id)!.route.worker
    const links = h.card.properties['First Mate tasks']!
    const one = JSON.parse(String(links.value))
    links.value = JSON.stringify({ ...one, tasks: [...one.tasks, { fm_home: '/fixture/bandit', task_id: 'helper-worker', first_observed_spawn_gen: 'attempt-1' }] })
    expect(route()).toBeNull()
    links.value = JSON.stringify(one)
    h.snapshot.fleet[1]!.observation.data!.tasks = []
    expect(route()).toBeNull()
  })
})

describe('durable lifecycle on the existing bridge', () => {
  it('persists once across refreshes, overlapping scans, two windows and restart; retries immutable delivery', async () => {
    const h = await harness()
    await Promise.all([h.watchdog.sweep(), h.watchdog.sweep(), h.watchdog.sweep()])
    expect(h.sources.snapshot).toHaveBeenCalledTimes(1)
    await h.watchdog.sweep(true)
    const restarted = h.make(); await restarted.sweep(true)
    const [a, b] = await Promise.all([h.watchdog.bridgeWork(), restarted.bridgeWork()])
    expect(a.pending).toHaveLength(1); expect(b.pending).toEqual(a.pending)
    const id = a.pending[0]!.request_id
    expect(a.pending[0]!.body).toContain('SYSTEM CHECK-IN REQUEST')
    expect(a.pending[0]!.body).toContain('"task":"linked-worker"')
    expect(a.pending[0]!.body).toContain('"original_checkpoint":"' + original + '"')
    await h.watchdog.ingest({ request_id: id, error: 'capture-failed' })
    expect((await h.make().bridgeWork()).pending).toEqual(a.pending)
    await h.note(id, false)
    expect((await h.make().bridgeWork()).pending).toEqual(a.pending)
    await h.note(id)
    expect((await h.make().bridgeWork()).pending).toEqual([])
    expect((await h.make().bridgeWork()).tracked).toEqual([{ request_id: id, note_id: 'note-' + id }])
    expect(await h.make().rows()).toHaveLength(1)
    expect((await stat(h.watchdog.path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(h.watchdog.path, 'utf8'))[0].request.requestId).toBe(id)
  })
  it.each(['checkpoint', 'status', 'owner', 'closed'])('rechecks the exact card before sending and suppresses changed %s', async change => {
    const h = await harness(); h.setDeliveryEnabled(false); await h.watchdog.sweep()
    if (change === 'checkpoint') h.card.properties['Next check-in']!.value = { start: '2026-11-10T17:00:00Z' }
    if (change === 'status') h.card.properties.Status!.value = 'Waiting For'
    if (change === 'owner') h.card.properties.Owner!.value = 'Will'
    if (change === 'closed') h.card.in_trash = true
    h.setDeliveryEnabled(true); await h.watchdog.sweep(true)
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
    expect(h.sources.currentCard).toHaveBeenCalledWith(h.card.id)
    expect((await h.watchdog.rows())[0]!.state).toBe('superseded')
  })
  it('reconciles a worker link changed since detection, and names the Waiting For dependency', async () => {
    const h = await harness(); h.setDeliveryEnabled(false); h.card.properties.Status!.value = 'Waiting For'
    h.card.properties['Waiting For'] = { id: 'wait', type: 'rich_text', value: 'Reviewer approval of the receipt', hasMore: false }
    await h.watchdog.sweep()
    h.card.properties['First Mate tasks']!.value = JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks: [] })
    h.setDeliveryEnabled(true); await h.watchdog.sweep(true)
    const body = (await h.watchdog.bridgeWork()).pending[0]!.body
    expect(body).toContain('Reviewer approval of the receipt')
    expect(body).toContain('Do not ask why coding has not progressed')
    expect(body).toContain('"worker":null')
  })
  it('keeps plain replies and property/status edits unresolved, and flags exactly one follow-up', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id); await h.reply(id, 'still working')
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]!.state).toBe('responded')
    expect((await h.watchdog.indicators()).get(h.card.id)?.answered).toBe(true)
    h.advance(CHECK_IN_GRACE_MS)
    await h.watchdog.sweep(true)
    const followUp = (await h.watchdog.bridgeWork()).pending[0]!
    expect(followUp.request_id).not.toBe(id); expect(followUp.body).toContain('SYSTEM CHECK-IN FOLLOW-UP')
    await h.note(followUp.request_id)
    h.advance(CHECK_IN_GRACE_MS * 4)
    await h.make().sweep(true)
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'needs-attention', originalCheckpoint: original, verifiedAt: null })
    h.card.properties.Status!.value = 'Done'; await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]!.verifiedAt).toBeNull()
  })
  it('accepts an evidence-backed acknowledgement but waits for attributed Notion readback, surviving restart', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id); await h.reply(id, h.report(id))
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]!.state).toBe('acknowledged')
    expect((await h.watchdog.rows())[0]!.verifiedAt).toBeNull()
    h.publish(id)
    await h.make().sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'resolved', verifiedAt: new Date(h.time()).toISOString() })
    expect((await h.make().indicators()).size).toBe(0)
    expect((await h.make().bridgeWork()).pending).toEqual([])
    await h.make().sweep(true); expect(await h.watchdog.rows()).toHaveLength(1)
  })
  it('repairs a pending readback from Notion after a plain immutable reply, without replacing that reply', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id); await h.reply(id, 'Updating Notion now')
    h.publish(id)
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]!.state).toBe('resolved')
    await h.reply(id, 'Updating Notion now') // duplicate transport cursor
    await expect(h.reply(id, 'Different immutable reply', '2')).rejects.toThrow('already recorded')
  })
  it.each(['empty', 'synthetic', 'unrelated', 'old-checkpoint'])('does not clear for %s evidence', async kind => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id)
    if (kind === 'empty') h.setContext({ outcome: 'available', blocks: [] })
    if (kind === 'synthetic') h.setContext({ outcome: 'available', blocks: [{ id: 'empty', type: 'paragraph', text: h.report(id).replace(/Evidence: .*/, 'Evidence: none') }] })
    if (kind === 'unrelated') h.publish(randomUUID())
    if (kind === 'old-checkpoint') h.setContext({ outcome: 'available', blocks: [{ id: 'old', type: 'paragraph', created_time: '2026-11-01T15:00:00Z', text: h.report(id).replace(new Date(h.time()).toISOString(), '2026-11-01T15:00:00Z') }] })
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]!.verifiedAt).toBeNull()
  })
  it('accepts a comment dated later in the same minute as minute-truncated last_edited_time', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id); await h.reply(id, 'Updating Notion now')
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'responded', verifiedAt: null })
    h.advance(42_000)
    h.setContext({ outcome: 'available', blocks: [{ id: 'live-comment', type: 'comment', created_time: '2026-11-10T15:00:00Z', text: h.report(id) }] })
    h.card.last_edited_time = '2026-11-10T15:00:00.000Z'
    h.card.properties['Last touched by'] = { id: 'by', type: 'select', value: 'Firstmate', hasMore: false }
    h.card.properties['Next check-in']!.value = { start: '2026-11-10T17:00:00Z' }
    expect(h.report(id)).toContain('Date: 2026-11-10T15:00:42.000Z')
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({
      state: 'resolved', verifiedAt: new Date(h.time()).toISOString(),
      verification: expect.stringContaining('checkpoint live-comment; attributed to Firstmate; dated 2026-11-10T15:00:42.000Z'),
    })
  })
  it.each(['paragraph', 'comment'])('accepts a sub-minute request and four-hour %s checkpoint', async type => {
    const h = await harness(); h.advance(20_000)
    await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.advance(25_000)
    const next = '2026-11-10T19:00:45Z'
    h.publish(id, next)
    h.setContext({ outcome: 'available', blocks: [{ id: 'minute-checkpoint', type,
      created_time: '2026-11-10T14:00:00Z', last_edited_time: '2026-11-10T15:00:00Z', text: h.report(id, next) }] })
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'resolved', followUp: null })
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
  })
  it.each(['paragraph', 'comment'])('rejects a property beyond the four-hour checkpoint minute for a %s', async type => {
    const h = await harness(); h.advance(20_000)
    await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.advance(25_000)
    h.publish(id, '2026-11-10T19:01:00Z')
    h.setContext({ outcome: 'available', blocks: [{ id: 'over-ceiling', type,
      last_edited_time: '2026-11-10T15:00:00Z', text: h.report(id, '2026-11-10T19:01:00Z') }] })
    await h.watchdog.sweep(true)
    const row = (await h.watchdog.rows())[0]!
    expect(row).toMatchObject({ state: 'answered-needs-correction', verifiedAt: null, followUp: null })
    expect(row.verification).toBe('Next check-in: exceeds the In Progress ceiling')
    expect(row.verification).not.toContain('answer says')
    expect(h.card.properties['Next check-in']!.value).toEqual({ start: '2026-11-10T19:01:00Z' })
    expect((await h.watchdog.indicators()).size).toBe(1)
  })
  it.each([
    ['2026-11-10T19:01:00Z', '2026-11-10T17:00:00Z', 'answered-needs-correction'],
    ['2026-11-10T17:00:00Z', '2026-11-10T19:01:00Z', 'resolved'],
  ])('enforces the ceiling on property %s when the answer is %s', async (property, answer, state) => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id, answer)
    h.card.properties['Next check-in']!.value = { start: property }
    await h.watchdog.sweep(true)
    const row = (await h.watchdog.rows())[0]!
    expect(row.state).toBe(state)
    if (state === 'resolved') {
      expect(row.verifiedAt).toBe(new Date(h.time()).toISOString())
      expect(row.verification).toContain(`answer says ${answer}; card property says ${property}`)
    } else {
      expect(row.verifiedAt).toBeNull()
      expect(row.verification).toBe('Next check-in: exceeds the In Progress ceiling')
    }
  })
  it('accepts a self-reported Date in a later minute than the checkpoint metadata', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id); await h.reply(id, 'Updating Notion now')
    h.advance(65_000)
    h.setContext({ outcome: 'available', blocks: [{ id: 'live-comment', type: 'comment', created_time: '2026-11-10T15:00:00Z', text: h.report(id) }] })
    h.card.last_edited_time = '2026-11-10T15:00:00.000Z'
    h.card.properties['Last touched by'] = { id: 'by', type: 'select', value: 'Firstmate', hasMore: false }
    h.card.properties['Next check-in']!.value = { start: '2026-11-10T17:00:00Z' }
    expect(h.report(id)).toContain('Date: 2026-11-10T15:01:05.000Z')
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'resolved', verifiedAt: new Date(h.time()).toISOString() })
  })
  it.each([
    ['clock guess ahead', '2026-11-10T02:25:00Z', '2026-11-10T15:00Z'],
    ['trailing timezone note', '2026-11-10T02:24Z', '2026-11-10T15:00Z (10 AM ET)'],
    ['UTC date text', '2026-11-10 02:45 UTC', '2026-11-10T15:00Z'],
  ])('resolves the live %s shape using Notion time without a follow-up', async (_, reportedDate, next) => {
    const h = await harness()
    h.advance(Date.parse('2026-11-10T02:24:00Z') - baseline)
    h.card.properties['Next check-in']!.value = { start: '2026-11-10T02:20:00Z' }
    await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id, '2026-11-10T15:00:00Z')
    h.card.last_edited_time = '2026-11-10T02:20:00Z'
    h.setContext({ outcome: 'available', blocks: [{ id: 'live-comment', type: 'comment',
      created_time: '2026-11-10T02:24:00Z', text: h.report(id, next).replace(/^Date:.*$/m, `Date: ${reportedDate}`) }] })
    h.advance(CHECK_IN_GRACE_MS)
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'resolved', followUp: null })
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
  })
  it.each(['closed', 'none (Done).', 'N/A.', 'DONE (archived)', 'Closed!'])('accepts a closed checkpoint %s', async next => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id)
    h.card.properties.Status!.value = next.includes('archived') ? 'Archived' : 'Done'
    h.card.properties['Next check-in']!.value = null
    h.setContext({ outcome: 'available', blocks: [{ id: 'closed', type: 'comment',
      created_time: new Date(h.time()).toISOString(), text: h.report(id, next) }] })
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'resolved', followUp: null })
  })
  it('compares date-only appointments at 9 AM New York and trims attribution', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id, '2026-11-11T14:00:00Z')
    h.card.properties.Status!.value = 'Waiting For'
    h.card.properties['Last touched by']!.value = ' FIRSTMATE '
    h.setContext({ outcome: 'available', blocks: [{ id: 'date-only', type: 'paragraph',
      last_edited_time: new Date(h.time()).toISOString(), text: h.report(id, '2026-11-11 (tomorrow)') }] })
    await h.watchdog.sweep(true)
    const row = (await h.watchdog.rows())[0]!
    expect(row.state).toBe('resolved')
    expect(row.verification).not.toContain('last edited by')
    expect(row.verification).not.toContain('answer says')
  })
  it('verifies when By differs from Last touched by and keeps the difference as a note', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id)
    h.card.properties['Last touched by']!.value = 'kdf'
    h.advance(CHECK_IN_GRACE_MS)
    await h.watchdog.sweep(true)
    const row = (await h.watchdog.rows())[0]!
    expect(row).toMatchObject({
      state: 'resolved', verifiedAt: new Date(h.time()).toISOString(), followUp: null,
      verification: expect.stringContaining('answered by Firstmate (last edited by kdf)'),
    })
    expect(row.verification).not.toContain('must match')
    expect((await h.watchdog.indicators()).size).toBe(0)
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
  })
  it('notes a different Next check-in and takes the next epoch from the property', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    const property = '2026-11-10T17:00:00Z'
    const answer = '2026-11-10T18:00:00Z'
    h.card.last_edited_time = new Date(h.time()).toISOString()
    h.card.properties['Last touched by'] = { id: 'by', type: 'select', value: 'Firstmate', hasMore: false }
    h.card.properties['Next check-in']!.value = { start: property }
    h.setContext({ outcome: 'available', blocks: [{ id: 'noted-checkpoint', type: 'paragraph',
      created_time: new Date(h.time()).toISOString(), text: h.report(id, answer) }] })
    await h.watchdog.sweep(true)
    const row = (await h.watchdog.rows())[0]!
    expect(row).toMatchObject({ state: 'resolved', verifiedAt: new Date(h.time()).toISOString(), followUp: null })
    expect(row.verification).toContain(`answer says ${answer}; card property says ${property}`)
    expect(Date.parse(row.dueAt)).toBe(checkInTime(original))
    expect(h.card.properties['Next check-in']!.value).toEqual({ start: property })
    expect((await h.watchdog.indicators()).size).toBe(0)
    h.advance(2 * 3600_000); await h.watchdog.sweep(true)
    expect(await h.watchdog.rows()).toHaveLength(1)
    h.advance(1); await h.watchdog.sweep(true)
    const rows = await h.watchdog.rows()
    expect(rows).toHaveLength(2)
    expect(rows[1]!.originalCheckpoint).toBe(property)
    expect(Date.parse(rows[1]!.dueAt)).toBe(Date.parse(property))
    expect(Date.parse(rows[1]!.dueAt)).not.toBe(Date.parse(answer))
  })
  it('still rejects a Next check-in that is not after the checkpoint', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id, '2026-11-10T14:00:00Z')
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({
      state: 'answered-needs-correction', verification: 'Next check-in: must be after the checkpoint', verifiedAt: null,
    })
  })
  it.each([
    ['Date', 'not a date', 'Date: unparseable timestamp'],
    ['Progress', 'still working', 'Progress: substantive update required'],
    ['Evidence', 'no evidence', 'Evidence: substantive evidence required'],
    ['Next action', '<next action>', 'Next action: missing value or placeholder'],
    ['By', '<acting coordinator>', 'By: missing value or placeholder'],
    ['By', '', 'By: missing value or placeholder'],
    ['Next check-in', 'none (Done).', 'Next check-in: unparseable appointment'],
  ])('shows a quiet %s correction and never sends a no-answer follow-up', async (field, value, issue) => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.card.properties.Status!.value = 'Waiting For'
    h.publish(id, '2026-11-11T17:00:00Z')
    const body = h.report(id, '2026-11-11T17:00:00Z')
    h.setContext({ outcome: 'available', blocks: [{ id: 'incorrect', type: 'comment',
      created_time: new Date(h.time()).toISOString(), text: body.replace(`${field}: ${body.split(`${field}: `)[1]!.split('\n')[0]}`, `${field}: ${value}`) }] })
    h.advance(CHECK_IN_GRACE_MS)
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'answered-needs-correction', verification: issue, verifiedAt: null, followUp: null })
    const indicator = (await h.watchdog.indicators()).get(h.card.id)!
    expect(indicator.answered).toBe(true)
    expect(checkInIndicatorText(indicator)).toBe(`Answered; correction needed · ${issue}`)
    await h.reply(id, 'Updating Notion now')
    h.advance(CHECK_IN_GRACE_MS * 3)
    await h.make().sweep(true)
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
    expect((await h.watchdog.rows())[0]!.followUp).toBeNull()
    h.publish(id, new Date(h.time() + 3600_000).toISOString())
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]!.state).toBe('resolved')
  })
  it.each(['queued', 'offered', 'receipted'])('preserves a %s follow-up when a field needs correction', async stage => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.advance(CHECK_IN_GRACE_MS)
    h.setDeliveryEnabled(stage !== 'queued')
    await h.watchdog.sweep(true)
    h.setDeliveryEnabled(true)
    if (stage !== 'queued') {
      const followUp = (await h.watchdog.bridgeWork()).pending[0]!
      if (stage === 'receipted') await h.note(followUp.request_id)
    }
    const { pending: _pending, ...saved } = (await h.watchdog.rows())[0]!.followUp!
    const next = new Date(h.time() + 3600_000).toISOString()
    h.publish(id, next)
    h.setContext({ outcome: 'available', blocks: [{ id: 'bad-evidence', type: 'paragraph',
      last_edited_time: new Date(h.time()).toISOString(), text: h.report(id, next).replace(/^Evidence:.*$/m, 'Evidence: no evidence') }] })
    const restarted = h.make()
    await restarted.sweep(true)
    expect((await restarted.rows())[0]).toMatchObject({
      state: stage !== 'receipted' ? 'answered-needs-correction' : 'needs-attention',
      verification: 'Evidence: substantive evidence required', followUp: saved, verifiedAt: null,
    })
    if (stage !== 'receipted') {
      expect(checkInIndicatorText((await restarted.indicators()).get(h.card.id)!)).toBe('Answered; correction needed · Evidence: substantive evidence required')
      expect((await restarted.bridgeWork()).pending).toEqual([])
    }
    h.publish(id, next)
    await restarted.sweep(true)
    expect((await restarted.rows())[0]).toMatchObject({ state: 'resolved', followUp: saved })
    expect((await restarted.bridgeWork()).pending).toEqual([])
  })
  it.each(['before-request', 'future', 'missing'])('retains the %s checkpoint-time guard', async kind => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id)
    h.setContext({ outcome: 'available', blocks: [{ id: 'bad-time', type: 'comment', text: h.report(id),
      created_time: kind === 'missing' ? undefined : new Date(h.time() + (kind === 'future' ? 60_000 : -60_000)).toISOString() }] })
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'answered-needs-correction',
      verification: 'Checkpoint time: must be at or after the request and at or before now', verifiedAt: null })
  })
  it('follows up exactly once when the original card genuinely has no answer', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.advance(CHECK_IN_GRACE_MS)
    await h.watchdog.sweep(true)
    const followUp = (await h.watchdog.bridgeWork()).pending[0]!
    expect(followUp.body).toContain('SYSTEM CHECK-IN FOLLOW-UP')
    await h.note(followUp.request_id)
    h.advance(CHECK_IN_GRACE_MS * 4)
    await h.make().sweep(true)
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'needs-attention', verifiedAt: null,
      followUp: { requestId: followUp.request_id } })
  })
  it('does not mistake another request ID for an answer to the original request', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(`${id}-different`)
    h.advance(CHECK_IN_GRACE_MS)
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'needs-attention', verifiedAt: null })
    expect((await h.watchdog.bridgeWork()).pending[0]!.body).toContain('SYSTEM CHECK-IN FOLLOW-UP')
  })
  it('resolves a previously followed-up row when its skewed checkpoint now verifies', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.advance(CHECK_IN_GRACE_MS)
    await h.watchdog.sweep(true)
    const followUp = (await h.watchdog.bridgeWork()).pending[0]!
    await h.note(followUp.request_id)
    h.publish(id, '2026-11-10T19:00:00Z')
    h.setContext({ outcome: 'available', blocks: [{ id: 'skewed', type: 'comment',
      created_time: new Date(h.time()).toISOString(),
      text: h.report(id, '2026-11-10T19:00:00Z').replace(/^Date:.*$/m, `Date: ${new Date(h.time() + 120_000).toISOString()}`) }] })
    await h.make().sweep(true)
    expect((await h.watchdog.rows())[0]).toMatchObject({ state: 'resolved', followUp: { requestId: followUp.request_id } })
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
  })
  it('creates a new epoch only after its new appointment passes', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id); await h.watchdog.sweep(true)
    expect(await h.watchdog.rows()).toHaveLength(1)
    h.advance(2 * 3600_000); await h.watchdog.sweep(true)
    expect(await h.watchdog.rows()).toHaveLength(1)
    h.advance(1); await h.watchdog.sweep(true)
    expect(await h.watchdog.rows()).toHaveLength(2)
    expect((await h.watchdog.bridgeWork()).pending[0]!.request_id).not.toBe(id)
  })
  it('does not let a date-only edit evade the one unresolved follow-up', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id); await h.reply(id, 'still working')
    h.card.properties['Next check-in']!.value = { start: '2026-11-11T15:00:00Z' }
    h.advance(CHECK_IN_GRACE_MS)
    await h.watchdog.sweep(true)
    const followUp = (await h.watchdog.bridgeWork()).pending[0]!
    expect(followUp.body).toContain('SYSTEM CHECK-IN FOLLOW-UP')
    expect(followUp.body).toContain('"original_checkpoint":"' + original + '"')
    expect(followUp.body).toContain('"current_checkpoint":"2026-11-11T15:00:00Z"')
    expect((await h.watchdog.rows())[0]!.verifiedAt).toBeNull()
  })
  it('never exposes a preview/test request without explicit delivery opt-in', async () => {
    const h = await harness(); await h.make(false).sweep()
    expect((await h.make(false).bridgeWork()).pending).toEqual([])
    expect((await checkInSettings(join(h.root, 'tinstar-preview-config-3'))).deliveryEnabled).toBe(false)
    expect((await checkInSettings(h.root)).deliveryEnabled).toBe(false) // NODE_ENV=test
    await writeFile(join(h.root, 'config.json'), JSON.stringify({ checkInWatchdog: { previewDeliveryEnabled: true } }))
    expect((await checkInSettings(h.root)).deliveryEnabled).toBe(true)
    expect((await h.watchdog.rows())[0]!.request.offeredAt).toBeNull()
  })
  it('does not send after a failed preflight read or lose unresolved state on readback failure', async () => {
    const h = await harness()
    h.sources.currentCard.mockRejectedValueOnce(new Error('offline'))
    await h.watchdog.sweep()
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
    expect((await h.watchdog.rows())[0]!.state).toBe('due')
    await h.watchdog.sweep(true)
    await h.watchdog.bridgeWork()
    h.sources.currentCardContext.mockRejectedValueOnce(new Error('offline'))
    await h.watchdog.sweep(true)
    expect((await h.watchdog.rows())[0]!.verifiedAt).toBeNull()
  })
  it('verifies a named-timezone checkpoint against its property instant', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    h.publish(id, '2026-11-10T17:00:00')
    h.card.properties['Next check-in']!.value = { start: '2026-11-10T17:00:00', time_zone: 'Europe/Paris' }
    await h.watchdog.sweep(true)
    const row = (await h.watchdog.rows())[0]!
    expect(row.state).toBe('resolved')
    expect(row.verification).not.toContain('answer says')
  })
  it('keeps indicators and receipts available during preflight and honors the newer receipt', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    let release!: (value: typeof h.card) => void, started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    h.sources.currentCard.mockImplementationOnce(() => new Promise(resolve => { release = resolve; started() }))
    const sweep = h.watchdog.sweep(true)
    await reading
    try {
      await Promise.race([
        (async () => {
          expect((await h.watchdog.indicators()).get(h.card.id)?.state).toBe('due')
          await h.note(id)
          await h.reply(id, h.report(id))
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('preflight blocked ledger')), 1000)),
      ])
    } finally { release(structuredClone(h.card)) }
    await sweep
    expect((await h.watchdog.bridgeWork()).pending).toEqual([])
    expect((await h.watchdog.rows())[0]!.state).toBe('acknowledged')
  })
  it('does not hold the receipt queue during slow readback or overwrite an acknowledgement received meanwhile', async () => {
    const h = await harness(); await h.watchdog.sweep()
    const id = (await h.watchdog.bridgeWork()).pending[0]!.request_id
    await h.note(id)
    let release!: (value: CardContextRead) => void, started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    h.sources.currentCardContext.mockImplementationOnce(() => new Promise<CardContextRead>(resolve => { release = resolve; started() }))
    const sweep = h.watchdog.sweep(true)
    await reading
    await h.reply(id, h.report(id))
    expect((await h.watchdog.rows())[0]!.request.reply?.body).toBe(h.report(id))
    release({ outcome: 'available', blocks: [] })
    await sweep
    expect((await h.watchdog.rows())[0]!.state).toBe('acknowledged')
  })
})

describe('read-only Notion and published Mac bridge protocol', () => {
  it('requires the exact page and configured data source on uncached page reads', async () => {
    const id = fixtureId(1), dataSourceId = fixtureId(999)
    const raw = { object: 'page', id, properties: {}, last_edited_time: new Date(baseline).toISOString(), parent: { data_source_id: dataSourceId } }
    const fetcher = vi.fn(async () => new Response(JSON.stringify(raw))) as unknown as typeof fetch
    expect((await readNotionCard({ token: 'fake', dataSourceId }, id, fetcher)).id).toBe(id)
    expect(vi.mocked(fetcher).mock.calls[0]![1]?.method ?? 'GET').toBe('GET')
    raw.parent.data_source_id = fixtureId(888)
    await expect(readNotionCard({ token: 'fake', dataSourceId }, id, fetcher)).rejects.toThrow('identity or source')
    raw.parent.data_source_id = dataSourceId; raw.id = fixtureId(2)
    await expect(readNotionCard({ token: 'fake', dataSourceId }, id, fetcher)).rejects.toThrow('identity or source')
  })
  it.each(['6.0.0', '6.0.1'])('delivers system work using unchanged published %s puller, with one note across restart', async version => {
    const h = await harness(); await h.watchdog.sweep()
    const token = 'private-test-bridge-token-123456789012345'
    const sources = { scene: async () => {
      const scene = new SceneReconciler().reconcile(await h.sources.snapshot())
      return { ...scene, searchIndex: boundSearchDocuments(sceneSearchDocuments(scene)) }
    } }
    // No UI/owner route is used to manufacture this work.
    const makeApi = (watchdog: CheckInWatchdog) => new AskApi(sources, h.root, async () => ({ ownerLogins: ['owner@example.test'], bridgeToken: token }), undefined, watchdog)
    let api = makeApi(h.watchdog), loseCaptureAck = true
    server = createServer((req, res) => {
      if (req.method === 'POST' && loseCaptureAck) { loseCaptureAck = false; res.writeHead(503); res.end(); return }
      void api.handle(req, res)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    const base = `http://127.0.0.1:${address.port}`
    const headers = { Authorization: `Bearer ${token}` }
    expect((await fetch(base + '/api/ask/bridge')).status).toBe(401)
    expect((await fetch(base + '/api/ask/bridge', { headers: { ...headers, Origin: base } })).status).toBe(403)
    const home = join(h.root, 'fake-firstmate'), bin = join(home, 'bin')
    await mkdir(bin, { recursive: true })
    const python = (await exec('python3', ['-c', 'import sys; print(sys.executable)'])).stdout.trim()
    await writeFile(join(bin, 'fm-inbox.sh'), `#!${python}
import json,pathlib,sys
p=pathlib.Path(__file__).parent.parent/'notes.json'
rows=json.loads(p.read_text()) if p.exists() else []
if sys.argv[1]=='note':
    rid=sys.argv[sys.argv.index('--request-id')+1]
    body=sys.stdin.read()
    assert 'Tin Star SYSTEM CHECK-IN REQUEST' in body
    existing=next((r for r in rows if r['request_id']==rid),None)
    if existing is None:
        existing={'id':'test-note','request_id':rid,'reply':{'id':'test-note','at':'2026-11-10T15:00:00.000Z','cursor':'1','body':'still working'}}
        rows.append(existing);p.write_text(json.dumps(rows))
    print(json.dumps({'schema':'fm-inbox-note.v1','outcome':'replay' if len(rows)>1 else 'created','id':existing['id'],'request_id':rid,'saved':True,'announced':True,'acknowledged':False}))
else:
    print(json.dumps({'schema':'fm-inbox-receipts.v1','pending':rows,'handled':[],'omitted':[]}))
`)
    await chmod(join(bin, 'fm-inbox.sh'), 0o700)
    const driver = `import importlib.util,pathlib,sys,json
s=importlib.util.spec_from_file_location('puller',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.pull_once(sys.argv[2],sys.argv[3],pathlib.Path(sys.argv[4]))))`
    const run = async () => JSON.parse((await exec(python, ['-B', '-c', driver, resolve(`test-fixtures/published-puller/${version}/ask-puller.py`), base, token, home], { env: { HOME: home, PATH: bin }, timeout: 20_000 })).stdout)
    await expect(run()).rejects.toThrow() // inbox saved, server never received acknowledgement
    expect(JSON.parse(await readFile(join(home, 'notes.json'), 'utf8'))).toHaveLength(1)
    api = makeApi(h.make()) // process/store restart before retry
    expect(await run()).toMatchObject({ captured: 1, replied: 1, failed: 0 })
    expect(await run()).toMatchObject({ captured: 0, replied: 0, failed: 0 })
    expect(JSON.parse(await readFile(join(home, 'notes.json'), 'utf8'))).toHaveLength(1)
    expect((await h.make().rows())[0]).toMatchObject({ state: 'responded', verifiedAt: null })
    expect((await api.store.list('owner@example.test')).length).toBe(0)
  })
  it('runs the report CLI from saved observations without creating delivery state', async () => {
    const h = await harness(), path = join(h.root, 'sources.json')
    await writeFile(path, JSON.stringify(h.snapshot))
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'scripts/check-in-report.ts', '--snapshot', path, '--at', new Date(baseline).toISOString()], { env: { ...process.env, TINSTAR_CONFIG_HOME: h.root }, timeout: 20_000 })
    const report = JSON.parse(stdout)
    expect(report.delivery).toBe('report-only')
    expect(report.decisions.find((d: { cardId: string }) => d.cardId === h.card.id)).toMatchObject({ due: true, route: { worker: { task: 'linked-worker' } } })
    await expect(stat(h.watchdog.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('rejects placeholders and empty evidence as a substantive acknowledgement', () => {
  expect(checkInReport('still working', randomUUID())).toBeNull()
})

it('retains competing Queued other-owner declarations and unknown coverage in scoped check-ins', async () => {
  const h = await harness()
  const snapshot: CheckInSnapshot = structuredClone(h.snapshot)
  snapshot.checkIns = structuredClone(snapshot.intentions)
  snapshot.checkIns.data!.cards = [structuredClone(h.card)]
  const competing = structuredClone(h.card)
  competing.id = 'f'.repeat(32); competing.properties.Owner!.value = 'Other'; competing.properties.Status!.value = 'Queued'
  snapshot.intentions.data!.cards.push(competing)
  const decision = () => checkInDecisions(snapshot, baseline).find(d => d.cardId === h.card.id)!
  expect(decision()).toMatchObject({ due: true, route: { worker: null } })
  snapshot.intentions.data = null; snapshot.intentions.status = 'unknown'; snapshot.intentions.coverage = 'unknown'
  expect(decision()).toMatchObject({ due: true, route: { worker: null } })
})


it('withdraws a cached original on the next sweep without losing a late receipt', async () => {
  const h = await harness(); await h.watchdog.sweep(true)
  const offered = (await h.watchdog.bridgeWork()).pending
  h.card.properties.Owner!.value = 'Will'
  expect((await h.make().bridgeWork()).pending).toEqual(offered)
  await h.watchdog.sweep(true)
  expect((await h.make().bridgeWork()).pending).toEqual([])
  expect(await h.make().owns(offered[0]!.request_id)).toBe(true)
  await h.note(offered[0]!.request_id)
})


it('revalidates legacy check-in reservations on a sweep without changing retry bytes or ownership', async () => {
  const h = await harness(); await h.watchdog.sweep(true)
  const offered = (await h.watchdog.bridgeWork()).pending
  const rows = JSON.parse(await readFile(h.watchdog.path, 'utf8'))
  for (const row of rows) { delete row.request.pending; if (row.followUp) delete row.followUp.pending }
  await writeFile(h.watchdog.path, JSON.stringify(rows))
  h.sources.currentCard.mockClear()
  const restarted = h.make()
  expect((await restarted.bridgeWork()).pending).toEqual([])
  expect(h.sources.currentCard).not.toHaveBeenCalled()
  expect(await restarted.owns(offered[0]!.request_id)).toBe(true)
  await restarted.sweep(true)
  expect((await restarted.bridgeWork()).pending).toEqual(offered)
})


it('keeps a reserved request due throughout a puller outage and starts grace on receipt', async () => {
  const h = await harness(); await h.watchdog.sweep(true)
  const offer = (await h.watchdog.bridgeWork()).pending[0]!
  h.advance(CHECK_IN_GRACE_MS * 3)
  const restarted = h.make()
  await restarted.sweep(true)
  expect((await restarted.rows())[0]).toMatchObject({ state: 'due', request: { offeredAt: null }, followUp: null })
  expect((await restarted.bridgeWork()).pending).toEqual([offer])
  expect((await restarted.indicators()).get(h.card.id)?.requestedAt).toBeNull()
  await h.watchdog.ingest({ request_id: offer.request_id, error: 'capture-failed' })
  await restarted.sweep(true)
  expect((await restarted.rows())[0]!.followUp).toBeNull()
  await h.note(offer.request_id, false)
  const deliveredAt = new Date(h.time()).toISOString()
  h.advance(CHECK_IN_GRACE_MS - 1)
  await restarted.sweep(true)
  expect((await restarted.rows())[0]).toMatchObject({ state: 'requested', request: { offeredAt: deliveredAt }, followUp: null })
  await h.note(offer.request_id)
  expect((await restarted.bridgeWork()).pending).toEqual([])
  h.advance(1)
  await restarted.sweep(true)
  expect((await restarted.rows())[0]).toMatchObject({ state: 'needs-attention', request: { offeredAt: deliveredAt } })
  expect((await restarted.bridgeWork()).pending[0]!.body).toContain('SYSTEM CHECK-IN FOLLOW-UP')
})

it('supersedes a reserved checkpoint changed before delivery while retaining late receipt ownership', async () => {
  const h = await harness(); await h.watchdog.sweep(true)
  const offer = (await h.watchdog.bridgeWork()).pending[0]!
  h.advance(CHECK_IN_GRACE_MS * 3)
  h.card.properties['Next check-in']!.value = { start: new Date(h.time() + 3600_000).toISOString() }
  const restarted = h.make()
  await restarted.sweep(true)
  expect((await restarted.rows())[0]).toMatchObject({ state: 'superseded', request: { offeredAt: null }, followUp: null })
  expect((await restarted.bridgeWork()).pending).toEqual([])
  expect(await restarted.owns(offer.request_id)).toBe(true)
  await h.note(offer.request_id)
  await h.reply(offer.request_id, 'Received after checkpoint changed')
  h.advance(CHECK_IN_GRACE_MS)
  await restarted.sweep(true)
  expect((await restarted.rows())[0]).toMatchObject({ state: 'superseded', followUp: null })
})
