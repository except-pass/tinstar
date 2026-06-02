import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
global.fetch = fetchMock as any

vi.mock('../../src/apiClient', () => ({
  apiUrl: (p: string) => `http://test${p}`,
}))
vi.mock('../../src/hooks/useBackendState', () => ({
  useBackendState: () => ({ runRepo: { getAll: () => [] } }),
}))

import { FirstSessionStep } from '../../src/components/onboarding/FirstSessionStep'

beforeEach(() => {
  fetchMock.mockReset()
})

describe('FirstSessionStep', () => {
  it('lists available projects from /api/projects', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { tinstar: '/repo/tinstar' } }) })
    render(<FirstSessionStep />)
    await waitFor(() => expect(screen.getByTestId('session-project-select')).toBeTruthy())
    expect(screen.getByText('tinstar')).toBeTruthy()
  })

  it('POSTs to /api/sessions with project + cliTemplate=claude', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { tinstar: '/repo/tinstar' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    render(<FirstSessionStep />)
    await waitFor(() => screen.getByTestId('session-project-select'))
    fireEvent.change(screen.getByTestId('session-name-input'), { target: { value: 'first' } })
    fireEvent.click(screen.getByTestId('session-start'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body)
    expect(body).toMatchObject({ name: 'first', project: 'tinstar', cliTemplate: 'claude', backend: 'tmux' })
  })
})
