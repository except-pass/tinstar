// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PinLayer, type PinLayerProps } from '../PinLayer'
import type { Pin } from '../../domain/pinSet'

// jsdom doesn't implement pointer capture; stub it so the click/drag path runs.
beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

function pin(over: Partial<Pin> = {}): Pin {
  return { id: 'a', nodeId: 'n', nx: 0.5, ny: 0.5, comment: '', createdAt: 0, ...over }
}

function renderLayer(over: Partial<PinLayerProps> = {}) {
  const props: PinLayerProps = {
    pins: [pin()],
    accent: '#ff8800',
    zoom: 1,
    canSubmit: true,
    onReposition: vi.fn(),
    onCommentChange: vi.fn(),
    onDelete: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  }
  return render(<PinLayer {...props} />)
}

function clickMarker(id: string) {
  const marker = screen.getByTestId(`pin-marker-${id}`)
  fireEvent.pointerDown(marker, { clientX: 10, clientY: 10, pointerId: 1 })
  fireEvent.pointerUp(marker, { clientX: 10, clientY: 10, pointerId: 1 })
}

describe('PinLayer', () => {
  it('renders one marker per pin', () => {
    renderLayer({ pins: [pin({ id: 'a' }), pin({ id: 'b' })] })
    expect(screen.getByTestId('pin-marker-a')).toBeTruthy()
    expect(screen.getByTestId('pin-marker-b')).toBeTruthy()
  })

  it('toggles the bubble open and closed on marker click', () => {
    renderLayer()
    expect(screen.queryByTestId('pin-bubble-a')).toBeNull()
    clickMarker('a')
    expect(screen.getByTestId('pin-bubble-a')).toBeTruthy()
    clickMarker('a')
    expect(screen.queryByTestId('pin-bubble-a')).toBeNull()
  })

  it('disables Send when canSubmit is false and enables it when true', () => {
    renderLayer({ canSubmit: false })
    clickMarker('a')
    expect((screen.getByTestId('pin-submit-a') as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables Send when canSubmit is true', () => {
    renderLayer({ canSubmit: true })
    clickMarker('a')
    expect((screen.getByTestId('pin-submit-a') as HTMLButtonElement).disabled).toBe(false)
  })
})
