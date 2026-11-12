import { describe, expect, it, vi } from 'vitest'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { bindDecision, reconcileDecision, requestKey, type DecisionDelivery } from '../decisionResolution'
import type { ListedMessage } from '../../fleet/inbox'
import type { WorkflowNote } from '../workflowContent'
import { notionCard } from '../notion'
import { queueSignals } from '../queueInputs'
import { parseWorkerLinks, workerLinkRecord, WORKER_LINK_SCHEMA } from '../workerLinks'
import { buildQueue } from '../queue'

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

function taskLinkFixture() {
  const f = fixture()
  const task = structuredClone(f.snapshot.fleet[1]!.observation.data!.tasks[0]!)
  task.identity.fm_home = f.request.home
  task.cardReferences = []
  f.home.observation.data!.tasks = [task]
  const hold = f.home.observation.data!.backlog![0]!
  hold.cardReferences = []
  hold.queue!.originTaskId = String(task.id)
  const request = { ...f.request, taskId: String(task.id) }
  const links = workerLinkRecord([{ fm_home: request.home, task_id: request.taskId, first_observed_spawn_gen: task.identity.spawn_gen! }])
  const card = notionCard({ object: 'page', id: cardId, last_edited_time: new Date().toISOString(), properties: {
    Status: { type: 'status', status: { name: 'In Progress' } }, Owner: { type: 'select', select: { name: 'Firstmate' } },
    'First Mate tasks': { type: 'rich_text', ...links.properties['First Mate tasks'] },
  } })
  f.snapshot.intentions.data!.cards = [card]
  const bind = () => bindDecision(f.snapshot.fleet, request, cardId, f.snapshot.intentions)
  return { ...f, task, hold, request, card, bind }
}

function declare(card: ReturnType<typeof taskLinkFixture>['card'], tasks: unknown) {
  const json = typeof tasks === 'string' ? tasks : JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks })
  const property = card.properties['First Mate tasks']!
  property.value = json
  property.hasMore = false
  property.workerLinks = parseWorkerLinks(json)
}

