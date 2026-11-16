import { updateWorkSchema, waitSchema } from '../workflow'
import { describe, expect, it } from 'vitest'
import { dispatchOnlyWait, independentWaitIssue, waitingForException, waitingForFieldIssue, workIdShape, waitLine, parseWaitLine } from '../waitingForPolicy'

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

  it('accepts complete fields without classifying actor names', () => {
    expect(independentWaitIssue({ type: 'Actor', id: 'Firstmate', dependency: 'Firstmate', unblocks_when: 'Later' })).toBeNull()
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

it.each([
  'A worker is assigned to this card', 'The worker starts on this card',
  'The worker attaches to this card', 'First Mate picks up this card', 'First Mate to pick it up',
  'Queued behind other work', 'Check in on Friday',
])('rejects the minimum dispatch outcome: %s', unblocks_when => {
  const wait = { type: 'Actor', id: 'Release engineering', dependency: 'Waiting for worker assignment', unblocks_when }
  expect(independentWaitIssue(wait)?.code).toBe('not-independent')
  expect(independentWaitIssue({ ...wait, unblocks_when: unblocks_when.toUpperCase() })?.code).toBe('not-independent')
  expect(waitingForException({ cardId: id, status: 'Waiting For', type: wait.type, id: wait.id, waitingFor: waitLine({ ...wait, follow_up_by: 'Consumer' }), nextCheckIn: { start: '2027-01-01' }, observedAt: null, coverage: 'complete' })?.reason).toMatch(/independent blocker/)
})

it('accepts matching event identity and dependency', () => {
  const wait = { type: 'Event', id: 'Firmware source publication', dependency: 'Firmware source publication', unblocks_when: 'The firmware source is published', follow_up_by: 'Consumer' }
  expect(independentWaitIssue(wait)).toBeNull()
  expect(waitingForException({ cardId: id, status: 'Waiting For', type: wait.type, id: wait.id, waitingFor: waitLine(wait), nextCheckIn: { start: '2027-01-01' }, observedAt: null, coverage: 'complete' })).toBeNull()
})

it.each(['Queued', 'Todo', 'Backlog', 'In Progress'])('reports unresolved typed blockers in %s', status => {
  const wait = { type: 'Actor', id: 'Security', dependency: 'Security approval', unblocks_when: 'Security approves the image', follow_up_by: 'Consumer' }
  const base = { cardId: id, status, type: wait.type, id: wait.id, waitingFor: waitLine(wait), observedAt: '2026-11-16T00:00:00Z', coverage: 'complete' as const }
  expect(waitingForException(base)).toMatchObject({ card_id: id, field: 'Waiting For', observed_at: base.observedAt, coverage: 'complete', reason: expect.stringContaining('unresolved typed blocker') })
  expect(waitingForException({ ...base, type: '', id: '' })?.reason).toMatch(/unresolved typed blocker/)
  expect(waitingForException({ ...base, waitingFor: '' })?.reason).toMatch(/unresolved typed blocker/)
})

it.each(['dependency', 'unblocks_when', 'follow_up_by'] as const)('reports missing %s on directly edited waits', field => {
  const wait = { type: 'Actor', id: 'Will', dependency: 'Security approval', unblocks_when: 'Security approves', follow_up_by: 'Consumer', [field]: '' }
  expect(waitingForException({ cardId: id, status: 'Waiting For', type: wait.type, id: wait.id, waitingFor: waitLine(wait), nextCheckIn: { start: '2027-01-01' }, observedAt: null, coverage: 'complete' })?.field).toBe('Waiting For')
})

describe('wait text round trips', () => {
  const original = { type: 'Actor' as const, id: 'Security', dependency: 'Security approval', unblocks_when: 'Approval is recorded', follow_up_by: 'Consumer' }
  it.each(['dependency', 'unblocks_when', 'follow_up_by', 'id'] as const)('preserves quoted %s through serialization and diagnostics', field => {
    for (const text of ['"Security approval" must be recorded', '"Security approval"', 'Security "approval" is required', '"Security"\nLegal approval', '"Security \\"approval\\""']) {
      const wait = { ...original, [field]: text }
      const line = waitLine(wait)
      expect(parseWaitLine(line)).toEqual(wait)
      expect(waitingForException({ cardId: id, status: 'Waiting For', type: wait.type, id: wait.id, waitingFor: line, nextCheckIn: { start: '2027-01-01' }, coverage: 'complete', observedAt: null })).toBeNull()
    }
  })
  it('reads existing single-line quoted prose', () => {
    expect(parseWaitLine('Dependency: "Security approval" must be recorded | Unblocks when: "Approval" is recorded | Follow-up: "Consumer" team | Type: Actor | ID: "Security" team')).toEqual({ type: 'Actor', id: '"Security" team', dependency: '"Security approval" must be recorded', unblocks_when: '"Approval" is recorded', follow_up_by: '"Consumer" team' })
  })
})

it('accepts maximum serialized waits as exact assignment and decision resolution inputs', () => {
  const escaped = (length: number) => '"' + '\u0001'.repeat(length - 1)
  const wait = waitSchema.parse({ type: 'Actor', id: escaped(2048), dependency: escaped(12000), unblocks_when: escaped(12000), follow_up_by: escaped(200), next_check_in: '2027-01-01' })
  const resolve_wait = waitLine(wait)
  expect(resolve_wait.length).toBeGreaterThan(150000)
  expect(parseWaitLine(resolve_wait)).toMatchObject({ type: wait.type, id: wait.id, dependency: wait.dependency, unblocks_when: wait.unblocks_when, follow_up_by: wait.follow_up_by })
  for (const operation of [
    { kind: 'assign', owner: 'Firstmate', status: 'Queued' },
    { kind: 'answer_decision', request_id: 'length-ask', answer: 'Resolved', next: { owner: 'Firstmate', status: 'Queued' } },
  ]) {
    const parsed = updateWorkSchema.parse({ card_id: id, operation_id: `length-${operation.kind}`, ...operation, resolve_wait })
    expect('resolve_wait' in parsed && parsed.resolve_wait).toBe(resolve_wait)
  }
})
