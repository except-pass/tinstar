import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { requestAnchor } from '../../shared/deskSource'

const fixtures = vi.hoisted(() => ({ snapshot: {} as Record<string, unknown>, get: vi.fn(), submit: vi.fn(), dismiss: vi.fn() }))
vi.mock('./snapshot', () => ({ readFleetSnapshot: async () => fixtures.snapshot }))
vi.mock('./config', () => ({ loadFleetConfig: () => ({ firstmate: { homes: ['/test/home'] } }), firstmatePortWindow: () => ({ start: 1, count: 1 }) }))
vi.mock('../firstmate/views', () => ({ FirstmateViews: class { pidOf() { return null } portOf() { return null } release() {} } }))
vi.mock('./marks', () => ({ directSet: () => new Set(), directKey: () => '', WorkerMarksUnreadable: class extends Error {}, WorkerMarks: class { read() { return [] } queue<T>(work: () => T) { return work() } } }))
vi.mock('./inbox', () => ({ FleetOutbox: class { get = fixtures.get; submit = fixtures.submit; list(_homes: string[], callOpen: (message: unknown) => boolean) { return callOpen } } }))
vi.mock('./dismiss', () => ({ dismissDirect: fixtures.dismiss }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, { stdout: '{"state":"closed","merged_at":"2026-11-17T21:40:00Z"}' })),
}))
import { CockpitFleet, handleCockpitRequest } from './cockpit'
import { PullsApi } from '../pulls/routes'
import { AssociationStore } from '../releases/associations'

const home = '/test/home'
const source = (taskId: string | null, id: string, kind: 'hold' | 'decision' = 'decision') => requestAnchor({ home, taskId, id, kind })
const task = (id: string) => ({ id, hints: { open_decisions: [{ key: 'choose', verb: 'needs-decision', summary: 'Choose A or B' }] } })
beforeEach(() => { fixtures.get.mockReset(); fixtures.submit.mockReset().mockResolvedValue({ saved: true }); fixtures.dismiss.mockReset().mockResolvedValue({ dismissed: true }) })

