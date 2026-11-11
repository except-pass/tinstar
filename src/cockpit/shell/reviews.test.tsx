// @vitest-environment jsdom
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReconciliationSources, handleReconciliationRequest } from '../../server/reconciliation'
import { WorkReader } from '../../server/reconciliation/workReader'
import { CreationReceipts } from '../../server/reconciliation/workflowReceipts'
import { AssociationStore } from '../../server/releases/associations'
import { fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import type { AttentionCard } from './types'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NeedsYouPanel } from './NeedsYouPanel'
import { apiFetch } from '../../apiClient'
import { retainReviewEvidence, separatePullReview, type ReviewEvidence, type ReviewView, type ReviewQueueRead } from '../../shared/reviews'
vi.mock('../../apiClient', () => ({ apiFetch: vi.fn(), apiUrl: (value: string) => value }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const view: ReviewView = { complete: true, warning: null, observedAt: new Date().toISOString(), items: [{ id: 'review:one', cardId: 'a'.repeat(32), submissionKey: 'one',
  title: 'Delivered PRs UI', status: 'Ready for Review', cardUrl: 'https://notion.so/card', liveUrl: 'https://example.test/?page=pulls', evidenceUrls: ['https://example.test/proof'],
  instructions: 'Inspect the compact PR list', submission: null, evidenceWarning: null }] }
function show(reviews = view, cards: AttentionCard[] = []) {
  return render(<NeedsYouPanel reviews={reviews} cards={cards} workers={[]} errors={[]} waiting={false} submit={vi.fn()} dismissing={() => false} dismissed={() => false} dismissError={() => null} onOpen={vi.fn()} onDismiss={vi.fn()} />)
}
it('uses the shared workflow for explicit approval and feedback with usable feature/evidence links', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', message: 'Explicit acceptance recorded', saved_fields: ['note'] } })))
  show()
  expect(screen.getByRole('link', { name: 'Open live feature ↗' })).toHaveAttribute('href', view.items[0]!.liveUrl)
  expect(screen.getByRole('link', { name: 'Evidence ↗' })).toHaveAttribute('href', view.items[0]!.evidenceUrls[0])
  expect(screen.getByRole('button', { name: 'Request changes' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Approve deliverable' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Explicit acceptance recorded'))
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]![1]!.body))).toMatchObject({ operation: 'update', input: { kind: 'accept_review', card_id: 'a'.repeat(32), submission_key: 'one', scope_complete: true } })
})
it('retains source uncertainty instead of claiming an empty review list is clear', () => {
  show({ items: [], complete: false, observedAt: null, warning: 'Review coverage unavailable' })
  expect(screen.getByRole('status')).toHaveTextContent('Review coverage unavailable')
  expect(screen.queryByText('Nothing needs you right now.')).toBeNull()
})
it('requires feedback and queues the same canonical submission through request changes', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { outcome: 'saved', message: 'Feedback recorded', saved_fields: ['note'] } })))
  show()
  fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'The mobile list clips' } })
  fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
  await waitFor(() => expect(apiFetch).toHaveBeenCalled())
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]![1]!.body)).input).toMatchObject({ kind: 'request_review_changes', feedback: 'The mobile list clips', submission_key: 'one' })
})

it('keeps feedback, scope and loaded evidence with their card when submission keys collide', async () => {
  const first = { ...view.items[0]!, evidenceWarning: 'Load evidence' }
  const second = { ...first, id: 'review:two', cardId: 'b'.repeat(32), title: 'Second deliverable' }
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true, data: { outcome: 'available', review: { ...first, title: 'Loaded first deliverable', evidenceWarning: null } } }))
  const props = { cards: [], workers: [], errors: [], waiting: false, submit: vi.fn(), dismissing: () => false, dismissed: () => false, dismissError: () => null, onOpen: vi.fn(), onDismiss: vi.fn() }
  const rendered = render(<NeedsYouPanel {...props} reviews={{ ...view, items: [first, second] }} />)
  const firstRow = within(screen.getByRole('article', { name: first.title }))
  fireEvent.change(firstRow.getByLabelText('Feedback'), { target: { value: 'First card feedback' } })
  fireEvent.click(firstRow.getByRole('checkbox'))
  fireEvent.click(firstRow.getByRole('button', { name: 'Load current review evidence' }))
  await screen.findByRole('article', { name: 'Loaded first deliverable' })
  rendered.rerender(<NeedsYouPanel {...props} reviews={{ ...view, items: [second] }} />)
  const row = within(screen.getByRole('article', { name: second.title }))
  expect(row.getByLabelText('Feedback')).toHaveValue('')
  expect(row.getByRole('checkbox')).not.toBeChecked()
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ ok: true, data: { outcome: 'saved', message: 'Accepted', saved_fields: ['note'] } }))
  fireEvent.click(row.getByRole('button', { name: 'Approve deliverable' }))
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[1]![1]!.body)).input).toMatchObject({ card_id: second.cardId, scope_complete: false })
})

