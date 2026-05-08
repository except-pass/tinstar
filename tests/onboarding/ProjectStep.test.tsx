// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true }) })
global.fetch = fetchMock as any

const openDirectoryDialog = vi.hoisted(() => vi.fn().mockResolvedValue('/home/u/repo/myapp'))
vi.mock('../../src/desktop/desktopApi', () => ({
  desktopApi: { openDirectoryDialog },
}))
vi.mock('../../src/apiClient', () => ({
  apiUrl: (p: string) => `http://test${p}`,
}))

import { ProjectStep } from '../../src/components/onboarding/ProjectStep'

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true }) })
  openDirectoryDialog.mockClear()
  openDirectoryDialog.mockResolvedValue('/home/u/repo/myapp')
})

describe('ProjectStep', () => {
  it('registers project via POST /api/projects', async () => {
    render(<ProjectStep />)
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: 'myapp' } })
    fireEvent.change(screen.getByTestId('project-path-input'), { target: { value: '/home/u/repo/myapp' } })
    fireEvent.click(screen.getByTestId('project-register'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://test/api/projects',
      expect.objectContaining({ method: 'POST' }),
    ))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ name: 'myapp', path: '/home/u/repo/myapp' })
  })

  it('renders Browse button when openDirectoryDialog capability exists', () => {
    render(<ProjectStep />)
    expect(screen.getByTestId('project-browse')).toBeTruthy()
  })

  it('fills path field when Browse returns a folder', async () => {
    render(<ProjectStep />)
    fireEvent.click(screen.getByTestId('project-browse'))
    await waitFor(() => expect((screen.getByTestId('project-path-input') as HTMLInputElement).value)
      .toBe('/home/u/repo/myapp'))
  })
})
