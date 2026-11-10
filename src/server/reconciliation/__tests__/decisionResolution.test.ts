import { describe, expect, it, vi } from 'vitest'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { bindDecision, reconcileDecision, requestKey, type DecisionDelivery } from '../decisionResolution'
import type { ListedMessage } from '../../fleet/inbox'
import type { WorkflowNote } from '../workflowContent'
import { notionCard } from '../notion'
import { queueSignals } from '../queueInputs'

const cardId = '41450ce6d4228114a5a9cc54ba311d54'
function fixture() {
  const snapshot = fixtureSources({ now: Date.now() }), home = snapshot.fleet[0]!
  home.observation.status = 'fresh'; home.observation.coverage = 'complete'; home.observation.expiresAt = new Date(Date.now() + 60_000).toISOString()
  home.observation.data!.tasks = []
  home.observation.data!.backlog = [{
    id: 'site-merge-mailbox-r3', title: 'Mailbox replication', state: 'held', captain_actionable: true,
    hold_reason: 'Keep R1 or approve R3?', cardReferences: [{ pageId: cardId, basis: 'explicit', source: 'notion_page_id' }],
    ...queueSignals({ hold_kind: 'captain' }),
  }] as NonNullable<typeof home.observation.data>['backlog']
  const request = { home: home.source.home, taskId: null, id: 'site-merge-mailbox-r3', kind: 'hold' as const }
  const card = notionCard({ object: 'page', id: cardId, last_edited_time: new Date().toISOString(), properties: { Status: { type: 'status', status: { name: 'Queued' } } } })
  const binding = bindDecision(snapshot.fleet, request, cardId)
  const notes: WorkflowNote[] = [
    { id: 'proposal', text: `Tin Star request: ${JSON.stringify({ id: 'mailbox-proposal', action: 'Decision', ...binding })}` },
    { id: 'approval', text: 'Tin Star answer: "mailbox-proposal"\nAnswer: R3\nNext owner: Firstmate\nNext status: Queued' },
  ]
  const messages: ListedMessage[] = []
  const delivery: DecisionDelivery = {
    messages: vi.fn(async () => messages),
    submit: vi.fn(async (input, resolution) => {
      if (!messages.some(message => message.requestId === input.requestId)) messages.push({ requestId: input.requestId, sourceAnchor: input.anchorKey, home: request.home, taskId: null, decisionKey: request.id, holdId: request.id, cardType: 'decision', text: input.text, kind: 'answer', decisionResolution: resolution, state: 'saved', announced: true, reply: null, canReceive: true })
      return { saved: true, error: null, canReceive: true }
    }),
    completeDecision: vi.fn(async () => {}),
  }
  const confirm = vi.fn(async (text: string, marker: string) => { notes.push({ id: 'confirmation', text: `${text}\n${marker}` }) })
  const reconcile = () => reconcileDecision(card, notes, snapshot.fleet, delivery, confirm)
  return { snapshot, home, request, card, notes, messages, delivery, confirm, reconcile }
}

