import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fixtureQueue } from '../../../test-fixtures/reconciliation/scenes'
import { initialPresentation } from '../presentation'
import { QueuePanel } from '../QueuePanel'
afterEach(cleanup)
it('keeps unverified requests secondary and updates readiness when selected evidence expires', () => {
  const now = Date.now(), queue = fixtureQueue(now), send = vi.fn()
  const state = { ...initialPresentation(), queueItemId: queue.items.find(item => item.readiness === 'ready-now')!.id }
  const { rerender } = render(<QueuePanel state={state} send={send} queue={queue} error={null} now={now} />)
  expect(screen.queryByText('No verified request ready')).toBeNull()
  expect(screen.getByText(/Later & needs verification/)).toBeTruthy()
  rerender(<QueuePanel state={state} send={send} queue={queue} error={null} now={now + 61_000} />)
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

it('keeps Desk read-only and exposes each source terminal independently', () => {
  const now = Date.now(), queue = fixtureQueue(now), selected = queue.items[0]!
  selected.sources = ['hold', 'decision'].map(kind => ({ kind: 'firstmate' as const, id: JSON.stringify(['/farm/hulk', 'worker']), field: kind,
    request: { home: '/farm/hulk', taskId: 'worker', id: kind === 'hold' ? 'worker' : 'formatter', kind: kind as 'hold' | 'decision' },
    observedAt: new Date(now).toISOString(), expiresAt: null, status: 'fresh' as const, coverage: 'complete' as const }))
  render(<QueuePanel state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
  const inspector = screen.getByLabelText('Request inspector')
  expect(inspector.querySelectorAll('a')).toHaveLength(2)
  for (const link of inspector.querySelectorAll('a')) expect(link.getAttribute('href')).toBe('?worker=worker&home=hulk')
  expect(inspector.textContent).toContain('formatter')
  expect(inspector.textContent).toContain('"id": "worker"')
  expect(screen.queryByRole('button', { name: /Answer|Dismiss|Send to First Mate/i })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('slider')).toBeNull()
})
