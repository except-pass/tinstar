import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { requestAnchor } from '../../shared/deskSource'

const fixtures = vi.hoisted(() => ({ snapshot: {} as Record<string, unknown>, submit: vi.fn(), dismiss: vi.fn() }))
vi.mock('./snapshot', () => ({ readFleetSnapshot: async () => fixtures.snapshot }))
vi.mock('./config', () => ({ loadFleetConfig: () => ({ firstmate: { homes: ['/test/home'] } }), firstmatePortWindow: () => ({ start: 1, count: 1 }) }))
vi.mock('../firstmate/views', () => ({ FirstmateViews: class { pidOf() { return null } portOf() { return null } release() {} } }))
vi.mock('./marks', () => ({ directSet: () => new Set(), directKey: () => '', WorkerMarksUnreadable: class extends Error {}, WorkerMarks: class { read() { return [] } queue<T>(work: () => T) { return work() } } }))
vi.mock('./inbox', () => ({ FleetOutbox: class { get() { return undefined } submit = fixtures.submit; list(_homes: string[], callOpen: (message: unknown) => boolean) { return callOpen } } }))
vi.mock('./dismiss', () => ({ dismissDirect: fixtures.dismiss }))
import { CockpitFleet } from './cockpit'

const home = '/test/home'
const source = (taskId: string | null, id: string, kind: 'hold' | 'decision' = 'decision') => requestAnchor({ home, taskId, id, kind })
const task = (id: string) => ({ id, hints: { open_decisions: [{ key: 'choose', verb: 'needs-decision', summary: 'Choose A or B' }] } })
beforeEach(() => { fixtures.submit.mockReset().mockResolvedValue({ saved: true }); fixtures.dismiss.mockReset().mockResolvedValue({ dismissed: true }) })

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
