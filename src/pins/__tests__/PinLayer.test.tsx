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
    const { container } = renderLayer()
    expect(screen.queryByTestId('pin-bubble-a')).toBeNull()
    clickMarker('a')
    const bubble = screen.getByTestId('pin-bubble-a')
    expect(bubble).toBeTruthy()
    // The bubble is portaled to document.body so it can overshoot the (overflow-hidden)
    // layer — it must NOT be a DOM descendant of the rendered layer container.
    expect(container.contains(bubble)).toBe(false)
    expect(document.body.contains(bubble)).toBe(true)
    clickMarker('a')
    expect(screen.queryByTestId('pin-bubble-a')).toBeNull()
  })

  it('sends the FRESH draft on submit, not the stale stored comment (regression)', () => {
    // FIX 1: onCommentChange updates the store async (next-tick re-render), but
    // onSubmit runs synchronously this tick — so the submit must carry the bubble
    // DRAFT, not pin.comment (which still holds the pre-edit value). Proves Send
    // threads the freshly-typed text through onSubmit(id, comment).
    const onSubmit = vi.fn()
    renderLayer({ pins: [pin({ id: 'a', comment: 'OLD' })], onSubmit })
    clickMarker('a')
    fireEvent.change(screen.getByTestId('pin-comment-a'), { target: { value: 'NEW typed text' } })
    fireEvent.click(screen.getByTestId('pin-submit-a'))
    expect(onSubmit).toHaveBeenCalledWith('a', 'NEW typed text')
  })

  it('disables Send when canSubmit is false', () => {
    renderLayer({ canSubmit: false })
    clickMarker('a')
    expect((screen.getByTestId('pin-submit-a') as HTMLButtonElement).disabled).toBe(true)
  })

  it('enables Send when canSubmit is true', () => {
    renderLayer({ canSubmit: true })
    clickMarker('a')
    expect((screen.getByTestId('pin-submit-a') as HTMLButtonElement).disabled).toBe(false)
  })

  // FIX 4: drag/reposition path. The layer reads its own getBoundingClientRect to
  // normalize pointer coords; stub it to a known 200×100 box rooted at (0,0).
  function stubLayerRect(container: HTMLElement) {
    const layer = container.querySelector('.absolute.inset-0') as HTMLElement
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect
    return layer
  }

  it('repositions (and does NOT open the bubble) on a past-threshold drag', () => {
    const onReposition = vi.fn()
    const { container } = renderLayer({ onReposition })
    stubLayerRect(container)
    const marker = screen.getByTestId('pin-marker-a')
    // down at (10,10) → move to (30,10): dx=20 ≥ DRAG_THRESHOLD ⇒ drag.
    // nx = 30/200 = 0.15, ny = 10/100 = 0.10 (both inside [0,1], clamp is a no-op).
    fireEvent.pointerDown(marker, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(marker, { clientX: 30, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(marker, { clientX: 30, clientY: 10, pointerId: 1 })
    expect(onReposition).toHaveBeenCalled()
    const [id, nx, ny] = onReposition.mock.calls.at(-1)!
    expect(id).toBe('a')
    expect(nx).toBeCloseTo(0.15)
    expect(ny).toBeCloseTo(0.1)
    // A drag must not toggle the bubble open.
    expect(screen.queryByTestId('pin-bubble-a')).toBeNull()
  })

  it('does NOT reposition (and DOES open the bubble) on a sub-threshold click', () => {
    const onReposition = vi.fn()
    const { container } = renderLayer({ onReposition })
    stubLayerRect(container)
    const marker = screen.getByTestId('pin-marker-a')
    // down at (10,10) → move to (12,10): dx=2 < DRAG_THRESHOLD ⇒ click.
    fireEvent.pointerDown(marker, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(marker, { clientX: 12, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(marker, { clientX: 12, clientY: 10, pointerId: 1 })
    expect(onReposition).not.toHaveBeenCalled()
    expect(screen.getByTestId('pin-bubble-a')).toBeTruthy()
  })
})
