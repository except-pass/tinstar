// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NeedsYouPanel } from './NeedsYouPanel'
import { apiFetch } from '../../apiClient'
import { retainReviewEvidence, separatePullReview, type ReviewEvidence, type ReviewView } from '../../shared/reviews'
vi.mock('../../apiClient', () => ({ apiFetch: vi.fn(), apiUrl: (value: string) => value }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const view: ReviewView = { complete: true, warning: null, observedAt: new Date().toISOString(), items: [{ id: 'review:one', cardId: 'a'.repeat(32), submissionKey: 'one',
  title: 'Delivered PRs UI', status: 'Ready for Review', cardUrl: 'https://notion.so/card', liveUrl: 'https://example.test/?page=pulls', evidenceUrls: ['https://example.test/proof'],
  instructions: 'Inspect the compact PR list', submission: null, evidenceWarning: null }] }
function show(reviews = view) {
  return render(<NeedsYouPanel reviews={reviews} cards={[]} workers={[]} errors={[]} waiting={false} submit={vi.fn()} dismissing={() => false} dismissed={() => false} dismissError={() => null} onOpen={vi.fn()} onDismiss={vi.fn()} />)
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

it('preserves drafts and linked PR suppression across evidence arrival and expiry, separating revisions', () => {
  const first = { ...view.items[0]!, revision: 'revision-one', submissionKey: 'legacy:first' }
  const submission = { submission_key: 'structured', pulls: [{ url: 'https://github.com/except-pass/tinstar/pull/42', head: 'a'.repeat(40) }] } as ReviewEvidence
  const props = { cards: [], workers: [], errors: [], waiting: false, submit: vi.fn(), dismissing: () => false, dismissed: () => false, dismissError: () => null, onOpen: vi.fn(), onDismiss: vi.fn() }
  let queue = { reviews: { ...view, items: [first] }, warnings: [] }
  const rendered = render(<NeedsYouPanel {...props} reviews={queue.reviews} />)
  fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'Keep my feedback' } })
  fireEvent.change(screen.getByLabelText('Remaining scope (one item per line)'), { target: { value: 'Provisioning' } })
  fireEvent.click(screen.getByRole('checkbox'))
  for (const item of [{ ...first, submissionKey: 'structured', submission }, first]) {
    queue = retainReviewEvidence({ ...queue, reviews: { ...view, items: [item] } }, queue)
    rendered.rerender(<NeedsYouPanel {...props} reviews={queue.reviews} />)
    expect(screen.getByLabelText('Feedback')).toHaveValue('Keep my feedback')
    expect(screen.getByLabelText('Remaining scope (one item per line)')).toHaveValue('Provisioning')
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(separatePullReview(submission.pulls[0]!.url, 'unknown', queue.reviews)).toBe(false)
    expect(separatePullReview(submission.pulls[0]!.url, 'open', queue.reviews)).toBe(true)
    expect(separatePullReview('https://github.com/except-pass/tinstar/pull/43', 'unknown', queue.reviews)).toBe(true)
  }
  const replacement = { ...first, submissionKey: 'new-deliverable', submission: { ...submission, submission_key: 'new-deliverable' } }
  rendered.rerender(<NeedsYouPanel {...props} reviews={{ ...view, items: [replacement] }} />)
  expect(screen.getByLabelText('Feedback')).toHaveValue('')
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  queue = retainReviewEvidence({ ...queue, reviews: { ...view, items: [{ ...first, revision: 'revision-two' }] } }, queue)
  expect(queue.reviews.items[0]!.submission).toBeNull()
  rendered.rerender(<NeedsYouPanel {...props} reviews={queue.reviews} />)
  expect(screen.getByLabelText('Feedback')).toHaveValue('')
  expect(screen.getByLabelText('Remaining scope (one item per line)')).toHaveValue('')
  expect(screen.getByRole('checkbox')).not.toBeChecked()
})
