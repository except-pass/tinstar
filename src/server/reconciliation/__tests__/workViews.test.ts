import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReconciliationSources } from '../index'
import { CardContextReader } from '../cardContext'
import { CardLeases } from '../cardLeases'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('returns the full fresh census with bounded history while shared operational recovery is blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-views-'))
  const snapshot = fixtureSources({ now: Date.now() })
  const template = snapshot.intentions.data!.cards[0]!
  snapshot.intentions.data!.cards = Array.from({ length: 92 }, (_, index) => {
    const card = structuredClone(template)
    card.id = (index + 1).toString(16).padStart(32, '0')
    card.properties.Owner!.value = 'Will'
    card.properties.Status!.value = index < 78 ? 'In Progress' : 'Ready for Review'
    card.properties['Will action'] = { id: 'action', type: 'multi_select', value: index < 78 ? ['Decision'] : [], hasMore: false }
    card.properties['Next action'] = { id: 'next', type: 'rich_text', value: 'Choose an option', hasMore: false }
    return card
  })
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, fetch, undefined, root)
  const read = vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
  const recovery = vi.spyOn(sources.workflow, 'reconcileReviews').mockImplementation(() => new Promise(() => {}))
  const handoffs = sources.reconcileReviewHandoffs = vi.fn(async () => {})
  const history = vi.spyOn(CardContextReader.prototype, 'commentDetails').mockResolvedValue({ outcome: 'available', blocks: [] })
  try {
    const first = await sources.workViews()
    expect(read).toHaveBeenCalledWith(true)
    expect(first.needsWill).toHaveLength(78)
    expect(first.reviews.items).toHaveLength(14)
    expect(first.reviews.complete).toBe(true)
    expect(first.coverage.intentions).toMatchObject({ status: 'fresh', coverage: 'complete' })
    expect(history).toHaveBeenCalledTimes(20)
    expect(history.mock.calls.every(([, force]) => force === true)).toBe(true)
    expect(first.warnings).toContainEqual(expect.stringContaining('20 of 78'))
    expect(first.warnings).toContainEqual(expect.stringContaining('reconciliation and uncached review submission history refresh in the background'))
    expect(first.reviews.items.every(item => !!item.evidenceWarning)).toBe(true)
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(1))
    expect(handoffs).not.toHaveBeenCalled()
    // A second tool call must not wait for or duplicate the stuck refresh.
    const second = await sources.workViews()
    expect(second.needsWill).toHaveLength(78)
    expect(second.reviews.items).toHaveLength(14)
    expect(recovery).toHaveBeenCalledTimes(1)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 2000)

