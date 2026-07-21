// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { A2uiContent, SlateSurface } from '../../../types'

const apiFetch = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => p,
}))

import { DiagramSurface } from '../DiagramSurface'

function ok(data: Record<string, unknown> = { point: {}, delivered: true }) {
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, data }) } as unknown as Response)
}

function content(text: string): A2uiContent {
  return { root: 'root', components: [{ id: 'root', component: 'Text', text, variant: 'body' }] }
}

function diagram(id: string, extra: Partial<SlateSurface> = {}): SlateSurface {
  return {
    id,
    author: 'agent',
    kind: 'diagram',
    body: content('the architecture picture'),
    createdAt: 1,
    amendedAt: 1,
    ...extra,
  }
}

describe('DiagramSurface (U8)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => ok())
  })

  it('renders its A2UI body AND a per-surface thread', () => {
    render(
      <DiagramSurface
        runId="run-1"
        surface={diagram('d1', {
          thread: [{ id: 'r1', author: 'agent', text: 'drawn from the plan', createdAt: 1 }],
        })}
      />,
    )
    // The picture (file-owned body)…
    expect(screen.getByText('the architecture picture')).toBeTruthy()
    // …AND the surface-anchored thread (store-owned) shown beneath it.
    expect(screen.getByText('drawn from the plan')).toBeTruthy()
    expect(screen.getByTestId('reply-input-d1')).toBeTruthy()
  })

  it('posts a comment to the surface thread', async () => {
    render(<DiagramSurface runId="run-1" surface={diagram('d1')} />)
    const reply = screen.getByTestId('reply-input-d1') as HTMLInputElement
    fireEvent.change(reply, { target: { value: 'why two watchers?' } })
    fireEvent.click(screen.getByTestId('reply-send-d1'))

    // Optimistic append, scoped to THIS surface's thread.
    expect(screen.getByText('why two watchers?')).toBeTruthy()
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/points/d1/replies',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })
})