it('preserves drafts and linked PR suppression across evidence arrival and expiry, retaining metadata edits and separating deliverables', () => {
  const first = { ...view.items[0]!, submissionKey: 'legacy:first' }
  const submission = { deliverable_id: 'first-deliverable', deployed_sha: 'a'.repeat(40), submission_key: 'structured', pulls: [{ url: 'https://github.com/except-pass/tinstar/pull/42', head: 'a'.repeat(40) }] } as ReviewEvidence
  const props = { cards: [], workers: [], errors: [], waiting: false, submit: vi.fn(), dismissing: () => false, dismissed: () => false, dismissError: () => null, onOpen: vi.fn(), onDismiss: vi.fn() }
  let queue: ReviewQueueRead = { reviews: { ...view, items: [first] }, warnings: [] }
  const rendered = render(<NeedsYouPanel {...props} reviews={queue.reviews} />)
  fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'Keep my feedback' } })
  fireEvent.change(screen.getByLabelText('Remaining scope (one item per line)'), { target: { value: 'Provisioning' } })
  fireEvent.click(screen.getByRole('checkbox'))
  for (const item of [{ ...first, submissionKey: 'structured', submission }, first, { ...first, title: 'Edited title', instructions: 'Edited next action', submissionKey: 'legacy:edited' }]) {
    queue = retainReviewEvidence({ ...queue, reviews: { ...view, items: [item] } }, queue)
    rendered.rerender(<NeedsYouPanel {...props} reviews={queue.reviews} />)
    expect(screen.getByLabelText('Feedback')).toHaveValue('Keep my feedback')
    expect(screen.getByLabelText('Remaining scope (one item per line)')).toHaveValue('Provisioning')
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(separatePullReview(submission.pulls[0]!.url, 'unknown', queue.reviews)).toBe(false)
    expect(separatePullReview(submission.pulls[0]!.url, 'open', queue.reviews)).toBe(true)
    expect(separatePullReview('https://github.com/except-pass/tinstar/pull/43', 'unknown', queue.reviews)).toBe(true)
  }
  const replacement = { ...first, submissionKey: 'new-deliverable', submission: { ...submission, deliverable_id: 'new-deliverable', submission_key: 'new-deliverable' } }
  rendered.rerender(<NeedsYouPanel {...props} reviews={{ ...view, items: [replacement] }} />)
  expect(screen.getByLabelText('Feedback')).toHaveValue('')
  expect(screen.getByLabelText('Remaining scope (one item per line)')).toHaveValue('')
  expect(screen.getByRole('checkbox')).not.toBeChecked()
})

