import { describe, expect, it } from 'vitest'
import { dispatchOnlyWait, independentWaitIssue, waitingForException, waitingForFieldIssue, workIdShape, waitLine } from '../waitingForPolicy'

const id = 'a'.repeat(32)
const other = 'e'.repeat(32)
const allow = (dependency: string, unblocks = 'The named outcome is recorded', blocker = 'Will') =>
  expect(independentWaitIssue({ type: 'Actor', id: blocker, dependency, unblocks_when: unblocks })).toBeNull()
const dispatch = (dependency: string) => independentWaitIssue({ type: 'Actor', id: 'Build crew', dependency, unblocks_when: 'When that happens' })

describe('Waiting For independence', () => {
  it.each([
    'waiting for HILDA mate to start/attach a worker',
    'HILDA mate is starting the worker',
    'Waiting for a worker to be assigned',
    'waiting for the worker to start',
    'First Mate to pick up',
    'Queued behind other tasks',
    'Check in on Friday',
    '2026-12-01',
  ])('rejects a dispatch-only reason: %s', dependency => {
    expect(dispatchOnlyWait(dependency, 'When that happens')).toBe(true)
    expect(dispatch(dependency)?.code).toBe('not-independent')
  })

  it('rejects a placeholder used as the blocker and allows a real one', () => {
    expect(independentWaitIssue({ type: 'Actor', id: 'Firstmate', dependency: 'Firstmate', unblocks_when: 'Later' })?.code).toBe('placeholder-blocker')
    allow('Owner acceptance of the tariff')
    allow('Security approval of the firmware publication', 'The image is published', 'Release engineering')
    allow('Duke Energy interconnection approval', 'The utility confirms the tariff', 'Duke Energy')
    expect(independentWaitIssue({ type: 'Event', id: 'https://github.com/acme/repo/pull/15', dependency: 'Deploy the facade', unblocks_when: 'The receipt is verified' })).toBeNull()
    expect(independentWaitIssue({ type: 'Actor', id: 'First Mate', dependency: 'Main branch release PR #440 published', unblocks_when: 'The release is published' })).toBeNull()
    allow('Waiting for First Mate to publish the firmware source', 'The firmware source is published', 'Release engineering')
  })

  it('flags malformed Waiting For metadata and does not treat unknown coverage as absence', () => {
    expect(waitingForFieldIssue({ cardId: id, status: 'Waiting For', type: '', id: '', knownWorkIds: [] })).toBe('Waiting For Type is missing.')
    expect(workIdShape(id, id)?.code).toBe('work-self')
    expect(workIdShape(id, 'not-a-card')?.code).toBe('invalid-work-id')
    expect(waitingForFieldIssue({ cardId: id, status: 'Waiting For', type: 'Work', id: other, knownWorkIds: [] })).toMatch(/needs verification/)
    const exception = waitingForException({ cardId: id, status: 'Waiting For', type: '', id: '', waitingFor: 'HILDA mate is starting the worker', observedAt: '2026-11-16T00:00:00Z', coverage: 'unknown' })
    expect(exception).toMatchObject({ card_id: id, field: 'Waiting For Type', observed_at: '2026-11-16T00:00:00Z', coverage: 'unknown' })
    expect(exception!.reason).not.toMatch(/dead|stranded|unassigned/)
    expect(waitingForException({ cardId: id, status: 'Waiting for Prod Release', type: '', id: '', waitingFor: '', observedAt: null, coverage: 'complete' })).toBeNull()
    expect(waitingForException({ cardId: id, status: 'Queued', type: '', id: '', waitingFor: 'HILDA mate is starting the worker', observedAt: '2026-11-16T00:00:00Z', coverage: 'partial' })?.field).toBe('Waiting For')
  })
})

it('reports bypassed fields and Work references without rewriting', () => {
  const base = { cardId: id, status: 'Waiting For', type: 'Actor', id: 'Will', waitingFor: '', observedAt: null, coverage: 'complete' as const }
  expect(waitingForException(base)?.field).toBe('Waiting For')
  const waitingFor = 'Dependency: Approval | Unblocks when: Approved | Follow-up: Consumer | Type: Actor | ID: Will'
  expect(waitingForException({ ...base, waitingFor })?.field).toBe('Next check-in')
  expect(waitingForException({ ...base, type: 'Work', id: other })?.reason).toMatch(/needs verification/)
  expect(waitingForException({ ...base, type: 'Work', id: other, knownWork: [{ id: other, status: 'Done' }] })?.reason).toMatch(/completed/)
  expect(independentWaitIssue({ type: 'Actor', id: 'Release engineering', dependency: 'Waiting for a worker to be assigned', unblocks_when: 'The worker starts' })?.code).toBe('not-independent')
})

for (const workId of [id, 'invalid', other]) {
  it(`checks secondary Work identity ${workId}`, () => {
    const primary = { type: 'Actor', id: 'Will', dependency: 'Tariff approval', unblocks_when: 'The tariff is approved', follow_up_by: 'Consumer' }
    const secondary = { ...primary, type: 'Work', id: workId, dependency: 'Other card outcome', unblocks_when: 'The other card finishes' }
    const base = { cardId: id, status: 'Waiting For', type: 'Actor', id: 'Will', waitingFor: [waitLine(primary), waitLine(secondary)].join('\n'), nextCheckIn: { start: '2027-01-01' }, observedAt: null, coverage: 'complete' as const }
    expect(waitingForException(base)?.field).toBe('Waiting For ID')
    if (workId === other) {
      for (const state of [{ status: 'Done' }, { status: 'Queued', archived: true }, { status: 'Queued', in_trash: true }]) expect(waitingForException({ ...base, knownWork: [{ id: other, ...state }] })?.reason).toMatch(/completed|archived|deleted/)
      expect(waitingForException({ ...base, knownWork: [{ id: other, status: 'Queued' }] })).toBeNull()
      expect(waitingForException({ ...base, coverage: 'unknown', knownWork: [{ id: other, status: 'Queued' }] })?.reason).toMatch(/verification/)
    }
  })
}

it.each(['First Mate', 'Release engineering', 'Build crew'])('judges outcomes independently of actor %s', actor => {
  expect(independentWaitIssue({ type: 'Actor', id: actor, dependency: `Waiting for ${actor} to publish the firmware source`, unblocks_when: 'The firmware source is published' })).toBeNull()
  expect(independentWaitIssue({ type: 'Actor', id: actor, dependency: 'Security release', unblocks_when: 'The worker starts' })?.code).toBe('not-independent')
})
