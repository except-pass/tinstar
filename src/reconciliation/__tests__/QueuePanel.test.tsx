import { usePresentation } from '../usePresentation'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { fixtureQueue, fixtureScene, fixtureViewerWorkers } from '../../../test-fixtures/reconciliation/scenes'
import { initialPresentation } from '../presentation'
import { QueuePanel } from '../QueuePanel'
afterEach(cleanup)
it('omits operational queue summaries and updates readiness when selected evidence expires', () => {
  const now = Date.now(), queue = fixtureQueue(now), send = vi.fn()
  const state = { ...initialPresentation(), queueItemId: queue.items.find(item => item.readiness === 'ready-now')!.id }
  const { rerender } = render(<QueuePanel messages={[]} submit={vi.fn()} workers={[]} state={state} send={send} queue={queue} error={null} now={now} />)
  expect(screen.queryByText('No verified request ready')).toBeNull()
  expect(screen.queryByText(/Later & needs verification/)).toBeNull()
  rerender(<QueuePanel messages={[]} submit={vi.fn()} workers={[]} state={state} send={send} queue={queue} error={null} now={now + 61_000} />)
  expect(screen.getByText('Needs verification', { selector: '.ov-eyebrow' })).toBeTruthy()
  expect(send).not.toHaveBeenCalled()
})

it('retains a disappeared selection while offering the remaining ready request', () => {
  const now = Date.now(), queue = fixtureQueue(now), send = vi.fn()
  const ready = queue.items.filter(item => item.readiness === 'ready-now')
  const state = { ...initialPresentation(), queueItemId: ready[0]!.id }
  const { rerender } = render(<QueuePanel messages={[]} submit={vi.fn()} workers={[]} state={state} send={send} queue={queue} error={null} now={now} />)
  rerender(<QueuePanel messages={[]} submit={vi.fn()} workers={[]} state={state} send={send} queue={{ ...queue, items: queue.items.filter(item => item.id !== state.queueItemId) }} error={null} now={now} />)
  expect(screen.getByText('Selected request unavailable')).toBeTruthy()
  expect(screen.queryByText('No verified request ready')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(ready[1]!.title) }))
  expect(send).toHaveBeenCalledWith({ type: 'navigate-card', cardId: ready[1]!.cardIds[0] })
  expect(state.queueItemId).toBe(ready[0]!.id)
})

it('keeps Desk read-only and exposes each source terminal independently', () => {
  const now = Date.now(), queue = fixtureQueue(now), selected = queue.items[0]!
  selected.sources = ['hold', 'decision'].map(kind => ({ kind: 'firstmate' as const, id: JSON.stringify(['/farm/hulk', 'worker']), field: kind,
    request: { home: '/farm/hulk', taskId: 'worker', id: kind === 'hold' ? 'worker' : 'formatter', kind: kind as 'hold' | 'decision' },
    observedAt: new Date(now).toISOString(), expiresAt: null, status: 'fresh' as const, coverage: 'complete' as const }))
  const workers = [{ ...fixtureViewerWorkers()[0]!, id: 'worker', home: '/farm/hulk' }]
  render(<QueuePanel messages={[]} submit={vi.fn()} workers={workers} state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
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
  const { rerender } = render(<QueuePanel messages={[]} submit={vi.fn()} workers={workers} state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
  const sources = screen.getByLabelText('Request inspector').querySelectorAll(':scope > details')
  expect(sources[0]!.querySelector('a')?.getAttribute('href')).toBe('?worker=worker&home=fm-home')
  expect(sources[1]!.querySelector('a')).toBeNull()
  expect(sources[1]!.textContent).toContain('Source terminal unavailable')
  rerender(<QueuePanel messages={[]} submit={vi.fn()} workers={[workers[1]!]} state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
  const updated = screen.getByLabelText('Request inspector').querySelectorAll(':scope > details')
  expect(updated[0]!.querySelector('a')).toBeNull()
  expect(updated[1]!.querySelector('a')?.getAttribute('href')).toBe('?worker=worker&home=fm-home')
})

it('answers only the explicitly ready source, retaining its terminal and receipt route', async () => {
  const { requestAnchor } = await import('../../shared/deskSource')
  const now = Date.now(), queue = fixtureQueue(now), selected = queue.items[0]!
  const request = { home: '/farm/hulk', taskId: 'worker', id: 'choose', kind: 'decision' as const }
  const anchor = requestAnchor(request)
  selected.sources = [
    { kind: 'firstmate', id: anchor, field: 'hints.open_decisions', request, responseAnchor: anchor, readiness: 'ready-now', action: 'Choose the rollout order', status: 'fresh', coverage: 'complete', observedAt: null, expiresAt: null },
    { kind: 'firstmate', id: 'unrelated', field: 'hints.open_decisions', request: { ...request, taskId: 'other' }, readiness: 'needs-readiness-verification', status: 'fresh', coverage: 'complete', observedAt: null, expiresAt: null },
  ]
  const submit = vi.fn().mockResolvedValue({ saved: true, error: null, canReceive: true })
  const workers = [{ ...fixtureViewerWorkers()[0]!, id: 'worker', home: '/farm/hulk' }]
  render(<QueuePanel messages={[]} submit={submit} workers={workers} state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
  const inspector = screen.getByLabelText('Request inspector')
  const details = inspector.querySelectorAll(':scope > details')
  fireEvent.click(details[0]!.querySelector('summary')!)
  fireEvent.click(screen.getByText('Answer', { selector: 'summary' }))
  expect(inspector.querySelectorAll('textarea')).toHaveLength(1)
  expect(details[1]!.textContent).not.toContain('Answer')
  expect(screen.getByRole('link', { name: /Open source terminal/ }).getAttribute('href')).toBe('?worker=worker&home=hulk')
  fireEvent.change(screen.getByLabelText('Answer this decision'), { target: { value: 'Choose A' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send to First Mate' }))
  expect(await screen.findByText('Answer saved. See Receipts for delivery.')).toBeTruthy()
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ anchorKey: anchor, kind: 'answer', text: 'Choose A' }))
})

it('dismisses exactly the chosen source through the existing close endpoint', async () => {
  const { requestAnchor } = await import('../../shared/deskSource')
  const now = Date.now(), queue = fixtureQueue(now), selected = queue.items[0]!
  const request = { home: '/farm/hulk', taskId: 'worker', id: 'choose', kind: 'hold' as const }
  const anchor = requestAnchor(request)
  selected.sources = [{ kind: 'firstmate', id: anchor, field: 'backlog.hold', request, responseAnchor: anchor, readiness: 'ready-now', status: 'fresh', coverage: 'complete', observedAt: null, expiresAt: null }]
  const fetcher = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, data: { dismissed: true } }) })
  vi.stubGlobal('fetch', fetcher)
  try {
    render(<QueuePanel messages={[]} submit={vi.fn()} workers={[]} state={{ ...initialPresentation(), queueItemId: selected.id }} send={vi.fn()} queue={queue} error={null} now={now} />)
    fireEvent.click(screen.getByText('First Mate hold · 1'))
    const slider = screen.getByRole('slider')
    Object.defineProperty(slider, 'clientWidth', { value: 200 })
    Object.defineProperty(slider.querySelector('.cockpit-slide-knob'), 'offsetWidth', { value: 40 })
    for (let i = 0; i < 6; i++) fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(await screen.findByText('Request dismissed.')).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/api/fleet/dismiss', expect.objectContaining({ method: 'POST', body: JSON.stringify({ key: anchor }) }))
  } finally { vi.unstubAllGlobals() }
})

