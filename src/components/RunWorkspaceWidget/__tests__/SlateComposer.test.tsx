// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// apiFetch is the single HTTP seam (never bare fetch — it 404s in Tauri). Mock it so
// the compose POST is observable and the delivered path is deterministic.
const apiFetch = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => p,
}))

import { SlateComposer } from '../SlateComposer'

function okDelivered(delivered = true) {
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { delivered } }) } as unknown as Response)
}

describe('SlateComposer (U4)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okDelivered(true))
  })

  it("typing 'pr' fuzzy-filters the catalog to PR review first", () => {
    render(<SlateComposer runId="run-1" onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-search'), { target: { value: 'pr' } })
    const first = screen
      .getByTestId('composer-templates')
      .querySelector('[data-testid^="composer-template-"]')
    expect(first?.getAttribute('data-testid')).toBe('composer-template-pr-review')
  })

  it('selecting a template + submit POSTs the template prompt and closes', async () => {
    const onClose = vi.fn()
    render(<SlateComposer runId="run-1" onClose={onClose} />)

    fireEvent.click(screen.getByTestId('composer-template-pr-review'))
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/compose',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const [, init] = apiFetch.mock.calls.find((c) => c[0] === '/api/runs/run-1/slate/compose')!
    const payload = JSON.parse((init as RequestInit).body as string)
    expect(payload.prompt).toContain('PR review')
    // Delivered → the composer closes (the surface arrives over the SSE run delta).
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('a freeform-only submit POSTs the freeform text (no prompt)', async () => {
    render(<SlateComposer runId="run-1" onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'a deploy checklist' } })
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const [, init] = apiFetch.mock.calls[0]!
    const payload = JSON.parse((init as RequestInit).body as string)
    expect(payload.freeform).toBe('a deploy checklist')
    expect(payload.prompt).toBeUndefined()
  })

  it('an empty submit is disabled', () => {
    render(<SlateComposer runId="run-1" onClose={vi.fn()} />)
    expect((screen.getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a create-time recipe is passed through in the compose payload', async () => {
    render(<SlateComposer runId="run-1" onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'a PR review surface' } })
    fireEvent.change(screen.getByTestId('composer-recipe'), { target: { value: 're-run the blind PR eval' } })
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const [, init] = apiFetch.mock.calls[0]!
    const payload = JSON.parse((init as RequestInit).body as string)
    expect(payload.recipe).toBe('re-run the blind PR eval')
    expect(payload.freeform).toBe('a PR review surface')
  })

  it('shows "not reachable" and stays open on delivered:false', async () => {
    const onClose = vi.fn()
    apiFetch.mockImplementation(() => okDelivered(false))
    render(<SlateComposer runId="run-1" onClose={onClose} />)

    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('composer-submit'))

    await waitFor(() => expect(screen.getByTestId('composer-unreachable')).toBeTruthy())
    expect(onClose).not.toHaveBeenCalled()
  })
})
