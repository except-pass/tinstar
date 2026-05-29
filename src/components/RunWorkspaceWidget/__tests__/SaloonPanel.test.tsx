// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'

// SaloonPanel transitively renders StreamView, which calls useBackendState
// (the shared SSE singleton). jsdom doesn't ship EventSource, so the
// singleton would crash on subscribe. Mock useBackendState here so the
// component tree renders without a backend.
vi.mock('../../../hooks/useBackendState', () => ({
  useBackendState: () => ({ topicMetadata: [] }),
}))

// The dot + topics read live NATS truth via apiFetch('/nats-status'). Mock it.
const apiFetchMock = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiUrl: (p: string) => p,
}))

import { SaloonPanel } from '../SaloonPanel'

function statusResponse(connection: string, subscriptions: string[]) {
  return { ok: true, status: 200, json: async () => ({ ok: true, data: { connection, subscriptions } }) }
}

const baseProps = {
  sessionName: 'natsViz',
  // config/intent value — should be overridden by the live probe once it lands
  subscriptions: ['tinstar.config.placeholder'],
  natsEnabled: true,
  natsControlOrphanedAt: null,
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue(statusResponse('open', ['tinstar.a.b.c', 'tinstar.a.b.c.natsviz']))
})

describe('<SaloonPanel> — truth-sourced dot + topics', () => {
  it('renders SALOON header and probes nats-status on mount', async () => {
    const { container } = render(<SaloonPanel {...baseProps} />)
    expect(container.textContent).toMatch(/SALOON/i)
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/sessions/natsViz/nats-status'),
    )
  })

  it('dot reflects the probed connection (open → green)', async () => {
    const { container } = render(<SaloonPanel {...baseProps} />)
    await waitFor(() =>
      expect(container.querySelector('[data-testid="saloon-dot"][data-status="open"]')).toBeTruthy(),
    )
  })

  it('dot shows down (not a red error) when there is no live connection', async () => {
    apiFetchMock.mockResolvedValue(statusResponse('down', []))
    const { container } = render(<SaloonPanel {...baseProps} />)
    await waitFor(() =>
      expect(container.querySelector('[data-testid="saloon-dot"][data-status="down"]')).toBeTruthy(),
    )
  })

  it('topics come from the live probe, not the config prop', async () => {
    const { container } = render(<SaloonPanel {...baseProps} />)
    // Live subjects render; the config placeholder does not.
    await waitFor(() => {
      const topics = [...container.querySelectorAll('[data-testid="saloon-topic"]')].map(t => t.getAttribute('title') ?? '')
      expect(topics.some(t => t.includes('tinstar.a.b.c'))).toBe(true)
      expect(topics.some(t => t.includes('tinstar.config.placeholder'))).toBe(false)
    })
  })

  it('clicking the dot re-probes', async () => {
    const { container } = render(<SaloonPanel {...baseProps} />)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    const dot = container.querySelector('[data-testid="saloon-dot"]')!
    fireEvent.click(dot)
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThan(1))
  })

  it('still renders the refresh button', async () => {
    const { container } = render(<SaloonPanel {...baseProps} />)
    expect(container.querySelector('[data-testid="saloon-refresh-btn"]')).toBeTruthy()
  })
})
