// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { SaloonRefreshButton } from '../RunWorkspaceWidget/saloon/SaloonRefreshButton'

vi.mock('../../apiClient', () => ({
  apiFetch: vi.fn(),
  apiUrl: (p: string) => p,
}))

import { apiFetch } from '../../apiClient'

beforeEach(() => {
  vi.clearAllMocks()
  ;(apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
})

describe('SaloonRefreshButton', () => {
  it('uses apiFetch for the bounce request (Tauri-safe)', async () => {
    const { getByTestId } = render(<SaloonRefreshButton sessionName="demo" natsControlOrphanedAt={null} />)
    fireEvent.click(getByTestId('saloon-refresh-btn'))
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/nats-traffic/bounce', expect.objectContaining({ method: 'POST' }))
    })
  })
})
