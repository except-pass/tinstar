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

  // The concurrent window: only the resolve checkbox is gated on `busy` — the A2UI
  // Submit is not — so a Submit can populate the answer slot AFTER lifecycle cleared
  // it and BEFORE the resolve rejects. Clearing only at the start isn't enough.
  it('a lifecycle failure still wins over an answer error raised mid-flight', async () => {
    const body = {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['s'] },
        { id: 's', component: 'Submit', label: 'Send' },
      ],
    }
    // Hold the resolve POST open until we say so.
    let releaseResolve!: () => void
    const gate = new Promise<void>((r) => { releaseResolve = r })
    apiFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/resolve')) {
        await gate
        return { ok: false, status: 500, json: async () => ({ ok: false }) } as unknown as Response
      }
      return ok()
    })

    render(<OpenPointsSurface runId="run-1" points={[point('p1', { body: body as never })]} />)

    fireEvent.click(screen.getByTestId('resolve-p1'))       // in flight
    fireEvent.click(screen.getByRole('button', { name: 'Send' })) // sets the answer slot
    await waitFor(() => expect(screen.getByText(/pick an option/i)).toBeTruthy())

    releaseResolve()

    // BACK-OUT GUARD: remove `setAnswerError(null)` from lifecycle's catch and this
    // fails — the stale validation message hides the real failure.
    await waitFor(() => expect(screen.getByText(/could not resolve this point/i)).toBeTruthy())
    expect(screen.queryByText(/pick an option/i)).toBeNull()
  })

  // ── The DURABLE answered posture (`durablyAnswered`) ────────────────────────────
  // A row's only answered signal used to be `usePointAnswerForm`'s optimistic lock —
  // plain `useState`, so it died on remount and the user came back to a row with no
  // trace that they'd already settled the question.
  //
  // The signal is VISUAL ONLY, and that boundary is load-bearing. `Reply` carries no
  // discriminator, and the answer route persists an answer as an ordinary user reply —
  // identical in shape to a thread comment. So `durablyAnswered` cannot tell "answered
  // the control" from "left a comment", and it must NEVER reach `form.answered`: doing
  // so would lock the controls on a commented-but-undecided point and render it as
  // decided. Every test below asserts BOTH halves — the marker is on, the controls are
  // still live — because the second half is the one that would regress silently.
  describe('durable answered state', () => {
    /** Choice + Submit — enough to tell "locked" from "still asking". */
    const askBody = {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['c', 's'] },
        {
          id: 'c',
          component: 'Choice',
          mode: 'single',
          options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
        },
        { id: 's', component: 'Submit', label: 'Send' },
      ],
    }

    const userReply = { id: 'r1', author: 'user' as const, text: 'Yes — go with A.', createdAt: 10 }
    const agentReply = { id: 'r2', author: 'agent' as const, text: 'On it.', createdAt: 20 }

    it('an answered point still reads answered across a remount', () => {
      render(
        <OpenPointsSurface
          runId="run-1"
          points={[point('p1', { body: askBody as never, status: 'waiting', thread: [userReply] })]}
        />,
      )
      // Nothing was clicked in this render — the marker comes purely from the thread,
      // which is the whole point: a reload lands here, not on a row with no trace of it.
      const row = screen.getByTestId('point-p1')
      expect(row.getAttribute('data-answered')).toBe('true')
      expect(row.className).toContain('border-hue-resolved/30')
      // …and the controls stay LIVE. The durable signal is visual; only a real submit
      // locks the form.
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
      expect((screen.getByRole('radio', { name: 'Yes' }) as HTMLInputElement).disabled).toBe(false)
      expect(screen.queryByText('✓ Answered')).toBeNull()
    })

    // THE REGRESSION. Status is derived from WHO SPOKE LAST (`derivePointStatus`), so
    // the agent's reply flips `waiting` → `discussing`. The old predicate read status,
    // so the answered marker was erased at exactly the moment the answer was acted on.
    // Back the predicate out to `status === 'waiting' || 'resolved'` and this fails.
    it('stays answered after the agent replies to act on the answer', () => {
      render(
        <OpenPointsSurface
          runId="run-1"
          points={[
            point('p1', {
              body: askBody as never,
              status: 'discussing', // ← the agent spoke last
              thread: [userReply, agentReply],
            }),
          ]}
        />,
      )
      expect(screen.getByTestId('point-p1').getAttribute('data-status')).toBe('discussing')
      expect(screen.getByTestId('point-p1').getAttribute('data-answered')).toBe('true')
      expect(screen.getByTestId('point-p1').className).toContain('border-hue-resolved/30')
    })

    // THE OTHER FAILURE MODE, and the reason the durable signal is visual only: a user
    // who COMMENTS on a decision card without touching its radios has not decided. The
    // row may show it has been engaged with, but the controls must stay live — locking
    // here would claim a decision that was never made.
    it('a user COMMENT does not lock the controls (a comment is not a decision)', () => {
      render(
        <OpenPointsSurface
          runId="run-1"
          points={[
            point('p1', {
              body: askBody as never,
              status: 'waiting',
              thread: [{ id: 'c1', author: 'user', text: 'What about option C?', createdAt: 10 }],
            }),
          ]}
        />,
      )
      // BACK-OUT GUARD: feed `durablyAnswered` into `form.answered` and this fails —
      // the Submit becomes "✓ Answered" on a question the user only asked about.
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
      expect((screen.getByRole('radio', { name: 'Yes' }) as HTMLInputElement).disabled).toBe(false)
      expect(screen.queryByText('✓ Answered')).toBeNull()
    })

    // Monotonic, not just sticky: an agent-only thread is a conversation, not an answer,
    // and must leave the controls live.
    it('an agent-only thread leaves the point unanswered and its controls live', () => {
      render(
        <OpenPointsSurface
          runId="run-1"
          points={[point('p1', { body: askBody as never, status: 'discussing', thread: [agentReply] })]}
        />,
      )
      expect(screen.getByTestId('point-p1').getAttribute('data-answered')).toBeNull()
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
      expect((screen.getByRole('radio', { name: 'Yes' }) as HTMLInputElement).disabled).toBe(false)
    })

    // `resolved` is the explicit terminal, and it survives a thread prune — so it stays
    // a true on its own, with no reply to read.
    it('a resolved point reads answered even with no thread at all', () => {
      render(
        <OpenPointsSurface runId="run-1" points={[point('p1', { body: askBody as never, status: 'resolved' })]} />,
      )
      expect(screen.getByTestId('point-p1').getAttribute('data-answered')).toBe('true')
    })

    it('an untouched open point is not answered', () => {
      render(<OpenPointsSurface runId="run-1" points={[point('p1', { body: askBody as never })]} />)
      const row = screen.getByTestId('point-p1')
      expect(row.getAttribute('data-answered')).toBeNull()
      expect(row.className).toContain('border-hairline')
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    })

    // A real submit still locks — the optimistic path is untouched by all of the above.
    it('submitting for real still locks the controls', async () => {
      render(<OpenPointsSurface runId="run-1" points={[point('p1', { body: askBody as never })]} />)
      fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))

      await waitFor(() => expect(screen.getByText('✓ Answered')).toBeTruthy())
      expect((screen.getByRole('radio', { name: 'Yes' }) as HTMLInputElement).disabled).toBe(true)
    })
  })
  // --- Claim refusals (plan U6, R3) ----------------------------------------
  //
  // Every FILE-AUTHORED surface projects as an `open-point`, so this row is where a
  // refused claim actually has to appear. A refusal rendered only on the card shell
  // in SlatePanel would be unreachable for the surfaces that can produce one.
  describe('a claim the host would not accept', () => {
    const REFUSAL = 'claim "u1" (witness unit-lands): no such witness kind — this host implements unit-landed, http-status'

    it('shows the refusal, naming the kind, beside the point\'s NEW content', () => {
      render(
        <OpenPointsSurface
          runId="run-1"
          points={[point('p1', {
            headline: 'Roadmap — 3 of 8 landed',
            freshness: { phase: 'current', overdue: false, claimRefusals: [REFUSAL] },
          })]}
        />,
      )
      const note = screen.getByTestId('claim-refusals-p1')
      expect(note.textContent).toContain('unit-lands')
      expect(note.textContent).toMatch(/claim not accepted/i)
      // KTD5: the claim is dropped, never the surface — so the newest headline is
      // on screen, not the one from before the author's mistake.
      expect(screen.getByText('Roadmap — 3 of 8 landed')).toBeTruthy()
    })

    it('counts them when more than one was refused', () => {
      render(
        <OpenPointsSurface
          runId="run-1"
          points={[point('p1', { freshness: { phase: 'current', overdue: false, claimRefusals: [REFUSAL, 'claim "u2": params.plan must be a `docs/plans/<file>.md` path'] } })]}
        />,
      )
      expect(screen.getByTestId('claim-refusals-p1').textContent).toMatch(/2 claims not accepted/i)
    })

    it('renders nothing for a surface with no refusals, and nothing on its siblings', () => {
      render(
        <OpenPointsSurface
          runId="run-1"
          points={[
            point('bad', { freshness: { phase: 'current', overdue: false, claimRefusals: [REFUSAL] } }),
            point('good', { freshness: { phase: 'current', overdue: false } }),
            point('silent'),
          ]}
        />,
      )
      expect(screen.getByTestId('claim-refusals-bad')).toBeTruthy()
      expect(screen.queryByTestId('claim-refusals-good')).toBeNull()
      expect(screen.queryByTestId('claim-refusals-silent')).toBeNull()
    })
  })
})
