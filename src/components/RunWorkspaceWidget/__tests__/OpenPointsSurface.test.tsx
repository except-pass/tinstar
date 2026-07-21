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
})