it.each([
  { login: 'owner@example.test', allowed: true },
  { login: undefined, allowed: false },
])('projects finished PR status on fleet reads with owner access $allowed', async ({ login, allowed }) => {
  const url = 'https://github.com/owner/repo/pull/1'
  fixtures.snapshot = { schema: 'fm-fleet-snapshot.v1', tasks: [{ id: 'alpha', pr: { url } }] }
  const fleet = new CockpitFleet()
  await fleet.refresh()
  await vi.waitFor(() => expect(fleet.list(true).workers[0]?.prStatus).toBe('merged'))
  const root = await mkdtemp(join(process.cwd(), '.fleet-auth-test-'))
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
    const pulls = new PullsApi({ scene: vi.fn() }, new AssociationStore(root), root)
    const server = createServer((req, res) => { void handleCockpitRequest(fleet, req, res, request => pulls.authorized(request)) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const { port } = server.address() as { port: number }
      const response = await fetch(`http://127.0.0.1:${port}/api/fleet`, { headers: login ? { 'Tailscale-User-Login': login } : {} })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const { data } = await response.json()
      expect(data.workers[0]).toMatchObject({ id: 'alpha', prUrl: url })
      if (allowed) expect(data.workers[0]).toHaveProperty('prStatus', 'merged')
      else expect(data.workers[0]).not.toHaveProperty('prStatus')
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe('Desk source anchors on the existing fleet response routes', () => {
  it('does not route two workers sharing a key through an unbound captain hold', async () => {
    fixtures.snapshot = { schema: 'fm-fleet-snapshot.v1', tasks: [task('alpha'), task('beta')], backlog: { records: [{ id: 'choose', hold_kind: 'captain', captain_actionable: true }] } }
    const fleet = new CockpitFleet(); await fleet.refresh()
    for (const id of ['alpha', 'beta']) {
      expect(await fleet.submit({ requestId: `tinstar-${randomUUID()}`, anchorKey: source(id, 'choose'), kind: 'answer', text: 'A' })).toBeNull()
      expect(await fleet.dismiss(source(id, 'choose'))).toBeNull()
    }
    expect(fixtures.submit).not.toHaveBeenCalled(); expect(fixtures.dismiss).not.toHaveBeenCalled()
  })

  it('binds Answer and Dismiss to one source each, retaining receipt identity', async () => {
    fixtures.snapshot = { schema: 'fm-fleet-snapshot.v1', tasks: [task('alpha'), task('beta')], backlog: { records: [{ id: 'choose', hold_kind: 'captain', captain_actionable: true, body_lines: ['Origin: alpha'] }] } }
    const fleet = new CockpitFleet(); await fleet.refresh()
    const anchorKey = source('alpha', 'choose')
    const requestId = `tinstar-${randomUUID()}`
    expect(await fleet.submit({ requestId, anchorKey, kind: 'answer', text: 'A' })).toMatchObject({ saved: true })
    expect(fixtures.submit).toHaveBeenCalledWith(expect.objectContaining({ requestId, sourceAnchor: anchorKey, home, taskId: 'alpha', decisionKey: 'choose', holdId: null }), expect.stringContaining('task alpha, decision choose'))
    expect(await fleet.dismiss(anchorKey)).toEqual({ dismissed: true })
    expect(fixtures.dismiss).toHaveBeenLastCalledWith(home, expect.objectContaining({ taskId: 'alpha', decisionKey: 'choose', holdId: null, dismissal: 'resolve-key' }))
    expect(await fleet.dismiss(source('alpha', 'choose', 'hold'))).toEqual({ dismissed: true })
    expect(fixtures.dismiss).toHaveBeenLastCalledWith(home, expect.objectContaining({ taskId: 'alpha', holdId: 'choose', dismissal: 'captain-hold' }))
    expect(await fleet.dismiss(source('beta', 'choose'))).toBeNull()
    const callOpen = fleet.messages() as unknown as (message: unknown) => boolean
    expect(callOpen({ sourceAnchor: anchorKey, home })).toBe(true)
    fixtures.snapshot = { ...fixtures.snapshot, tasks: [task('beta')], backlog: { records: [] } }
    await fleet.refresh()
    expect(await fleet.dismiss(anchorKey)).toBeNull()
    expect(callOpen({ sourceAnchor: anchorKey, home })).toBe(false)
  })

  it('never attaches an identically worded task hold to an unrelated question', async () => {
    fixtures.snapshot = { schema: 'fm-fleet-snapshot.v1', tasks: [task('alpha')], backlog: { records: [{ id: 'alpha', hold_kind: 'captain', captain_actionable: true, hold_reason: 'Choose A or B' }] } }
    const fleet = new CockpitFleet(); await fleet.refresh()
    expect(await fleet.dismiss(source('alpha', 'choose'))).toBeNull()
    expect(await fleet.submit({ requestId: `tinstar-${randomUUID()}`, anchorKey: source('alpha', 'alpha', 'hold'), kind: 'answer', text: 'A' })).toMatchObject({ saved: true })
    expect(fixtures.submit).toHaveBeenCalledWith(expect.objectContaining({ home, taskId: 'alpha', decisionKey: 'alpha', holdId: 'alpha' }), expect.any(String))
  })
})

it('preserves independent alpha/choose decision and hold bindings on submit and retry', async () => {
  fixtures.snapshot = { schema: 'fm-fleet-snapshot.v1', tasks: [task('alpha')], backlog: { records: [{ id: 'choose', hold_kind: 'captain', captain_actionable: true, hold_reason: 'Choose A or B', body_lines: ['Origin: alpha'] }] } }
  const fleet = new CockpitFleet(); await fleet.refresh()
  for (const kind of ['decision', 'hold'] as const) {
    const anchorKey = source('alpha', 'choose', kind)
    const input = { requestId: `tinstar-${randomUUID()}`, anchorKey, kind: 'answer', text: 'A' }
    await fleet.submit(input)
    const [message, description] = fixtures.submit.mock.lastCall!
    expect(message.sourceAnchor).toBe(anchorKey)
    if (kind === 'hold') expect(description).toContain('hold choose')
    fixtures.get.mockResolvedValueOnce(message)
    await fleet.submit(input)
    expect(fixtures.submit.mock.lastCall).toEqual([message, description])
  }
})

it('delivers complete maximum-size workflow answers while retaining ordinary submission limits', async () => {
  fixtures.snapshot = { schema: 'fm-fleet-snapshot.v1', tasks: [task('alpha')], backlog: { records: [{ id: 'choose', hold_kind: 'captain', captain_actionable: true, body_lines: ['Origin: alpha'] }] } }
  const fleet = new CockpitFleet(); await fleet.refresh()
  const answer = 'R'.repeat(12_000)
  const input = { requestId: `tinstar-${randomUUID()}`, anchorKey: source('alpha', 'choose'), kind: 'answer', text: `Notion card: ${'a'.repeat(32)}\nDecision proposal: ${'p'.repeat(128)}\nExact owner answer:\n${answer}\nReconcile only this source request. Keep implementation Queued until a real worker starts; preserve other asks. Report the source reconciliation through the existing receipt path.` }
  expect(await fleet.submit(input)).toBeNull()
  const resolution = { cardId: 'a'.repeat(32), requestId: 'p'.repeat(128), answerId: 'p'.repeat(128) }
  expect(await fleet.submit(input, resolution)).toMatchObject({ saved: true })
  const [message] = fixtures.submit.mock.lastCall!
  expect(message.text).toBe(input.text)
  expect(message.decisionResolution).toEqual(resolution)
  fixtures.get.mockResolvedValueOnce(message)
  expect(await fleet.submit(input, resolution)).toMatchObject({ saved: true })
  expect(await fleet.submit({ ...input, requestId: `tinstar-${randomUUID()}`, kind: 'message' }, resolution)).toBeNull()
})
