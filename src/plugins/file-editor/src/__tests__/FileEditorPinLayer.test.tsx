// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileEditorPinLayer } from '../FileEditorPinLayer'
import type { Pin } from '../../../../domain/pinSet'

// jsdom implements neither pointer capture nor a real layout box; stub both.
beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p1', nodeId: 'editor-w1', nx: 0.5, ny: 0.5, comment: 'hi', createdAt: 1, ...over,
})

const baseProps = {
  pins: [pin({ context: { docX: 0, docY: 400 } })],
  scroll: { x: 0, y: 0 },
  contentWidth: 600,
  contentHeight: 1000,
  accent: '#abc',
  canSubmit: true,
  onCommentChange: vi.fn(),
  onDelete: vi.fn(),
  onSubmit: vi.fn(),
  onReply: vi.fn(),
  onResolve: vi.fn(),
  onReopen: vi.fn(),
  onReposition: vi.fn(),
}

/** Open a pin's bubble: a sub-threshold down→up is a click (toggle). */
function clickMarker(id: string, x = 5, y = 5) {
  const marker = screen.getByTestId(`pin-marker-${id}`)
  fireEvent.pointerDown(marker, { pointerId: 1, clientX: x, clientY: y })
  fireEvent.pointerUp(marker, { pointerId: 1, clientX: x, clientY: y })
}

describe('FileEditorPinLayer', () => {
  it('glues an enriched pin to scrolling content: top = docY - scroll.y (regression)', () => {
    // The bug: pins stayed glued to the widget FRAME while the markdown scrolled.
    // The fix positions the marker in document coords minus the scroll offset, so
    // scrolling the content down by 250px moves the marker UP by the same amount.
    render(<FileEditorPinLayer {...baseProps} scroll={{ x: 0, y: 250 }} />)
    const marker = screen.getByTestId('pin-marker-p1')
    expect(marker.parentElement!.style.top).toBe('150px')  // docY 400 - scroll.y 250
    expect(marker.parentElement!.style.left).toBe('0px')    // docX 0 - scroll.x 0
  })

  it('positions a fresh (un-enriched) pin from nx/ny against the content box', () => {
    render(<FileEditorPinLayer {...baseProps} pins={[pin({ nx: 0.25, ny: 0.5, context: undefined })]} />)
    const marker = screen.getByTestId('pin-marker-p1')
    expect(marker.parentElement!.style.left).toBe('150px')  // 0.25 * 600
    expect(marker.parentElement!.style.top).toBe('500px')   // 0.5 * 1000
  })

  it('renders one marker per pin (no page/url scoping)', () => {
    render(<FileEditorPinLayer {...baseProps}
      pins={[pin({ id: 'a', context: { docX: 0, docY: 10 } }), pin({ id: 'b', context: { docX: 0, docY: 20 } })]} />)
    expect(screen.getByTestId('pin-marker-a')).toBeInTheDocument()
    expect(screen.getByTestId('pin-marker-b')).toBeInTheDocument()
  })

  it('clicking a marker opens the bubble; editing commits on blur', () => {
    const onCommentChange = vi.fn()
    render(<FileEditorPinLayer {...baseProps} onCommentChange={onCommentChange} />)
    clickMarker('p1')
    const ta = screen.getByTestId('pin-comment-p1')
    fireEvent.change(ta, { target: { value: 'new text' } })
    fireEvent.blur(ta)
    expect(onCommentChange).toHaveBeenCalledWith('p1', 'new text')
  })

  it('delete button fires onDelete and closes the bubble', () => {
    const onDelete = vi.fn()
    render(<FileEditorPinLayer {...baseProps} onDelete={onDelete} />)
    clickMarker('p1')
    fireEvent.click(screen.getByTestId('pin-delete-p1'))
    expect(onDelete).toHaveBeenCalledWith('p1')
    expect(screen.queryByTestId('pin-comment-p1')).toBeNull()
  })

  describe('drag-to-reposition', () => {
    function stubLayerRect(left = 0, top = 0, width = 600, height = 1000) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => {},
      } as DOMRect)
    }

    it('drag persists ONCE on pointer-up with FINAL doc coords (clientX - rect.left + scroll.x)', () => {
      const onReposition = vi.fn()
      const onDragActiveChange = vi.fn()
      stubLayerRect(0, 0, 600, 1000)
      render(<FileEditorPinLayer {...baseProps} scroll={{ x: 0, y: 250 }} onReposition={onReposition} onDragActiveChange={onDragActiveChange} />)
      const marker = screen.getByTestId('pin-marker-p1')

      fireEvent.pointerDown(marker, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 130, clientY: 200 })
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 140, clientY: 300 })
      expect(onDragActiveChange).toHaveBeenCalledWith(true)
      expect(onReposition).not.toHaveBeenCalled()

      fireEvent.pointerUp(marker, { pointerId: 1, clientX: 140, clientY: 300 })
      // docX = 140 - 0 + 0 = 140 ; docY = 300 - 0 + 250 = 550
      expect(onReposition).toHaveBeenCalledTimes(1)
      expect(onReposition).toHaveBeenCalledWith('p1', 140, 550)
      expect(onDragActiveChange).toHaveBeenLastCalledWith(false)
    })

    it('sub-threshold down→up toggles the bubble and does NOT reposition', () => {
      const onReposition = vi.fn()
      render(<FileEditorPinLayer {...baseProps} onReposition={onReposition} />)
      const marker = screen.getByTestId('pin-marker-p1')
      expect(screen.queryByTestId('pin-bubble-p1')).toBeNull()
      fireEvent.pointerDown(marker, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 102, clientY: 101 })
      fireEvent.pointerUp(marker, { pointerId: 1, clientX: 102, clientY: 101 })
      expect(onReposition).not.toHaveBeenCalled()
      expect(screen.getByTestId('pin-bubble-p1')).toBeInTheDocument()
    })
  })
})
