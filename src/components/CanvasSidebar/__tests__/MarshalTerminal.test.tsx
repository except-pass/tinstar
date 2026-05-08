// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MarshalTerminal } from '../MarshalTerminal'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(async () => ({
    json: async () => ({ ok: true, data: { name: 'marshal', port: 0 } }),
  })),
  apiUrl: (path: string) => path,
}))

vi.mock('../../../hooks/useServerEvents', () => ({
  useServerEvents: () => ({
    state: {
      marshal: {
        id: 'marshal',
        sessionId: 'marshal',
        status: 'idle',
        recapEntries: [
          { id: 'a1', type: 'agent', content: 'marshal hello' },
        ],
      },
    },
    connected: true,
    loading: false,
    addOptimistic: () => {},
    disconnect: () => {},
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('<MarshalTerminal>', () => {
  it('defaults to the Recap tab and shows recap entries', async () => {
    const { container } = render(<MarshalTerminal />)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="recap-pane"]')).toBeTruthy()
    })
  })

  it('uses power_settings_new for the restart button', async () => {
    const { container } = render(<MarshalTerminal />)
    await waitFor(() => {
      const btn = container.querySelector('[data-testid="marshal-restart"]')
      expect(btn).toBeTruthy()
      expect(btn?.querySelector('.material-symbols-outlined')?.textContent).toBe('power_settings_new')
    })
  })

  it('keeps refresh for the refresh button', async () => {
    const { container } = render(<MarshalTerminal />)
    await waitFor(() => {
      const btn = container.querySelector('[data-testid="marshal-refresh"]')
      expect(btn?.querySelector('.material-symbols-outlined')?.textContent).toBe('refresh')
    })
  })
})
