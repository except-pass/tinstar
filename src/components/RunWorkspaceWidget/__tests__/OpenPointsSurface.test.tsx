// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

  // ── S4: the multi-question workbench ────────────────────────────────────
  // A grouped set is pulled OUT of the vertical list and into a horizontal band.
  // The trap this guards: a grouped point rendering in BOTH places would give the
  // user two live answer affordances for the same question.
  it('pulls a grouped set into a workbench and out of the row list', () => {
    render(
      <OpenPointsSurface
        runId="run-1"
        points={[
          point('r1'),
          point('g1', { group: 'launch-qs' }),
          point('g2', { group: 'launch-qs' }),
        ]}
      />,
    )

    expect(screen.getByTestId('workbench-launch-qs')).toBeTruthy()
    expect(screen.getByTestId('workbench-column-g1')).toBeTruthy()
    expect(screen.getByTestId('workbench-column-g2')).toBeTruthy()
    // Grouped points are NOT also rows; the ungrouped one still is.
    expect(screen.queryByTestId('point-g1')).toBeNull()
    expect(screen.queryByTestId('point-g2')).toBeNull()
    expect(screen.getByTestId('point-r1')).toBeTruthy()
  })

  it('renders no workbench when nothing is grouped (backward compatible)', () => {
    render(<OpenPointsSurface runId="run-1" points={[point('p1'), point('p2')]} />)
    expect(document.querySelector('[data-testid^="workbench-"]')).toBeNull()
    expect(screen.getByTestId('point-p1')).toBeTruthy()
    expect(screen.getByTestId('point-p2')).toBeTruthy()
  })

  // S6's reorder chevrons permute the ROWS. A chevron whose index math counted a
  // workbenched point would step "up" past something invisible and look like a dead
  // click, so the reorder payload must name only the rows.
  it('reorder chevrons ignore workbenched points', async () => {
    render(
      <OpenPointsSurface
        runId="run-1"
        points={[
          point('r1'),
          point('g1', { group: 'set' }),
          point('g2', { group: 'set' }),
          point('r2'),
        ]}
      />,
    )

    fireEvent.click(screen.getByTestId('reorder-down-r1'))

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const call = apiFetch.mock.calls.find(([url]) => String(url).endsWith('/points/order'))!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ order: ['r2', 'r1'] })
  })

  // A column renders none of the row's hide chrome. Revealing a hidden point INTO a
  // band would therefore strand it — the "N hidden · show" toggle would surface
  // something it could not restore. So a hidden point always stays a row.
  it('a revealed hidden point stays a row (with its unhide) instead of joining the band', () => {
    const onUnhide = vi.fn()
    render(
      <OpenPointsSurface
        runId="run-1"
        points={[
          point('g1', { group: 'set' }),
          point('g2', { group: 'set' }),
          point('g3', { group: 'set' }),
        ]}
        hiddenIds={new Set(['g2'])}
        showHidden
        onUnhide={onUnhide}
      />,
    )

    // g1 + g3 still form the band; g2 is a row and keeps its way back.
    expect(screen.getByTestId('workbench-column-g1')).toBeTruthy()
    expect(screen.getByTestId('workbench-column-g3')).toBeTruthy()
    expect(screen.queryByTestId('workbench-column-g2')).toBeNull()
    expect(screen.getByTestId('point-g2')).toBeTruthy()
    fireEvent.click(screen.getByTestId('unhide-surface-g2'))
    expect(onUnhide).toHaveBeenCalledWith('g2')
  })

  // The S4 U2 extraction split one `error` slot into two (lifecycle + answer form).
  // They must still behave like ONE slot: the last failure is the one shown, or a
  // failed resolve silently hides behind a stale validation message and reads as a
  // click that did nothing.
  it('a lifecycle failure is visible even after a stale answer-validation error', async () => {
    const body = {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['s'] },
        { id: 's', component: 'Submit', label: 'Send' },
      ],
    }
    render(
      <OpenPointsSurface runId="run-1" points={[point('p1', { body: body as never })]} />,
    )

    // 1. Submit with nothing picked → the answer slot holds a validation message.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByText(/pick an option/i)).toBeTruthy())

    // 2. Now a resolve that fails. Its message must REPLACE the stale one.
    apiFetch.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false }) } as unknown as Response),
    )
    fireEvent.click(screen.getByTestId('resolve-p1'))

    await waitFor(() => expect(screen.getByText(/could not resolve this point/i)).toBeTruthy())
    expect(screen.queryByText(/pick an option/i)).toBeNull()
  })
})