it('retains a saved answer after returning to its source without hiding another source action', async () => {
  const { requestAnchor } = await import('../../shared/deskSource')
  const now = Date.now(), queue = fixtureQueue(now), selected = queue.items[0]!
  const requests = ['alpha', 'beta'].map(taskId => ({ home: '/farm/hulk', taskId, id: 'choose', kind: 'decision' as const }))
  selected.sources = requests.map(request => ({ kind: 'firstmate', id: requestAnchor(request), field: 'hints.open_decisions', request, responseAnchor: requestAnchor(request), readiness: 'ready-now', status: 'fresh', coverage: 'complete', observedAt: null, expiresAt: null }))
  const messages = [{ requestId: 'saved', sourceAnchor: requestAnchor(requests[0]!), home: '/farm/hulk', taskId: 'alpha', decisionKey: 'choose', kind: 'answer' as const, text: 'A', state: 'saved' as const, announced: true, reply: null, canReceive: true }]
  const state = { ...initialPresentation(), queueItemId: selected.id }
  const { unmount } = render(<QueuePanel messages={messages} submit={vi.fn()} workers={[]} state={state} send={vi.fn()} queue={queue} error={null} now={now} />)
  unmount()
  render(<QueuePanel messages={messages} submit={vi.fn()} workers={[]} state={state} send={vi.fn()} queue={queue} error={null} now={now} />)
  expect(screen.getByText('Answer saved. See Receipts for delivery.')).toBeTruthy()
  expect(screen.getByText('Answer', { selector: 'summary' })).toBeTruthy()
  expect(screen.getByLabelText('Request inspector').querySelectorAll('textarea')).toHaveLength(1)
})

it('reconciles selected source membership for rendering and subsequent navigation', () => {
  const queue = fixtureQueue(), scene = fixtureScene(), selected = queue.items[0]!
  selected.identities = ['desk-source:exact-source']
  const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetcher)
  try {
    const { result, rerender, unmount } = renderHook(({ queue }) => usePresentation(scene, queue), { initialProps: { queue } })
    act(() => { result.current.send({ type: 'open-queue', itemId: selected.id }) })
    const joined = { ...queue, items: queue.items.map(item => item === selected ? { ...item, id: 'pr:canonical', identities: [...selected.identities!, 'pr:canonical'] } : item) }
    rerender({ queue: joined })
    expect(result.current.state.queueItemId).toBe('pr:canonical')
    rerender({ queue })
    expect(result.current.state.queueItemId).toBe(selected.id)
    act(() => { result.current.send({ type: 'navigate-queue', direction: 'next' }) })
    expect(result.current.state.queueItemId).not.toBe('pr:canonical')
    unmount()
  } finally { vi.unstubAllGlobals() }
})
