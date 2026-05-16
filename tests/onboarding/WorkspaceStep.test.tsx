import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn()
global.fetch = fetchMock as any

vi.mock('../../src/apiClient', () => ({
  apiUrl: (p: string) => `http://test${p}`,
}))

import { WorkspaceStep } from '../../src/components/onboarding/WorkspaceStep'

beforeEach(() => {
  fetchMock.mockReset()
})

describe('WorkspaceStep', () => {
  it('POSTs to /api/spaces with the entered name', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 'spc-1', name: 'My Space', createdAt: 'now' }) })
    render(<WorkspaceStep />)
    fireEvent.change(screen.getByTestId('workspace-name-input'), { target: { value: 'My Space' } })
    fireEvent.click(screen.getByTestId('workspace-create'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://test/api/spaces',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'My Space' }) }),
    ))
  })
})