describe('canonical card binding from First Mate tasks', () => {
  it('binds exactly one validated home/task match and projects the same card in Decisions', () => {
    const f = taskLinkFixture()
    expect(f.bind()).toEqual({ source_request: f.request, source_question: f.hold.hold_reason, source_spawn_gen: f.task.identity.spawn_gen })
    expect(buildQueue(f.snapshot).items.find(item => item.sources.some(source => source.request?.id === f.request.id)))
      .toMatchObject({ cardIds: [cardId], readiness: 'ready-now' })
  })
  it('binds a valid unique match when other cards declare an invalid unrelated task', () => {
    const f = taskLinkFixture()
    for (const [id, task] of [['c'.repeat(32), 'kd-tariff-pge-prod-publish'], ['d'.repeat(32), 'kd-tariff-materiality-next']] as const) {
      const stale = { ...structuredClone(f.card), id }
      declare(stale, [{ fm_home: '/home/farm/fm-kdf', task_id: task, first_observed_spawn_gen: null }])
      f.snapshot.intentions.data!.cards.push(stale)
    }
    expect(f.bind()).toEqual({ source_request: f.request, source_question: f.hold.hold_reason, source_spawn_gen: f.task.identity.spawn_gen })
    expect(buildQueue(f.snapshot).items.find(item => item.sources.some(source => source.request?.id === f.request.id)))
      .toMatchObject({ cardIds: [cardId], readiness: 'ready-now' })
  })
  it('refuses an invalid declaration that names the same task', () => {
    const f = taskLinkFixture()
    const competing = { ...structuredClone(f.card), id: 'e'.repeat(32) }
    declare(competing, [{ fm_home: f.request.home, task_id: f.request.taskId, first_observed_spawn_gen: null }])
    f.snapshot.intentions.data!.cards.push(competing)
    expect(f.bind).toThrow(`link coverage is unknown on cards ${competing.id}`)
    f.snapshot.intentions.data!.cards = [f.card]
    declare(f.card, [{ fm_home: f.request.home, task_id: f.request.taskId, first_observed_spawn_gen: null }])
    expect(f.bind).toThrow(`link coverage is unknown on cards ${f.card.id}`)
  })
  it('refuses unparseable task JSON and a declaration with an unreadable entry', () => {
    const f = taskLinkFixture()
    const broken = { ...structuredClone(f.card), id: 'f'.repeat(32) }
    declare(broken, '{')
    f.snapshot.intentions.data!.cards.push(broken)
    expect(f.bind).toThrow(`link coverage is unknown on cards ${broken.id}`)
    declare(broken, [
      { fm_home: '/home/farm/fm-kdf', task_id: 'kd-tariff-pge-prod-publish', first_observed_spawn_gen: null },
      { fm_home: f.request.home, task_id: null, first_observed_spawn_gen: null },
    ])
    expect(f.bind).toThrow(`link coverage is unknown on cards ${broken.id}`)
    const hidden = `{"schema":${JSON.stringify(WORKER_LINK_SCHEMA)},"tasks":[{"fm_home":${JSON.stringify(f.request.home)},"task_id":${JSON.stringify(f.request.taskId)},"first_observed_spawn_gen":"g"}],"tasks":[{"fm_home":"/home/farm/fm-kdf","task_id":"other","first_observed_spawn_gen":null}]}`
    declare(broken, hidden)
    expect(f.bind).toThrow(`link coverage is unknown on cards ${broken.id}`)
  })
  it.each(['home', 'task'] as const)('refuses no match when the linked %s differs, naming the exact search', field => {
    const f = taskLinkFixture()
    f.card.properties['First Mate tasks']!.workerLinks = { status: 'valid', tasks: [{ fm_home: field === 'home' ? '/other-home' : f.request.home,
      task_id: field === 'task' ? 'other-task' : f.request.taskId, first_observed_spawn_gen: f.task.identity.spawn_gen! }] }
    expect(f.bind).toThrow(`fm_home=${JSON.stringify(f.request.home)} + task_id=${JSON.stringify(f.request.taskId)}: 0 matching cards`)
  })
  it('refuses two distinct cards linking the same task', () => {
    const f = taskLinkFixture(), other = { ...structuredClone(f.card), id: 'b'.repeat(32) }
    f.snapshot.intentions.data!.cards.push(other)
    expect(f.bind).toThrow('2 matching cards')
  })
  it('keeps an explicit source reference authoritative over competing card links', () => {
    const f = taskLinkFixture(), other = { ...structuredClone(f.card), id: 'b'.repeat(32) }
    f.snapshot.intentions.data!.cards = [other]
    f.hold.cardReferences = [{ pageId: cardId, basis: 'explicit', source: 'work_item' }]
    expect(f.bind().source_request).toEqual(f.request)
    expect(() => bindDecision(f.snapshot.fleet, f.request, other.id, f.snapshot.intentions)).toThrow(`canonical card ${cardId}`)
    f.hold.cardReferences.push({ pageId: other.id, basis: 'explicit', source: 'notion_page_id' })
    expect(f.bind).toThrow('request lacks one explicit canonical card link')
  })
  it.each(['fleet-stale', 'fleet-partial', 'cards-stale', 'cards-expired', 'cards-partial', 'pagination', 'invalid-schema', 'missing-property', 'truncated-property'] as const)(
    'preserves unknown coverage for %s instead of claiming no match', mode => {
      const f = taskLinkFixture()
      if (mode === 'fleet-stale') f.home.observation.status = 'stale'
      if (mode === 'fleet-partial') f.home.observation.coverage = 'partial'
      if (mode === 'cards-stale') f.snapshot.intentions.status = 'stale'
      if (mode === 'cards-expired') f.snapshot.intentions.expiresAt = new Date(Date.now() - 1).toISOString()
      if (mode === 'cards-partial') f.snapshot.intentions.coverage = 'partial'
      if (mode === 'pagination') f.snapshot.intentions.data!.hasMore = true
      if (mode === 'invalid-schema') f.card.properties['First Mate tasks']!.workerLinks = { status: 'invalid', reason: 'Unknown schema' }
      if (mode === 'missing-property') delete f.card.properties['First Mate tasks']
      if (mode === 'truncated-property') f.card.properties['First Mate tasks']!.workerLinks = { status: 'unknown', reason: 'Truncated property' }
      expect(f.bind).toThrow(/unknown|stale or incomplete/)
      expect(f.bind).not.toThrow('0 matching cards')
    })
  it.each(['no-match', 'ambiguous', 'unreadable', 'partial'] as const)('keeps %s fallback ownership out of actionable queue readiness', mode => {
    const f = taskLinkFixture()
    if (mode === 'no-match') f.snapshot.intentions.data!.cards = []
    if (mode === 'ambiguous') f.snapshot.intentions.data!.cards.push({ ...structuredClone(f.card), id: 'b'.repeat(32) })
    if (mode === 'unreadable') f.snapshot.intentions.data!.cards.push({ ...structuredClone(f.card), id: 'b'.repeat(32), properties: {} })
    if (mode === 'partial') f.snapshot.intentions.coverage = 'partial'
    const item = buildQueue(f.snapshot).items.find(item => item.sources.some(source => source.request?.id === f.request.id))!
    expect(item.readiness).toBe('needs-readiness-verification')
    expect(item.oneTouch).toBe(false)
    expect(item.reasons.join(' ')).toContain(`fm_home=${JSON.stringify(f.request.home)} + task_id=${JSON.stringify(f.request.taskId)}`)
  })
  it('loads fresh card coverage only for an answered fallback request', async () => {
    const f = taskLinkFixture(), census = vi.fn(async () => f.snapshot.intentions)
    f.notes[0]!.text = `Tin Star request: ${JSON.stringify({ id: 'mailbox-proposal', action: 'Decision', ...f.bind() })}`
    const reconcile = () => reconcileDecision(f.card, f.notes, f.snapshot.fleet, f.delivery, f.confirm, undefined, census)
    const answer = f.notes.pop()!
    expect(await reconcile()).toBeUndefined()
    expect(census).not.toHaveBeenCalled()
    f.notes.push(answer)
    f.hold.cardReferences = [{ pageId: cardId, basis: 'explicit', source: 'notion_page_id' }]
    expect(await reconcile()).toMatchObject({ state: 'pending' })
    expect(census).not.toHaveBeenCalled()
    f.hold.cardReferences = []
    f.snapshot.intentions.data!.cards = []
    expect(await reconcile()).toMatchObject({ state: 'verification-needed' })
    expect(census).toHaveBeenCalledTimes(1)
    expect(f.delivery.submit).toHaveBeenCalledTimes(1)
  })
  it('revalidates task links before delivering an answer and retains receipt-plus-closure resolution', async () => {
    const f = taskLinkFixture()
    f.notes[0]!.text = `Tin Star request: ${JSON.stringify({ id: 'mailbox-proposal', action: 'Decision', ...f.bind() })}`
    const reconcile = () => reconcileDecision(f.card, f.notes, f.snapshot.fleet, f.delivery, f.confirm, undefined, f.snapshot.intentions)
    const duplicate = { ...structuredClone(f.card), id: 'b'.repeat(32) }
    f.snapshot.intentions.data!.cards.push(duplicate)
    expect(await reconcile()).toMatchObject({ state: 'verification-needed' })
    expect(f.delivery.submit).not.toHaveBeenCalled()
    f.snapshot.intentions.data!.cards.pop()
    expect(await reconcile()).toMatchObject({ state: 'pending' })
    expect(f.messages).toHaveLength(1)
    f.messages[0]!.state = 'acknowledged'
    f.home.observation.data!.backlog = []
    expect(await reconcile()).toMatchObject({ state: 'resolved' })
  })
})

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
  it.each(['stale', 'missing-link', 'conflicting-link', 'changed-question', 'conflicting-answer', 'no-binding'] as const)('requires verification for %s and never delivers', async mode => {
    const f = fixture(), hold = f.home.observation.data!.backlog![0]!
    if (mode === 'stale') f.home.observation.status = 'stale'
    if (mode === 'missing-link') hold.cardReferences = []
    if (mode === 'conflicting-link') hold.cardReferences.push({ pageId: 'a'.repeat(32), basis: 'explicit', source: 'work_item' })
    if (mode === 'changed-question') hold.hold_reason = 'Approve a different mailbox operation?'
    if (mode === 'conflicting-answer') f.notes.push({ id: 'contradiction', text: 'Tin Star answer: "mailbox-proposal"\nAnswer: R1\nNext owner: Firstmate\nNext status: Queued' })
    if (mode === 'no-binding') f.notes[0]!.text = 'Tin Star request: {"id":"mailbox-proposal","action":"Decision"}'
    expect(await f.reconcile()).toMatchObject({ state: 'verification-needed' })
    expect(f.delivery.submit).not.toHaveBeenCalled()
  })
  it('retains legacy request metadata without treating another bound row as a competitor', async () => {
    const f = fixture()
    f.notes.push({ ...f.notes[0]!, id: 'other-proposal', text: f.notes[0]!.text.replace('mailbox-proposal', 'other') })
    expect(await f.reconcile()).toMatchObject({ state: 'pending' })
    expect(f.messages).toHaveLength(1)
    expect(f.messages[0]!.decisionResolution?.requestId).toBe('mailbox-proposal')
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

it('preserves multiline legacy answers carrying a terminal workflow receipt', async () => {
  const f = fixture(), answer = 'R3\nNext owner: Will\nPreserve existing replicas'
  f.notes[1]!.text = `Tin Star answer: "mailbox-proposal"\nAnswer: ${answer}\nNext owner: Firstmate\nNext status: Queued\nTin Star operation: ["Owner","legacy-answer"]`
  expect(await f.reconcile()).toMatchObject({ state: 'pending' })
  expect(f.messages[0]!.text).toContain(`Exact owner answer:\n${answer}\n`)
})
