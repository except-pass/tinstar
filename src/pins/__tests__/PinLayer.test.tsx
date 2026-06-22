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
    onReply: vi.fn(),
    onResolve: vi.fn(),
    onReopen: vi.fn(),
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

  // M1: a drag now persists ONCE on pointer-up — NOT a PUT per pointer-move.
  it('persists ONCE on pointer-up after a multi-move drag, with the FINAL coords', () => {
    const onReposition = vi.fn()
    const { container } = renderLayer({ onReposition })
    stubLayerRect(container)
    const marker = screen.getByTestId('pin-marker-a')
    fireEvent.pointerDown(marker, { clientX: 10, clientY: 10, pointerId: 1 })
    // Several moves while dragging — none of these may call onReposition.
    fireEvent.pointerMove(marker, { clientX: 30, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(marker, { clientX: 60, clientY: 20, pointerId: 1 })
    fireEvent.pointerMove(marker, { clientX: 100, clientY: 40, pointerId: 1 })
    expect(onReposition).not.toHaveBeenCalled()
    // Release commits exactly one write with the FINAL position.
    fireEvent.pointerUp(marker, { clientX: 100, clientY: 40, pointerId: 1 })
    expect(onReposition).toHaveBeenCalledTimes(1)
    const [id, nx, ny] = onReposition.mock.calls[0]!
    expect(id).toBe('a')
    expect(nx).toBeCloseTo(0.5)  // 100/200
    expect(ny).toBeCloseTo(0.4)  // 40/100
  })

  it('tracks the cursor via LOCAL state during a drag (marker style moves before pointer-up)', () => {
    const onReposition = vi.fn()
    const { container } = renderLayer({ onReposition })
    stubLayerRect(container)
    const marker = screen.getByTestId('pin-marker-a')
    const wrapper = marker.parentElement as HTMLElement
    // Starts at the persisted 0.5/0.5 → 50%/50%.
    expect(wrapper.style.left).toBe('50%')
    fireEvent.pointerDown(marker, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(marker, { clientX: 160, clientY: 40, pointerId: 1 })
    // Mid-drag, BEFORE pointer-up: the marker reflects the live dragPos, not the store.
    expect(wrapper.style.left).toBe('80%')  // 160/200 = 0.8 → 80%
    expect(wrapper.style.top).toBe('40%')   // 40/100 = 0.4 → 40%
    expect(onReposition).not.toHaveBeenCalled()
  })

  it('does NOT persist on pointer-cancel (cancel == no move)', () => {
    const onReposition = vi.fn()
    const onDragActiveChange = vi.fn()
    const { container } = renderLayer({ onReposition, onDragActiveChange })
    stubLayerRect(container)
    const marker = screen.getByTestId('pin-marker-a')
    fireEvent.pointerDown(marker, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(marker, { clientX: 100, clientY: 40, pointerId: 1 })
    fireEvent.pointerCancel(marker, { clientX: 100, clientY: 40, pointerId: 1 })
    expect(onReposition).not.toHaveBeenCalled()
    expect(onDragActiveChange).toHaveBeenLastCalledWith(false)
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

  it('passes replies/resolved into the bubble and forwards onReply', () => {
    const onReply = vi.fn()
    const pins = [{ id: 'p1', nodeId: 'n', nx: 0.5, ny: 0.5, comment: 'q', createdAt: 1, sentAt: 2, replies: [{ id: 'r1', author: 'agent', text: 'a', createdAt: 3 }] }]
    const { getByTestId } = render(<PinLayer pins={pins as never} accent="#0ff" zoom={1} canSubmit
      onReposition={() => {}} onCommentChange={() => {}} onDelete={() => {}} onSubmit={() => {}}
      onReply={onReply} onResolve={() => {}} onReopen={() => {}} />)
    fireEvent.pointerDown(getByTestId('pin-marker-p1'))
    fireEvent.pointerUp(getByTestId('pin-marker-p1'))
    fireEvent.change(getByTestId('pin-reply-input-p1'), { target: { value: 'ok' } })
    fireEvent.click(getByTestId('pin-reply-send-p1'))
    expect(onReply).toHaveBeenCalledWith('p1', 'ok')
  })

  it('shows an unread dot for an agent reply not yet seen, clears after opening', () => {
    const pins = [{ id: 'p1', nodeId: 'n', nx: 0.5, ny: 0.5, comment: 'q', createdAt: 1, sentAt: 2, replies: [{ id: 'r1', author: 'agent', text: 'a', createdAt: 3 }] }]
    const { getByTestId, queryByTestId } = render(<PinLayer pins={pins as never} accent="#0ff" zoom={1} canSubmit
      onReposition={() => {}} onCommentChange={() => {}} onDelete={() => {}} onSubmit={() => {}}
      onReply={() => {}} onResolve={() => {}} onReopen={() => {}} />)
    expect(getByTestId('pin-unread-p1')).toBeTruthy()
    fireEvent.pointerDown(getByTestId('pin-marker-p1'))
    fireEvent.pointerUp(getByTestId('pin-marker-p1'))
    expect(queryByTestId('pin-unread-p1')).toBeNull()
  })
})