it('bounds slow history waits while retaining every request with honest readiness', async () => {
  vi.useFakeTimers()
  const root = await mkdtemp(join(tmpdir(), 'work-views-deadline-'))
  const snapshot = fixtureSources({ now: Date.now() })
  const card = snapshot.intentions.data!.cards[0]!
  card.properties.Owner!.value = 'Will'
  card.properties.Status!.value = 'In Progress'
  card.properties['Will action'] = { id: 'action', type: 'multi_select', value: ['Decision'], hasMore: false }
  card.properties['Next action'] = { id: 'next', type: 'rich_text', value: 'Choose an option', hasMore: false }
  snapshot.intentions.data!.cards = [card]
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, fetch, undefined, root)
  vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
  vi.spyOn(sources.workflow, 'reconcileReviews').mockImplementation(() => new Promise(() => {}))
  let finish!: (value: { outcome: 'available'; blocks: [] }) => void
  vi.spyOn(CardContextReader.prototype, 'commentDetails').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  try {
    const pending = sources.workViews()
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending
    expect(result.needsWill).toHaveLength(1)
    expect(result.needsWill![0]).toMatchObject({ readiness: 'needs-readiness-verification', oneTouch: false, proposalHistoryComplete: false, ageBasis: 'unknown' })
    expect(result.warnings).toContainEqual(expect.stringContaining('0 of 1 candidate cards'))
    expect(result.warnings).toContainEqual(expect.stringContaining('ten-second budget'))
    finish({ outcome: 'available', blocks: [] })
    await vi.advanceTimersByTimeAsync(0)
    // Completing background evidence cannot mutate the already-returned view.
    expect(result.needsWill![0]!.proposalHistoryComplete).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 2000)


it('refreshes cached request history after another process answers a decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-views-history-'))
  const snapshot = fixtureSources({ now: Date.now() })
  snapshot.fleet = []
  const card = snapshot.intentions.data!.cards[0]!
  snapshot.intentions.data!.cards = [card]
  card.properties.Owner!.value = 'Will'
  card.properties.Status!.value = 'Waiting For'
  for (const [name, value] of Object.entries({ 'Waiting For': 'Will: Approve the exception', 'Waiting For Type': 'Actor', 'Waiting For ID': 'Will' })) card.properties[name] = { id: name, type: 'rich_text', value, hasMore: false }
  card.properties['Will action'] = { id: 'action', type: 'multi_select', value: ['Decision'], hasMore: false }
  card.properties['Next action'] = { id: 'next', type: 'rich_text', value: '', hasMore: false }
  const notes: Array<{ id: string; created_by?: { id: string }; rich_text: Array<{ plain_text: string }> }> = [{ id: 'request', rich_text: [{
    plain_text: 'Tin Star request: {"id":"approval","action":"Decision","requested_from":"Other","question":"Different question"}\nRequested from: Will\nQuestion: Approve the exception?',
  }] }]
  const fetcher = vi.fn<typeof fetch>(async url => new URL(String(url)).pathname === '/v1/users/me'
    ? Response.json({ type: 'bot', id: 'fixture-writer' })
    : Response.json({ results: notes, has_more: false }))
  const sources = new ReconciliationSources({ fleet: [], warnings: [], notion: { token: 'fixture-token', dataSourceId: 'a'.repeat(32) } }, fetcher, undefined, root)
  vi.spyOn(sources, 'snapshot').mockResolvedValue({ ...snapshot, diagnostics: { notion: sources.notionApi.diagnostics } })
  vi.spyOn(sources.workflow, 'reconcileReviews').mockImplementation(() => new Promise(() => {}))
  try {
    const first = await sources.workViews()
    expect(first.needsWill![0]!.requests).toMatchObject([{
      id: 'approval', requestedFrom: 'Will', question: 'Approve the exception?', answered: false,
    }])
    const other = new CardLeases(root)
    await other.mutate(card.id, async () => {
      notes.push({ id: 'answer', rich_text: [{ plain_text: 'Tin Star answer: "approval"' }] })
    })
    const second = await sources.workViews()
    expect(second.needsWill![0]!.proposalHistoryComplete).toBe(true)
    expect(second.needsWill![0]!.requests).toEqual([])
    const prod = 'secret_rotation_approval_prod'
    const stage = 'secret_rotation_approval_stage'
    await other.mutate(card.id, async () => {
      for (const [id, question] of [[prod, 'Approve production?'], [stage, 'Approve staging?']] as const) {
        notes.push({ id: question, rich_text: [{
          plain_text: `Tin Star request: ${JSON.stringify({ id, action: 'Decision' })}\nRequested from: Will\nQuestion: ${question}`,
        }] })
      }
      notes.push({ id: 'withdrawal', created_by: { id: 'fixture-writer' }, rich_text: [{
        plain_text: `Date: 2025-01-01T00:00:00.000Z\nBy: Will\nOperation: withdraw_decision\nReason: Correct scope\nTin Star withdrawal: ${JSON.stringify({ id: prod })}\nTin Star operation: ["Will","scope-correction"]`,
      }] })
    })
    const third = await sources.workViews()
    expect(third.needsWill![0]!.requests).toMatchObject([{ id: '[credential omitted]', question: 'Approve staging?' }])
    expect(JSON.stringify(third)).not.toContain(stage)
    expect(JSON.stringify(third)).not.toContain(prod)
    expect((await sources.card(card.id, true)).answerSources).toEqual({
      excluded: ['Approve production?', 'withdrawal'],
      replacements: [],
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})
