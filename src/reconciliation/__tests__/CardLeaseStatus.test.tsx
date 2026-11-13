import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CardLeaseStatus } from '../CardLeaseStatus'
import { apiFetch } from '../../apiClient'
vi.mock('../../apiClient', () => ({ apiFetch: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.mocked(apiFetch).mockReset() })

it('reads backend holder state, releases the displayed generation and reflects release after reload', async () => {
  let lease: object | null = { card_id: 'a'.repeat(32), holder: 'ChatGPT · chat fixture', generation: 7, expires_at: '2026-11-13T15:00:00Z' }
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.operation === 'release-lease') {
      expect(request.input).toEqual({ card_id: 'a'.repeat(32), generation: 7, reason: 'Owner released from card' })
      lease = null
      return new Response(JSON.stringify({ ok: true, data: { outcome: 'released' } }))
    }
    expect(request.operation).toBe('lease')
    return new Response(JSON.stringify({ ok: true, data: { lease, can_release: true } }))
  })
  const view = render(<CardLeaseStatus cardId={'a'.repeat(32)} />)
  expect(await screen.findByText(/Held by ChatGPT/)).toBeTruthy()
  expect(view.container.querySelector('time')?.dateTime).toBe('2026-11-13T15:00:00Z')
  fireEvent.click(screen.getByRole('button', { name: 'Release lease' }))
  await screen.findByText('Lease released.')
  await waitFor(() => expect(screen.queryByText(/Held by ChatGPT/)).toBeNull())
  view.unmount()
  render(<CardLeaseStatus cardId={'a'.repeat(32)} />)
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4))
  expect(screen.queryByRole('button', { name: 'Release lease' })).toBeNull()
})

it('polls status without renewing and shows no release to a non-owner', async () => {
  vi.useFakeTimers()
  // Each response body is consumable once, like the real HTTP interface.
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ ok: true, data: { lease: { holder: 'Other chat', generation: 1, expires_at: '2026-11-13T15:00:00Z' }, can_release: false } })))
  render(<CardLeaseStatus cardId={'a'.repeat(32)} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(screen.getByText(/Held by Other chat/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Release lease' })).toBeNull()
  expect(apiFetch).toHaveBeenCalledTimes(2)
  for (const [, init] of vi.mocked(apiFetch).mock.calls) expect(JSON.parse(String(init?.body)).operation).toBe('lease')
})
