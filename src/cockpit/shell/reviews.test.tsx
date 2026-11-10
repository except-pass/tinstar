// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NeedsYouPanel } from './NeedsYouPanel'
import { apiFetch } from '../../apiClient'
import type { ReviewView } from '../../shared/reviews'
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