it('suppresses linked unknown PR actions through cold HTTP reads and restart while the operational queue hangs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-cold-ui-'))
  const source = fixtureSources().intentions
  source.observedAt = new Date().toISOString(); source.expiresAt = new Date(Date.now() + 120_000).toISOString()
  const card = source.data!.cards[0]!
  card.properties.Status!.value = 'Ready for Review'
  source.data!.cards = [card]
  const pr = 'https://github.com/except-pass/tinstar/pull/42'
  const manual = 'https://github.com/except-pass/tinstar/pull/43'
  const evidence: ReviewEvidence = { submission_key: 'saved', deliverable_id: 'delivered-ui', summary: 'Delivered UI',
    pulls: [{ url: pr, head: 'a'.repeat(40) }], deployment_id: 'deploy', deployed_sha: 'a'.repeat(40),
    live_url: 'https://example.test', instructions: 'Inspect UI', remaining_scope: [],
    proof: { kind: 'ui', tested_sha: 'a'.repeat(40), passed: true, receipt: 'https://example.test/receipt', screenshots: ['https://example.test/screenshot'] } }
  await new CreationReceipts(root).putReview('review:saved', 'input', card.id, { original: {}, desired: {}, note: `Tin Star review submission: ${JSON.stringify(evidence)}`, actor: 'Firstmate', done: true })
  const associations = new AssociationStore(root)
  await associations.append({ id: '11111111-1111-4111-8111-111111111111', pull: manual, cardId: card.id, action: 'link', reason: 'Explicit card association' }, 'Firstmate')
  const query = vi.spyOn(WorkReader.prototype, 'query').mockResolvedValue(source)
  const attention = (key: string, url: string, status: AttentionCard['reviewStatus']): AttentionCard => ({
    key, homeIndex: 0, home: null, taskId: null, decisionKey: null, holdId: null, dismissal: null, type: 'review', headline: key,
    detail: '', workerKey: null, workerId: null, ageDays: null, prUrl: url, repository: 'except-pass/tinstar', prNumber: 42, reviewStatus: status, ci: 'unknown',
  })
  try {
    for (let restart = 0; restart < 2; restart++) {
      const network = vi.fn<typeof fetch>(() => { throw new Error('No history fetch on status display') })
      const sources = new ReconciliationSources({ fleet: [], warnings: [] }, network, undefined, root)
      const heavy = vi.spyOn(sources, 'queue').mockImplementation(() => new Promise(() => {}))
      void sources.queue()
      const server = createServer((req, res) => { void handleReconciliationRequest(sources, req, res) })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/queue?view=reviews`)
        const body = await response.json()
        expect(body.data.reviews.items[0].submission).toBeNull()
        expect(body.data.reviews.items[0].linkedPulls).toEqual(expect.arrayContaining([pr, manual]))
        expect(body.data.reviews.complete).toBe(true)
        const shown = show(body.data.reviews, [attention('Linked unknown', pr, 'unknown'), attention('Manual unknown', manual, 'unknown'), attention('Genuine open', pr, 'open'), attention('Unlinked unknown', pr.replace('42', '44'), 'unknown')])
        expect(screen.queryByText('Linked unknown')).toBeNull()
        expect(screen.queryByText('Manual unknown')).toBeNull()
        expect(screen.getByText('Genuine open')).toBeVisible()
        expect(screen.getByText('Unlinked unknown')).toBeVisible()
        expect(screen.getAllByRole('article')).toHaveLength(3)
        fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'Retain on metadata edit' } })
        fireEvent.change(screen.getByLabelText('Remaining scope (one item per line)'), { target: { value: 'Remaining dependency' } })
        fireEvent.click(screen.getByRole('checkbox'))
        card.last_edited_time = new Date(Date.now() + 60_000 * (restart + 1)).toISOString()
        card.properties.Name!.value = 'Updated title'
        const edited = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/reconciliation/queue?view=reviews&refresh=1`)).json()
        const props = { cards: [], workers: [], errors: [], waiting: false, submit: vi.fn(), dismissing: () => false, dismissed: () => false, dismissError: () => null, onOpen: vi.fn(), onDismiss: vi.fn() }
        shown.rerender(<NeedsYouPanel {...props} reviews={edited.data.reviews} />)
        expect(screen.getByLabelText('Feedback')).toHaveValue('Retain on metadata edit')
        expect(screen.getByLabelText('Remaining scope (one item per line)')).toHaveValue('Remaining dependency')
        expect(screen.getByRole('checkbox')).toBeChecked()
        expect(network).not.toHaveBeenCalled()
        expect(heavy).toHaveBeenCalledTimes(1)
        cleanup()
      } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }
  } finally { query.mockRestore(); await rm(root, { recursive: true, force: true }) }
})
