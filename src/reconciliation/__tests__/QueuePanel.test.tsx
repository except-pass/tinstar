import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
