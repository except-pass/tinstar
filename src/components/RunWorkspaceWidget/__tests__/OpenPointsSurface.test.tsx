// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { SlateSurface } from '../../../types'

// apiFetch is the single HTTP seam (never bare fetch — it 404s in Tauri). Mock it
// so we can assert the endpoints hit and drive the optimistic paths deterministically.
const apiFetch = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => p,
}))

import { OpenPointsSurface } from '../OpenPointsSurface'

/** A resolved apiFetch response with a JSON envelope, matching the server shape. */
function ok(data: Record<string, unknown> = { point: {}, delivered: true }) {
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, data }) } as unknown as Response)
}

function point(id: string, extra: Partial<SlateSurface> = {}): SlateSurface {
  return {
    id,
    author: 'agent',
    kind: 'open-point',
    headline: `point ${id}`,
    status: 'open',
    createdAt: 1,
    amendedAt: 1,
    ...extra,
  }
}

describe('OpenPointsSurface (U6)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => ok())
  })

  it('renders a point with its derived state on the track', () => {
    render(<OpenPointsSurface runId="run-1" points={[point('p1', { status: 'waiting' })]} />)
    const track = screen.getByTestId('track-p1')
    // waiting is stage 2 on open(0) → discuss(1) → waiting(2) → resolved(3).
    expect(track.getAttribute('data-stage')).toBe('2')
    expect(screen.getByTestId('pill-p1').textContent).toMatch(/waiting/i)
  })

  it('resolving a point flips it and the track goes terminal', async () => {
    render(<OpenPointsSurface runId="run-1" points={[point('p1', { status: 'open' })]} />)
    expect(screen.getByTestId('track-p1').getAttribute('data-stage')).toBe('0')

    fireEvent.click(screen.getByTestId('resolve-p1'))

    // Optimistic: the track flips to the terminal (resolved) stage at once.
    await waitFor(() =>
      expect(screen.getByTestId('track-p1').getAttribute('data-stage')).toBe('3'),
    )
    expect(screen.getByTestId('pill-p1').textContent).toMatch(/resolved/i)
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/runs/run-1/slate/points/p1/resolve',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('adds a point — POSTs to /points and clears the input on success', async () => {
    render(<OpenPointsSurface runId="run-1" points={[point('p1')]} />)
    const input = screen.getByTestId('add-point-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'pick a database' } })
    fireEvent.click(screen.getByTestId('add-point-send'))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/points',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    // The posted body carries the headline.
    const [, init] = apiFetch.mock.calls.find((c) => c[0] === '/api/runs/run-1/slate/points')!
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ headline: 'pick a database' })
    // Cleared after the successful round trip (reconciles via the SSE run delta).
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('renders a thread and posts a reply optimistically', async () => {
    render(
      <OpenPointsSurface
        runId="run-1"
        points={[
          point('p1', { thread: [{ id: 'r1', author: 'agent', text: 'what name?', createdAt: 1 }] }),
        ]}
      />,
    )
    // The thread is collapsed by default — expand it.
    fireEvent.click(screen.getByTestId('thread-toggle-p1'))
    expect(screen.getByText('what name?')).toBeTruthy()

    const reply = screen.getByTestId('reply-input-p1') as HTMLInputElement
    fireEvent.change(reply, { target: { value: 'call it Slate' } })
    fireEvent.click(screen.getByTestId('reply-send-p1'))

    // Optimistic: the reply is on the thread the instant it's sent.
    expect(screen.getByText('call it Slate')).toBeTruthy()
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/points/p1/replies',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const [, init] = apiFetch.mock.calls.find(
      (c) => c[0] === '/api/runs/run-1/slate/points/p1/replies',
    )!
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      text: 'call it Slate',
      author: 'user',
    })
  })

  // Slate v2 U2/R4 — an open point is a surface; hiding is a per-browser view
  // preference driven from the parent (SlatePanel owns the persisted set).
  it('a point row carries a ✕ hide control that reports its id', () => {
    const onHide = vi.fn()
    render(<OpenPointsSurface runId="run-1" points={[point('p1')]} onHide={onHide} />)
    fireEvent.click(screen.getByTestId('hide-surface-p1'))
    expect(onHide).toHaveBeenCalledWith('p1')
  })

  // Slate v2 U3 — refresh state is owned by the parent SlatePanel and threaded down;
  // a point row's ⟳ reports its surface up so the parent hook drives the POST.
  it('a point row carries a ⟳ refresh control that reports its surface', () => {
    const onRefresh = vi.fn()
    render(<OpenPointsSurface runId="run-1" points={[point('p1')]} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('refresh-surface-p1'))
    expect(onRefresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
  })

  it('shows the spinner for a refreshing point and a note for an unreachable one', () => {
    render(
      <OpenPointsSurface
        runId="run-1"
        points={[point('p1')]}
        onRefresh={vi.fn()}
        refreshingIds={new Set(['p1'])}
        unreachableIds={new Set(['p1'])}
      />,
    )
    expect(screen.getByTestId('refresh-surface-p1').getAttribute('data-refreshing')).toBe('true')
    expect(screen.getByTestId('refresh-unreachable-p1')).toBeTruthy()
  })

  it('gives a refreshing row the same slow cyan pulse as a refreshing card (U4)', () => {
    const { rerender } = render(
      <OpenPointsSurface runId="run-1" points={[point('p1')]} onRefresh={vi.fn()} />,
    )
    expect(screen.getByTestId('point-p1').className).not.toContain('slate-surface-refreshing')

    rerender(
      <OpenPointsSurface
        runId="run-1"
        points={[point('p1')]}
        onRefresh={vi.fn()}
        refreshingIds={new Set(['p1'])}
      />,
    )
    const row = screen.getByTestId('point-p1')
    expect(row.className).toContain('slate-surface-refreshing')
    expect(row.getAttribute('data-refreshing')).toBe('true')
  })

  it('nudges a point up, optimistically and via the order PUT (S6 U2)', async () => {
    const points = [point('p1'), point('p2'), point('p3')]
    render(<OpenPointsSurface runId="run-1" points={points} />)
    const idsInDom = () =>
      Array.from(document.querySelectorAll('[data-testid^="point-"]')).map((el) =>
        el.getAttribute('data-testid'),
      )
    expect(idsInDom()).toEqual(['point-p1', 'point-p2', 'point-p3'])

    fireEvent.click(screen.getByTestId('reorder-up-p3'))

    // Optimistic: the row moves at once, before any round trip.
    expect(idsInDom()).toEqual(['point-p1', 'point-p3', 'point-p2'])
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/points/order',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ order: ['p1', 'p3', 'p2'] }) }),
      ),
    )
  })

  it('disables the chevrons at the ends and omits the grip for a lone point', () => {
    const { rerender } = render(
      <OpenPointsSurface runId="run-1" points={[point('p1'), point('p2')]} />,
    )
    expect((screen.getByTestId('reorder-up-p1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('reorder-down-p1') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('reorder-down-p2') as HTMLButtonElement).disabled).toBe(true)

    // One point → nothing to permute, so no grip at all.
    rerender(<OpenPointsSurface runId="run-1" points={[point('p1')]} />)
    expect(screen.queryByTestId('reorder-grip-p1')).toBeNull()
  })

  it('does not offer a grip on a resolved point (it sinks by rank instead)', () => {
    render(
      <OpenPointsSurface
        runId="run-1"
        points={[point('p1'), point('p2'), point('done', { status: 'resolved' })]}
      />,
    )
    expect(screen.getByTestId('reorder-grip-p1')).toBeTruthy()
    expect(screen.queryByTestId('reorder-grip-done')).toBeNull()
  })

  it('reverts the optimistic order when the PUT fails', async () => {
    apiFetch.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: { message: 'nope' } }) } as unknown as Response),
    )
    render(<OpenPointsSurface runId="run-1" points={[point('p1'), point('p2')]} />)
    const idsInDom = () =>
      Array.from(document.querySelectorAll('[data-testid^="point-"]')).map((el) =>
        el.getAttribute('data-testid'),
      )

    fireEvent.click(screen.getByTestId('reorder-down-p1'))
    expect(idsInDom()).toEqual(['point-p2', 'point-p1'])

    // The failure puts the list back exactly where it was, and says so.
    await waitFor(() => expect(idsInDom()).toEqual(['point-p1', 'point-p2']))
    expect(screen.getByText('Could not save the new order.')).toBeTruthy()
  })

  it('drops the optimistic order once the run delta carries the same sequence', async () => {
    const points = [point('p1'), point('p2')]
    const { rerender } = render(<OpenPointsSurface runId="run-1" points={points} />)
    const idsInDom = () =>
      Array.from(document.querySelectorAll('[data-testid^="point-"]')).map((el) =>
        el.getAttribute('data-testid'),
      )

    fireEvent.click(screen.getByTestId('reorder-down-p1'))
    expect(idsInDom()).toEqual(['point-p2', 'point-p1'])

    // The SSE run delta arrives carrying the server's order. The optimistic override
    // is dropped; the projection drives from here.
    rerender(<OpenPointsSurface runId="run-1" points={[point('p2'), point('p1')]} />)
    await waitFor(() => expect(idsInDom()).toEqual(['point-p2', 'point-p1']))

    // Proof the override really let go: a LATER delta reordering them back is honored
    // instead of being fought by a stuck optimistic list.
    rerender(<OpenPointsSurface runId="run-1" points={[point('p1'), point('p2')]} />)
    await waitFor(() => expect(idsInDom()).toEqual(['point-p1', 'point-p2']))
  })

  it('drops the override when one of its points is RETRACTED, instead of sticking', async () => {
    // The exact-sequence reconcile can never match again once an id leaves the
    // projection, so without a second exit the override outlives the thing it was
    // reconciling and masks the server's order for the rest of the panel's life.
    const { rerender } = render(
      <OpenPointsSurface runId="run-1" points={[point('p1'), point('p2'), point('p3')]} />,
    )
    const idsInDom = () =>
      Array.from(document.querySelectorAll('[data-testid^="point-"]')).map((el) =>
        el.getAttribute('data-testid'),
      )

    fireEvent.click(screen.getByTestId('reorder-up-p3'))
    expect(idsInDom()).toEqual(['point-p1', 'point-p3', 'point-p2'])

    // A file re-projection retracts p3 entirely.
    rerender(<OpenPointsSurface runId="run-1" points={[point('p1'), point('p2')]} />)
    await waitFor(() => expect(idsInDom()).toEqual(['point-p1', 'point-p2']))

    // …and the projection drives again: a later delta is honored, not fought.
    rerender(<OpenPointsSurface runId="run-1" points={[point('p2'), point('p1')]} />)
    await waitFor(() => expect(idsInDom()).toEqual(['point-p2', 'point-p1']))
  })

  it('clears a stale reorder error once the panel is back in sync', async () => {
    apiFetch.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false }) } as unknown as Response),
    )
    const { rerender } = render(
      <OpenPointsSurface runId="run-1" points={[point('p1'), point('p2')]} />,
    )
    fireEvent.click(screen.getByTestId('reorder-down-p1'))
    await waitFor(() => expect(screen.getByText('Could not save the new order.')).toBeTruthy())

    // A later successful move settles on the delta — the old red line is stale by
    // definition and must not sit under the list forever with no dismiss.
    apiFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as unknown as Response),
    )
    fireEvent.click(screen.getByTestId('reorder-down-p1'))
    rerender(<OpenPointsSurface runId="run-1" points={[point('p2'), point('p1')]} />)
    await waitFor(() => expect(screen.queryByText('Could not save the new order.')).toBeNull())
  })

  it('serializes concurrent reorder PUTs so the server cannot settle out of order', async () => {
    // Nudging a point two slots is two clicks in quick succession. Fired in parallel,
    // two PUTs have no ordering guarantee — the server can apply the second first and
    // settle on an intermediate sequence the client never asked for.
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let calls = 0
    apiFetch.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { order: string[] }
      // Hold the FIRST request open. A parallel implementation would issue the
      // second one anyway; a serialized one cannot.
      const wait = calls++ === 0 ? gate : Promise.resolve()
      return wait.then(() => {
        seen.push(body.order.join(','))
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response
      })
    })

    render(<OpenPointsSurface runId="run-1" points={[point('p1'), point('p2'), point('p3')]} />)
    fireEvent.click(screen.getByTestId('reorder-up-p3'))
    fireEvent.click(screen.getByTestId('reorder-up-p3'))

    // With the first PUT held open, the second must not have been issued at all.
    await act(async () => { await Promise.resolve() })
    expect(calls).toBe(1)
    expect(seen).toEqual([])

    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(seen).toHaveLength(2))
    // Applied in click order — the cumulative sequence lands last.
    expect(seen).toEqual(['p1,p3,p2', 'p3,p1,p2'])
  })

  it('filters a hidden point unless the reveal toggle is on', () => {
    const points = [point('p1'), point('p2')]
    const { rerender } = render(
      <OpenPointsSurface runId="run-1" points={points} hiddenIds={new Set(['p1'])} showHidden={false} />,
    )
    expect(screen.queryByTestId('point-p1')).toBeNull()
    expect(screen.getByTestId('point-p2')).toBeTruthy()

    // Revealed → the hidden row returns with an "unhide" affordance.
    const onUnhide = vi.fn()
    rerender(
      <OpenPointsSurface
        runId="run-1"
        points={points}
        hiddenIds={new Set(['p1'])}
        showHidden
        onUnhide={onUnhide}
      />,
    )
    expect(screen.getByTestId('point-p1')).toBeTruthy()
    fireEvent.click(screen.getByTestId('unhide-surface-p1'))
    expect(onUnhide).toHaveBeenCalledWith('p1')
  })
})
