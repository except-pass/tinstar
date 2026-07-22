// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// apiFetch is the single HTTP seam (never bare fetch — it 404s in Tauri). Mock it so
// the explain POST is observable and the delivered path is deterministic.
const apiFetch = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => p,
}))

import { SlateExplainButton } from '../SlateExplainButton'

function respond(delivered: boolean) {
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { delivered } }) } as unknown as Response)
}

describe('SlateExplainButton', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => respond(true))
  })

  it('POSTs to the run-scoped explain route on click', async () => {
    render(<SlateExplainButton runId="run-1" />)
    fireEvent.click(screen.getByTestId('slate-explain'))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/explain',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('delivered:false surfaces a "not reachable" note', async () => {
    apiFetch.mockImplementation(() => respond(false))
    render(<SlateExplainButton runId="run-1" />)
    fireEvent.click(screen.getByTestId('slate-explain'))
    await waitFor(() => expect(screen.getByTestId('slate-explain-unreachable')).toBeTruthy())
  })

  it('a delivered request leaves no lingering note', async () => {
    render(<SlateExplainButton runId="run-1" />)
    fireEvent.click(screen.getByTestId('slate-explain'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(screen.queryByTestId('slate-explain-unreachable')).toBeNull()
    expect(screen.queryByTestId('slate-explain-error')).toBeNull()
  })

  it('a thrown request surfaces a "failed" note', async () => {
    apiFetch.mockImplementation(() => Promise.reject(new Error('network')))
    render(<SlateExplainButton runId="run-1" />)
    fireEvent.click(screen.getByTestId('slate-explain'))
    await waitFor(() => expect(screen.getByTestId('slate-explain-error')).toBeTruthy())
  })
})
