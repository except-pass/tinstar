// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { SlateSurface } from '../../../types'

// apiFetch is the single HTTP seam (never bare fetch — it 404s in Tauri). Mocking it
// is also how the load-bearing rule below is TESTED: typing must produce zero calls.
const apiFetch = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => p,
}))

import { ObjectiveSurface } from '../ObjectiveSurface'

function okApply(over: { delivered?: boolean; changed?: boolean } = {}) {
  return Promise.resolve({
    ok: true,
    json: async () => ({ ok: true, data: { delivered: true, changed: true, ...over } }),
  } as unknown as Response)
}

function objective(headline: string): SlateSurface {
  return {
    id: 'objective',
    author: 'user',
    kind: 'objective',
    order: -1,
    headline,
    createdAt: 1,
    amendedAt: 1,
  }
}

describe('ObjectiveSurface (S2)', () => {
  beforeEach(() => {
    cleanup()
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okApply())
  })

  it('renders the objective prose in font-sans (the run card defaults to mono)', () => {
    render(<ObjectiveSurface runId="run-1" surface={objective('Ship the objective surface')} />)
    const el = screen.getByTestId('objective-text')
    expect(el.textContent).toBe('Ship the objective surface')
    expect(el.className).toContain('font-sans')
  })

  it('collapses to a single "set an objective" affordance when the run has none', () => {
    render(<ObjectiveSurface runId="run-1" />)
    expect(screen.queryByTestId('objective-surface')).toBeNull()
    fireEvent.click(screen.getByTestId('objective-set'))
    expect(screen.getByTestId('objective-input')).toBeTruthy()
  })

  // THE RULE: typing is purely local. No debounce, no blur-save, no keystroke-save —
  // nothing reaches the agent until Apply. This test is the guard on that ruling.
  it('TYPING NEVER CALLS THE SERVER — only Apply does', async () => {
    render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))

    const input = screen.getByTestId('objective-input')
    fireEvent.change(input, { target: { value: 'new goal, still typing' } })
    fireEvent.change(input, { target: { value: 'new goal, still typing…' } })
    fireEvent.blur(input)
    // Blur, several keystrokes, and a tick later: still nothing.
    await new Promise(r => setTimeout(r, 50))
    expect(apiFetch).not.toHaveBeenCalled()

    // The unapplied marker is the visible half of the same promise.
    expect(screen.getByTestId('objective-dirty')).toBeTruthy()

    fireEvent.click(screen.getByTestId('objective-apply'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
  })

  it('Apply PUTs the typed text and leaves edit mode', async () => {
    render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: '  a sharper goal  ' } })
    fireEvent.click(screen.getByTestId('objective-apply'))

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const [path, init] = apiFetch.mock.calls[0]!
    expect(path).toBe('/api/runs/run-1/slate/objective')
    expect((init as RequestInit).method).toBe('PUT')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: 'a sharper goal' })
    await waitFor(() => expect(screen.queryByTestId('objective-input')).toBeNull())
  })

  it('Cancel throws the draft away without calling the server', async () => {
    render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'never mind' } })
    fireEvent.click(screen.getByTestId('objective-cancel'))

    expect(apiFetch).not.toHaveBeenCalled()
    expect(screen.getByTestId('objective-text').textContent).toBe('old goal')
  })

  it('Clear issues a DELETE', async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { cleared: true } }) } as unknown as Response))
    render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.click(screen.getByTestId('objective-clear'))

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/api/runs/run-1/slate/objective',
      expect.objectContaining({ method: 'DELETE' }),
    ))
  })

  it('an unreachable run is a quiet note, not an error', async () => {
    apiFetch.mockImplementation(() => okApply({ delivered: false, changed: true }))
    render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'a new goal' } })
    fireEvent.click(screen.getByTestId('objective-apply'))

    await waitFor(() => expect(screen.getByTestId('objective-unreachable')).toBeTruthy())
    expect(screen.queryByTestId('objective-error')).toBeNull()
  })

  // The note is a snapshot of ONE Apply. Nothing re-checks reachability, so it must not
  // sit on the card forever — through the session coming back, which is exactly the
  // event that makes it false.
  it('the unreachable note SURVIVES the projection echo of its own Apply', async () => {
    apiFetch.mockImplementation(() => okApply({ delivered: false, changed: true }))
    const { rerender } = render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'a new goal' } })
    fireEvent.click(screen.getByTestId('objective-apply'))
    await waitFor(() => expect(screen.getByTestId('objective-unreachable')).toBeTruthy())

    // The server's own SSE echo of this Apply must not erase the note it just earned.
    rerender(<ObjectiveSurface runId="run-1" surface={objective('a new goal')} />)
    expect(screen.getByTestId('objective-unreachable')).toBeTruthy()
  })

  // The anchor must be the SERVER's headline, not the locally-trimmed draft — the value
  // that comes back over SSE is the server's, so anchoring on the local one would expire
  // the note on its own echo the moment the route ever normalises text further.
  it('anchors the unreachable note on the headline the server persisted', async () => {
    apiFetch.mockImplementation(() => Promise.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        data: { delivered: false, changed: true, objective: { headline: 'server normalised goal' } },
      }),
    } as unknown as Response))
    const { rerender } = render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'typed goal' } })
    fireEvent.click(screen.getByTestId('objective-apply'))
    await waitFor(() => expect(screen.getByTestId('objective-unreachable')).toBeTruthy())

    // The echo carries what the SERVER stored — the note must recognise it as its own.
    rerender(<ObjectiveSurface runId="run-1" surface={objective('server normalised goal')} />)
    expect(screen.getByTestId('objective-unreachable')).toBeTruthy()
  })

  // Defensive fallback: the route always returns `objective`, but if it ever stops, the
  // note must still appear (an undelivered Apply is worth saying) — just anchored on the
  // weaker local value. Pinned so the degradation is visible rather than silent.
  it('still shows the note when the response omits the objective, anchored locally', async () => {
    apiFetch.mockImplementation(() => okApply({ delivered: false, changed: true }))
    const { rerender } = render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'a new goal' } })
    fireEvent.click(screen.getByTestId('objective-apply'))

    await waitFor(() => expect(screen.getByTestId('objective-unreachable')).toBeTruthy())
    rerender(<ObjectiveSurface runId="run-1" surface={objective('a new goal')} />)
    expect(screen.getByTestId('objective-unreachable')).toBeTruthy()
  })

  it('the unreachable note EXPIRES when the objective moves on to something else', async () => {
    apiFetch.mockImplementation(() => okApply({ delivered: false, changed: true }))
    const { rerender } = render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'a new goal' } })
    fireEvent.click(screen.getByTestId('objective-apply'))
    await waitFor(() => expect(screen.getByTestId('objective-unreachable')).toBeTruthy())

    // Another viewer (or the returning session) moves the objective on — the note is no
    // longer known to be true, so it goes.
    rerender(<ObjectiveSurface runId="run-1" surface={objective('someone else’s goal')} />)
    expect(screen.queryByTestId('objective-unreachable')).toBeNull()
  })

  it('the unreachable note can be dismissed', async () => {
    apiFetch.mockImplementation(() => okApply({ delivered: false, changed: true }))
    render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'a new goal' } })
    fireEvent.click(screen.getByTestId('objective-apply'))
    await waitFor(() => expect(screen.getByTestId('objective-unreachable')).toBeTruthy())

    fireEvent.click(screen.getByTestId('objective-unreachable-dismiss'))
    expect(screen.queryByTestId('objective-unreachable')).toBeNull()
  })

  it('a no-op Apply does NOT claim the session was unreachable', async () => {
    // changed:false ⇒ the server skipped delivery on purpose; delivered:false here is
    // a posture, not a failure, so the note must stay hidden.
    apiFetch.mockImplementation(() => okApply({ delivered: false, changed: false }))
    render(<ObjectiveSurface runId="run-1" surface={objective('same goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.click(screen.getByTestId('objective-apply'))

    await waitFor(() => expect(screen.queryByTestId('objective-input')).toBeNull())
    expect(screen.queryByTestId('objective-unreachable')).toBeNull()
  })

  it('surfaces a failed save as an error and stays in edit mode', async () => {
    apiFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: async () => null } as unknown as Response))
    render(<ObjectiveSurface runId="run-1" surface={objective('old goal')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'a new goal' } })
    fireEvent.click(screen.getByTestId('objective-apply'))

    await waitFor(() => expect(screen.getByTestId('objective-error')).toBeTruthy())
    expect(screen.getByTestId('objective-input')).toBeTruthy()
  })

  it('an incoming projection update does not eat an in-flight draft', () => {
    const { rerender } = render(<ObjectiveSurface runId="run-1" surface={objective('v1')} />)
    fireEvent.click(screen.getByTestId('objective-edit'))
    fireEvent.change(screen.getByTestId('objective-input'), { target: { value: 'my draft' } })

    rerender(<ObjectiveSurface runId="run-1" surface={objective('v2 from elsewhere')} />)

    expect((screen.getByTestId('objective-input') as HTMLTextAreaElement).value).toBe('my draft')
  })
})
