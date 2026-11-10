import { expect, it } from 'vitest'
import { askItemSchema } from '../../shared/ask'
import { answerStatus, deskConversations } from '../deskInbox'

const request = (overrides = {}) => askItemSchema.parse({
  request_id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), question: 'Can we proceed?',
  input_mode: 'text', context: { anchor: { kind: 'work', page_id: crypto.randomUUID(), label: 'Work', url: null, observed_at: null }, view: { scene: 'overview' } },
  status: 'sent', created_at: '2026-11-09T19:00:00Z', updated_at: '2026-11-09T19:00:00Z',
  reply: null, error: null, read_at: null, dismissed_at: null, ...overrides,
})
const reply = { summary: 'Ready for review', detail: 'The evidence is available.', references: [], suggested_actions: [] }

it('counts one conversation across turns and separates replies, failures, waiting and history', () => {
  const first = request({ status: 'answered', reply })
  const followUp = request({ conversation_id: first.conversation_id, created_at: '2026-11-09T19:01:00Z' })
  const waiting = request({ status: 'delivered' })
  const failed = request({ status: 'failed' })
  const history = request({ status: 'answered', reply, dismissed_at: '2026-11-09T20:00:00Z' })
  const groups = deskConversations([followUp, waiting, history, failed, first])
  expect(groups).toHaveLength(4)
  expect(groups.find(group => group.id === first.conversation_id)).toMatchObject({ view: 'needs-you', unread: true, turns: [first, followUp] })
  expect(groups.find(group => group.id === waiting.conversation_id)).toMatchObject({ view: 'waiting', unread: false })
  expect(groups.find(group => group.id === failed.conversation_id)).toMatchObject({ view: 'needs-you', failed: true })
  expect(groups.find(group => group.id === history.conversation_id)).toMatchObject({ view: 'history', unread: false })
})

it('moves a read conversation with a pending follow-up to Waiting without hiding its earlier answer', () => {
  const first = request({ status: 'answered', reply, read_at: '2026-11-09T19:02:00Z' })
  const followUp = request({ conversation_id: first.conversation_id, created_at: '2026-11-09T19:03:00Z' })
  expect(deskConversations([followUp, first])[0]).toMatchObject({ view: 'waiting', unread: false, latest: followUp, turns: [first, followUp] })
})

it('keeps read completed answers in the list without attention and ranks genuine unread replies before newer read threads', () => {
  const unread = request({ status: 'answered', reply })
  const read = request({ status: 'answered', reply, read_at: '2026-11-09T19:02:00Z', updated_at: '2026-11-09T20:00:00Z' })
  expect(deskConversations([read, unread]).map(group => [group.id, group.view, group.unread])).toEqual([
    [unread.conversation_id, 'needs-you', true], [read.conversation_id, 'needs-you', false],
  ])
  expect(deskConversations([read])[0]).toMatchObject({ attention: false })
  expect(unread.read_at).toBeNull()
})

it('does not revive archived unread replies when a new pending turn shares their conversation', () => {
  const archived = request({ status: 'answered', reply, dismissed_at: '2026-11-09T19:02:00Z' })
  const pending = request({ conversation_id: archived.conversation_id, created_at: '2026-11-09T19:03:00Z' })
  expect(deskConversations([archived, pending])[0]).toMatchObject({ view: 'waiting', unread: false, turns: [archived, pending] })
})

it.each(['sent', 'delivered'] as const)('uses waiting copy for %s without inferring failure from elapsed time', status => {
  expect(answerStatus(request({ status, created_at: '2020-01-01T00:00:00Z' }))).toBe('Waiting for answer')
})
it('classifies a saved question with a confirmed wake failure as actionable', () => {
  const item = request({ status: 'delivered', error: 'First Mate saved the question but was not woken. Retry delivery.' })
  expect(answerStatus(item)).toBe('Delivery failed')
  expect(deskConversations([item])[0]).toMatchObject({ view: 'needs-you', failed: true })
})

it('keeps a read answer with a structured action in Needs you', () => {
  const item = request({ reply: { ...reply, suggested_actions: [{ id: 'proceed', label: 'Proceed', instruction: 'Proceed with the work' }] }, read_at: '2026-11-09T19:02:00Z' })
  expect(deskConversations([item])[0]).toMatchObject({ view: 'needs-you', unread: false })
})

it.each([true, false])('classifies out-of-order replies using the current answer, with choices=%s', currentHasActions => {
  const choices = [{ id: 'proceed', label: 'Proceed', instruction: 'Proceed with the work' }]
  const first = request({ status: 'answered', answered_at: '2026-11-09T19:04:00Z', read_at: '2026-11-09T19:05:00Z', reply: { ...reply, suggested_actions: currentHasActions ? choices : [] } })
  const second = request({ conversation_id: first.conversation_id, created_at: '2026-11-09T19:01:00Z', status: 'answered', answered_at: '2026-11-09T19:03:00Z', read_at: '2026-11-09T19:05:00Z', reply: { ...reply, suggested_actions: currentHasActions ? [] : choices } })
  expect(deskConversations([second, first])[0]).toMatchObject({ view: 'needs-you', attention: currentHasActions, unread: false, latest: second })
  const followUp = request({ conversation_id: first.conversation_id, created_at: '2026-11-09T19:06:00Z' })
  expect(deskConversations([first, second, followUp])[0]).toMatchObject({ view: 'waiting', unread: false })
  first.read_at = null
  expect(deskConversations([first, second, followUp])[0]).toMatchObject({ view: 'needs-you', unread: true })
})
