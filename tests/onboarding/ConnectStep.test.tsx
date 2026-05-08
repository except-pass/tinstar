// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { saveConfig, probeBackend } = vi.hoisted(() => ({
  saveConfig: vi.fn().mockResolvedValue(undefined),
  probeBackend: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/desktop/desktopApi', () => ({
  desktopApi: { saveConfig, probeBackend },
}))

import { ConnectStep } from '../../src/components/onboarding/ConnectStep'

beforeEach(() => {
  saveConfig.mockClear()
  probeBackend.mockClear()
  probeBackend.mockResolvedValue(true)
  // Stub window.location.reload so jsdom doesn't error
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: vi.fn() },
  })
})

describe('ConnectStep', () => {
  it('saves config and reloads on submit when probe succeeds', async () => {
    render(<ConnectStep />)
    const input = screen.getByTestId('connect-url-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'http://localhost:5273' } })
    fireEvent.click(screen.getByTestId('connect-save'))
    await waitFor(() => expect(probeBackend).toHaveBeenCalledWith('http://localhost:5273'))
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith({
      backend: { mode: 'remote', url: 'http://localhost:5273' },
    }))
  })

  it('shows error when probe fails', async () => {
    probeBackend.mockResolvedValueOnce(false)
    render(<ConnectStep />)
    fireEvent.change(screen.getByTestId('connect-url-input'), { target: { value: 'http://nope:5273' } })
    fireEvent.click(screen.getByTestId('connect-save'))
    await waitFor(() => expect(screen.getByTestId('connect-error')).toHaveTextContent(/unreachable/i))
  })
})
