import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { initialPresentation } from '../presentation'
import { QueuePanel } from '../QueuePanel'
afterEach(cleanup)
it('keeps unverified requests secondary and revokes actionable controls when selected evidence expires', () => {
  const now = Date.now(), queue = fixtureQueue(now), send = vi.fn(), controls = vi.fn(() => null)
  const state = { ...initialPresentation(), queueItemId: queue.items.find(item => item.readiness === 'ready-now')!.id }
  const { rerender } = render(<QueuePanel state={state} send={send} queue={queue} error={null} now={now} requestControls={controls} />)
  expect(controls).toHaveBeenLastCalledWith(expect.objectContaining({ id: state.queueItemId }), true)
  expect(screen.queryByText('No verified request ready')).toBeNull()
  expect(screen.getByText(/Later & needs verification/)).toBeTruthy()
  rerender(<QueuePanel state={state} send={send} queue={queue} error={null} now={now + 61_000} requestControls={controls} />)
  expect(controls).toHaveBeenLastCalledWith(expect.objectContaining({ id: state.queueItemId }), false)
  expect(screen.getByText('Needs verification', { selector: '.ov-eyebrow' })).toBeTruthy()
  expect(send).not.toHaveBeenCalled()
})

it('retains a disappeared selection while offering the remaining ready request', () => {
  const now = Date.now(), queue = fixtureQueue(now), send = vi.fn()
  const ready = queue.items.filter(item => item.readiness === 'ready-now')
  const state = { ...initialPresentation(), queueItemId: ready[0]!.id }
  const { rerender } = render(<QueuePanel state={state} send={send} queue={queue} error={null} now={now} />)
  rerender(<QueuePanel state={state} send={send} queue={{ ...queue, items: queue.items.filter(item => item.id !== state.queueItemId) }} error={null} now={now} />)
  expect(screen.getByText('Selected request unavailable')).toBeTruthy()
  expect(screen.queryByText('No verified request ready')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(ready[1]!.title) }))
  expect(send).toHaveBeenCalledWith({ type: 'open-queue', itemId: ready[1]!.id })
  expect(state.queueItemId).toBe(ready[0]!.id)
})