describe('source-scoped First Mate decision reconciliation', () => {
  it('reproduces R3: a queued Notion answer stays pending until receipt and source closure, then confirms once', async () => {
    const f = fixture()
    expect(await f.reconcile()).toMatchObject({ state: 'pending' })
    expect(f.messages).toHaveLength(1)
    expect(f.messages[0]!.text).toContain('Exact owner answer:\nR3\n')
    expect(f.messages[0]!.decisionResolution).toEqual({ cardId, requestId: 'mailbox-proposal', answerId: 'mailbox-proposal' })
    await f.reconcile()
    expect(f.delivery.submit).toHaveBeenCalledTimes(1)
    f.messages[0]!.state = 'acknowledged'
    expect(await f.reconcile()).toMatchObject({ state: 'pending' })
    f.home.observation.data!.backlog = []
    expect(await f.reconcile()).toMatchObject({ state: 'resolved' })
    f.messages[0]!.state = 'done'
    expect(await f.reconcile()).toMatchObject({ state: 'resolved' })
    expect(await f.reconcile()).toMatchObject({ state: 'resolved' })
    expect(f.confirm).toHaveBeenCalledTimes(1)
    expect(f.delivery.submit).toHaveBeenCalledTimes(1)
    expect(f.card.properties.Status!.value).toBe('Queued')
  })
  it('uses only the originating acknowledgment and fresh closure when another home is unavailable', async () => {
    const f = fixture()
    await f.reconcile()
    const unrelated = structuredClone(f.home)
    unrelated.source.home = '/fixture/unrelated-offline'
    unrelated.observation.status = 'unknown'; unrelated.observation.coverage = 'unknown'; unrelated.observation.data = null
    f.snapshot.fleet.push(unrelated)
    f.home.observation.data!.backlog = []
    expect(await f.reconcile()).toMatchObject({ state: 'pending' }) // source closed but receipt is only saved
    f.messages[0]!.state = 'acknowledged' // fleet-wide done is intentionally unavailable
    expect(await f.reconcile()).toMatchObject({ state: 'resolved' })
    expect(f.confirm).toHaveBeenCalledTimes(1)
  })
  it('records a truthful partial failure and retries the same delivery identity', async () => {
    const f = fixture()
    vi.mocked(f.delivery.submit).mockResolvedValueOnce({ saved: false, error: 'fixture unavailable', canReceive: 'unknown' })
    expect(await f.reconcile()).toMatchObject({ state: 'pending', message: 'Decision recorded · First Mate not yet updated' })
    const first = vi.mocked(f.delivery.submit).mock.calls[0]![0]
    await f.reconcile()
    expect(vi.mocked(f.delivery.submit).mock.calls[1]![0]).toEqual(first)
    expect(f.messages).toHaveLength(1)
  })
  it.each(['stale', 'missing-link', 'conflicting-link', 'changed-question', 'conflicting-answer', 'two-proposals', 'no-binding'] as const)('requires verification for %s and never delivers', async mode => {
    const f = fixture(), hold = f.home.observation.data!.backlog![0]!
    if (mode === 'stale') f.home.observation.status = 'stale'
    if (mode === 'missing-link') hold.cardReferences = []
    if (mode === 'conflicting-link') hold.cardReferences.push({ pageId: 'a'.repeat(32), basis: 'explicit', source: 'work_item' })
    if (mode === 'changed-question') hold.hold_reason = 'Approve a different mailbox operation?'
    if (mode === 'conflicting-answer') f.notes.push({ id: 'contradiction', text: 'Tin Star answer: "mailbox-proposal"\nAnswer: R1\nNext owner: Firstmate\nNext status: Queued' })
    if (mode === 'two-proposals') f.notes.push({ ...f.notes[0]!, id: 'other-proposal', text: f.notes[0]!.text.replace('mailbox-proposal', 'other') })
    if (mode === 'no-binding') f.notes[0]!.text = 'Tin Star request: {"id":"mailbox-proposal","action":"Decision"}'
    expect(await f.reconcile()).toMatchObject({ state: 'verification-needed' })
    expect(f.delivery.submit).not.toHaveBeenCalled()
  })
  it('does not infer an answer from status, unrelated edits or navigation', async () => {
    const f = fixture()
    f.notes.pop(); f.card.properties.Status!.value = 'Done'
    f.notes.push({ id: 'edit', text: 'Looks good; updated the implementation title.' })
    expect(await f.reconcile()).toBeUndefined()
    expect(f.delivery.submit).not.toHaveBeenCalled()
  })
  it('never targets another outstanding ask sharing this card or a bare request key', async () => {
    const f = fixture(), hold = f.home.observation.data!.backlog![0]!
    f.home.observation.data!.backlog!.push({ ...hold, id: 'another-ask', hold_reason: 'Approve the unrelated release?' })
    f.notes.push({ id: 'other', text: `Tin Star request: ${JSON.stringify({ id: 'other-proposal', action: 'Decision', ...bindDecision(f.snapshot.fleet, { ...f.request, id: 'another-ask' }, cardId) })}` })
    await f.reconcile()
    expect(f.messages).toHaveLength(1)
    expect(f.messages[0]!.sourceAnchor).toContain('site-merge-mailbox-r3')
    expect(f.home.observation.data!.backlog).toHaveLength(2)
  })
  it('keeps receipts until the durable confirmation write succeeds', async () => {
    const f = fixture()
    await f.reconcile(); f.messages[0]!.state = 'done'; f.home.observation.data!.backlog = []
    f.confirm.mockRejectedValueOnce(new Error('Notion temporarily unavailable'))
    expect(await f.reconcile()).toMatchObject({ state: 'pending' })
    expect(f.delivery.completeDecision).not.toHaveBeenCalled()
    expect(await f.reconcile()).toMatchObject({ state: 'resolved' })
    expect(f.delivery.submit).toHaveBeenCalledTimes(1)
  })
})

it('delivers a structured multiline answer only to its own bound proposal', async () => {
  const f = fixture()
  const second = structuredClone(f.home.observation.data!.backlog![0]!)
  second.id = 'other-hold'
  f.home.observation.data!.backlog!.push(second)
  const binding = bindDecision(f.snapshot.fleet, { ...f.request, id: second.id }, cardId)
  f.notes.push({ id: 'second-proposal', text: `Tin Star request: ${JSON.stringify({ id: 'other-proposal', action: 'Decision', ...binding })}` })
  const answer = 'Approve R3\nTin Star answer: "other-proposal"\nOperation: edit'
  f.notes[1]!.text = `Tin Star answer: "mailbox-proposal"\nAnswer: ${answer}\nNext owner: Firstmate\nNext status: Queued\nTin Star answer data: ${JSON.stringify({ request_id: 'mailbox-proposal', answer })}`
  expect(await f.reconcile()).toMatchObject({ state: 'pending', request_id: 'mailbox-proposal' })
  expect(f.messages).toHaveLength(1)
  expect(f.messages[0]!.decisionResolution!.requestId).toBe('mailbox-proposal')
  expect(f.messages[0]!.text).toContain(answer)
  expect(f.messages[0]!.sourceAnchor).toBe(requestKey(f.request))
  const { decisionRequests } = await import('../../../shared/workflowRequests')
  expect(decisionRequests(f.notes).map(row => [row.id, row.answered])).toEqual([['mailbox-proposal', true], ['other-proposal', false]])
})
