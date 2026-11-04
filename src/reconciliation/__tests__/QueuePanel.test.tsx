import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fixtureQueue, fixtureViewerWorkers } from '../../../test-fixtures/reconciliation/scenes'
import { initialPresentation } from '../presentation'
import { QueuePanel } from '../QueuePanel'
afterEach(cleanup)
it('keeps unverified requests secondary and updates readiness when selected evidence expires', () => {
  const now = Date.now(), queue = fixtureQueue(now), send = vi.fn()
  const state = { ...initialPresentation(), queueItemId: queue.items.find(item => item.readiness === 'ready-now')!.id }
  const { rerender } = render(<QueuePanel workers={[]} state={state} send={send} queue={queue} error={null} now={now} />)
  expect(screen.queryByText('No verified request ready')).toBeNull()
  expect(screen.getByText(/Later & needs verification/)).toBeTruthy()
  rerender(<QueuePanel workers={[]} state={state} send={send} queue={queue} error={null} now={now + 61_000} />)
  expect(screen.getByText('Needs verification', { selector: '.ov-eyebrow' })).toBeTruthy()
  expect(send).not.toHaveBeenCalled()
})

it('retains a disappeared selection while offering the remaining ready request', () => {
  const now = Date.now(), queue = fixtureQueue(now), send = vi.fn()
  const ready = queue.items.filter(item => item.readiness === 'ready-now')
  const state = { ...initialPresentation(), queueItemId: ready[0]!.id }
  const { rerender } = render(<QueuePanel workers={[]} state={state} send={send} queue={queue} error={null} now={now} />)
  rerender(<QueuePanel workers={[]} state={state} send={send} queue={{ ...queue, items: queue.items.filter(item => item.id !== state.queueItemId) }} error={null} now={now} />)
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
  const workers = [{ ...fixtureViewerWorkers()[0]!, id: 'worker', home: '/farm/hulk' }]
  render(<QueuePanel workers={workers} state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
  const inspector = screen.getByLabelText('Request inspector')
  expect(inspector.querySelectorAll('a')).toHaveLength(2)
  for (const link of inspector.querySelectorAll('a')) expect(link.getAttribute('href')).toBe('?worker=worker&home=hulk')
  expect(inspector.textContent).toContain('formatter')
  expect(inspector.textContent).toContain('"id": "worker"')
  expect(screen.queryByRole('button', { name: /Answer|Dismiss|Send to First Mate/i })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('slider')).toBeNull()
})

it('withholds a source link when colliding home basenames resolve to another worker', () => {
  const queue = fixtureQueue(), selected = queue.items[0]!, now = Date.now()
  const workers = ['/farm/a/fm-home', '/farm/b/fm-home'].map((home, index) => ({ ...fixtureViewerWorkers()[0]!, home, id: 'worker', key: `worker-${index}` }))
  selected.sources = workers.map(worker => ({ kind: 'firstmate' as const, id: JSON.stringify([worker.home, worker.id]), field: 'decision',
    request: { home: worker.home, taskId: worker.id, id: 'choice', kind: 'decision' as const },
    observedAt: new Date(now).toISOString(), expiresAt: null, status: 'fresh' as const, coverage: 'complete' as const }))
  const { rerender } = render(<QueuePanel workers={workers} state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
  const sources = screen.getByLabelText('Request inspector').querySelectorAll('details')
  expect(sources[0]!.querySelector('a')?.getAttribute('href')).toBe('?worker=worker&home=fm-home')
  expect(sources[1]!.querySelector('a')).toBeNull()
  expect(sources[1]!.textContent).toContain('Source terminal unavailable')
  rerender(<QueuePanel workers={[workers[1]!]} state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
  const updated = screen.getByLabelText('Request inspector').querySelectorAll('details')
  expect(updated[0]!.querySelector('a')).toBeNull()
  expect(updated[1]!.querySelector('a')?.getAttribute('href')).toBe('?worker=worker&home=fm-home')
})
