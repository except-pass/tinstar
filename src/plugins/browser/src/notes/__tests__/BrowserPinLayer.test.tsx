// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BrowserPinLayer } from '../BrowserPinLayer'
import type { Pin } from '../../../../../domain/pinSet'

// jsdom implements neither pointer capture nor a real layout box; stub both.
beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p1', nodeId: 'browser-w1', nx: 0.5, ny: 0.5, comment: 'hi', createdAt: 1, ...over,
})

const baseProps = {
  pins: [pin({ context: { url: 'http://x/', docX: 100, docY: 150 } })],
  url: 'http://x/',
  scroll: { x: 0, y: 0 },
  iframeWidth: 800,
  iframeHeight: 600,
  accent: '#abc',
  canSubmit: true,
  onCommentChange: vi.fn(),
  onDelete: vi.fn(),
  onSubmit: vi.fn(),
  onReposition: vi.fn(),
}

/** Open a pin's bubble: a sub-threshold down→up is a click (toggle). The marker
 *  captures the pointer on down; pointerup bubbles to the layer's handler. */
function clickMarker(id: string, x = 5, y = 5) {
  const marker = screen.getByTestId(`pin-marker-${id}`)
  fireEvent.pointerDown(marker, { pointerId: 1, clientX: x, clientY: y })
  fireEvent.pointerUp(marker, { pointerId: 1, clientX: x, clientY: y })
}

describe('BrowserPinLayer', () => {
  it('positions an enriched pin at its document coords minus scroll', () => {
    render(<BrowserPinLayer {...baseProps} scroll={{ x: 10, y: 50 }} />)
    const marker = screen.getByTestId('pin-marker-p1')
    expect(marker).toHaveTextContent('1')
    expect(marker.parentElement!.style.left).toBe('90px')   // 100 - 10
    expect(marker.parentElement!.style.top).toBe('100px')   // 150 - 50
  })

  it('positions a fresh (un-enriched) pin from nx/ny against the iframe box', () => {
    render(<BrowserPinLayer {...baseProps} pins={[pin({ nx: 0.25, ny: 0.5, context: undefined })]} />)
    const marker = screen.getByTestId('pin-marker-p1')
    expect(marker.parentElement!.style.left).toBe('200px')  // 0.25 * 800
    expect(marker.parentElement!.style.top).toBe('300px')   // 0.5 * 600
  })

  it('renders a fresh pin (no context) on the current page', () => {
    render(<BrowserPinLayer {...baseProps} pins={[pin({ context: undefined })]} />)
    expect(screen.getByTestId('pin-marker-p1')).toBeInTheDocument()
  })

  it('renders a docX/docY-bearing pin with NO url as current-page (M2: never vanish)', () => {
    // Regression for an old context-less pin that was repositioned before the
    // url-stamp fix: context exists (docX/docY) but url is undefined. onCurrentPage
    // must treat it as current-page so it can still render (otherwise it survives in
    // storage but is invisible forever).
    render(<BrowserPinLayer {...baseProps}
      pins={[pin({ context: { docX: 100, docY: 150 } })]} />)
    expect(screen.getByTestId('pin-marker-p1')).toBeInTheDocument()
  })

  it('hides pins whose context url is a different page', () => {
    render(<BrowserPinLayer {...baseProps}
      pins={[pin({ context: { url: 'http://x/', docX: 0, docY: 0 } }),
             pin({ id: 'p2', context: { url: 'http://x/other', docX: 0, docY: 0 } })]} />)
    expect(screen.getByTestId('pin-marker-p1')).toBeInTheDocument()
    expect(screen.queryByTestId('pin-marker-p2')).toBeNull()
  })

  it('marks sent pins', () => {
    render(<BrowserPinLayer {...baseProps}
      pins={[pin({ sentAt: 9, context: { url: 'http://x/', docX: 0, docY: 0 } })]} />)
    expect(screen.getByTestId('pin-marker-p1')).toHaveAttribute('data-sent', 'true')
  })

  it('clicking a marker opens the bubble; editing commits on blur', () => {
    const onCommentChange = vi.fn()
    render(<BrowserPinLayer {...baseProps} onCommentChange={onCommentChange} />)
    clickMarker('p1')
    const ta = screen.getByTestId('pin-comment-p1')
    fireEvent.change(ta, { target: { value: 'new text' } })
    fireEvent.blur(ta)
    expect(onCommentChange).toHaveBeenCalledWith('p1', 'new text')
  })

  it('delete button fires onDelete and closes the bubble', () => {
    const onDelete = vi.fn()
    render(<BrowserPinLayer {...baseProps} onDelete={onDelete} />)
    clickMarker('p1')
    fireEvent.click(screen.getByTestId('pin-delete-p1'))
    expect(onDelete).toHaveBeenCalledWith('p1')
    expect(screen.queryByTestId('pin-comment-p1')).toBeNull()
  })

  it('Send fires onSubmit and is disabled without a session', () => {
    const onSubmit = vi.fn()
    const { rerender } = render(<BrowserPinLayer {...baseProps} onSubmit={onSubmit} />)
    clickMarker('p1')
    fireEvent.click(screen.getByTestId('pin-submit-p1'))
    // FIX 1: onSubmit now threads the bubble draft (initialized to the stored
    // comment 'hi' since nothing was typed) so the fresh comment is sent.
    expect(onSubmit).toHaveBeenCalledWith('p1', 'hi')
    rerender(<BrowserPinLayer {...baseProps} canSubmit={false} />)
    expect(screen.getByTestId('pin-submit-p1')).toBeDisabled()
  })

  // ── Drag-to-reposition: a past-threshold drag updates the pin's DOCUMENT coords
  // (docX/docY = clientX - layerRect.left + scroll.x); a sub-threshold release is a
  // click (toggles the bubble) and never repositions. ──
  describe('drag-to-reposition', () => {
    /** The overlay (layerRef) box is the docX/docY origin. jsdom zeros it, so stub
     *  it to a known rect via the marker's grandparent — but the layer is the
     *  outermost div; spy on HTMLDivElement.prototype.getBoundingClientRect to
     *  return our box for the overlay. We target by spying on the element directly. */
    function stubLayerRect(left = 0, top = 0, width = 800, height = 600) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => {},
      } as DOMRect)
    }

    it('drag persists ONCE on pointer-up with the FINAL doc coords (clientX - rect.left + scroll.x)', () => {
      const onReposition = vi.fn()
      const onDragActiveChange = vi.fn()
      stubLayerRect(0, 0, 800, 600)
      render(<BrowserPinLayer {...baseProps} scroll={{ x: 10, y: 50 }} onReposition={onReposition} onDragActiveChange={onDragActiveChange} />)
      const marker = screen.getByTestId('pin-marker-p1')

      fireEvent.pointerDown(marker, { pointerId: 1, clientX: 100, clientY: 100 })
      // M1: several moves while dragging — NONE may call onReposition (no PUT-per-move).
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 130, clientY: 110 })
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 200, clientY: 180 })
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 240, clientY: 210 })
      expect(onDragActiveChange).toHaveBeenCalledWith(true)
      expect(onReposition).not.toHaveBeenCalled()

      // Release commits exactly one write with the FINAL position.
      fireEvent.pointerUp(marker, { pointerId: 1, clientX: 240, clientY: 210 })
      // docX = 240 - 0 + 10 = 250 ; docY = 210 - 0 + 50 = 260
      expect(onReposition).toHaveBeenCalledTimes(1)
      expect(onReposition).toHaveBeenCalledWith('p1', 250, 260)
      expect(onDragActiveChange).toHaveBeenLastCalledWith(false)
    })

    it('tracks the cursor via LOCAL state during a drag (marker style moves before pointer-up)', () => {
      const onReposition = vi.fn()
      stubLayerRect(0, 0, 800, 600)
      render(<BrowserPinLayer {...baseProps} scroll={{ x: 10, y: 50 }} onReposition={onReposition} />)
      const marker = screen.getByTestId('pin-marker-p1')
      const wrapper = marker.parentElement as HTMLElement
      // Persisted: docX 100, docY 150, scroll 10/50 → left 90, top 100.
      expect(wrapper.style.left).toBe('90px')
      fireEvent.pointerDown(marker, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 240, clientY: 210 })
      // Mid-drag: live docX 250 / docY 260 → left 250-10=240, top 260-50=210.
      expect(wrapper.style.left).toBe('240px')
      expect(wrapper.style.top).toBe('210px')
      expect(onReposition).not.toHaveBeenCalled()
    })

    it('does NOT persist on pointer-cancel (cancel == no move)', () => {
      const onReposition = vi.fn()
      const onDragActiveChange = vi.fn()
      stubLayerRect(0, 0, 800, 600)
      render(<BrowserPinLayer {...baseProps} onReposition={onReposition} onDragActiveChange={onDragActiveChange} />)
      const marker = screen.getByTestId('pin-marker-p1')
      fireEvent.pointerDown(marker, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 240, clientY: 210 })
      fireEvent.pointerCancel(marker, { pointerId: 1, clientX: 240, clientY: 210 })
      expect(onReposition).not.toHaveBeenCalled()
      expect(onDragActiveChange).toHaveBeenLastCalledWith(false)
    })

    it('sub-threshold down→up toggles the bubble and does NOT reposition', () => {
      const onReposition = vi.fn()
      render(<BrowserPinLayer {...baseProps} onReposition={onReposition} />)
      const marker = screen.getByTestId('pin-marker-p1')

      expect(screen.queryByTestId('pin-bubble-p1')).toBeNull()
      fireEvent.pointerDown(marker, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(marker, { pointerId: 1, clientX: 102, clientY: 101 }) // <threshold
      fireEvent.pointerUp(marker, { pointerId: 1, clientX: 102, clientY: 101 })

      expect(onReposition).not.toHaveBeenCalled()
      expect(screen.getByTestId('pin-bubble-p1')).toBeInTheDocument()
    })
  })
})

describe('BrowserPinLayer fresh-pin fallback coords (overlay origin = iframe body)', () => {
  // The BrowserPinLayer overlay is `absolute inset-0` within the body section
  // (the `relative` wrapper that sits BELOW the toolbar and covers exactly the
  // iframe).  iframeWidth/iframeHeight are the iframe's own dimensions (NOT the
  // whole widget).  A fresh pin's nx/ny was normalized against the whole container
  // by the shell, so the BrowserPrimitive enrichment effect must correct for the
  // header offset before writing docX/docY.  Once enriched, the render is simply
  // docX - scroll.x within the overlay.  These tests verify that the fallback
  // path (un-enriched pin rendered directly from nx/ny) places the marker at the
  // expected iframe-body position, and that an enriched pin with a toolbar-
  // corrected docY renders at the right spot.
  const HEADER = 44
  const iframeWidth = 800
  const iframeHeight = 600  // iframe body height (excludes toolbar)

  it('fresh pin fallback: positioned at nx*iframeWidth / ny*iframeHeight within overlay', () => {
    // nx=0.5, ny=0.5 with no context.  The overlay covers the iframe body, so
    // the marker should land at (400, 300) — dead-centre of the iframe.
    render(
      <BrowserPinLayer
        {...baseProps}
        pins={[pin({ nx: 0.5, ny: 0.5, context: undefined })]}
        iframeWidth={iframeWidth}
        iframeHeight={iframeHeight}
        scroll={{ x: 0, y: 0 }}
      />,
    )
    const marker = screen.getByTestId('pin-marker-p1')
    expect(marker.parentElement!.style.left).toBe('400px')  // 0.5 * 800
    expect(marker.parentElement!.style.top).toBe('300px')   // 0.5 * 600
  })

  it('enriched pin: docY accounts for toolbar offset — docY = (0.5*hostHeight) - headerHeight + scrollY', () => {
    // Simulate what the fixed enrichment produces.
    // hostHeight = iframeHeight + HEADER = 644 (full widget box height)
    // pin dropped at ny=0.5  →  clientY = host.top + 0.5 * 644
    //                       →  vy = clientY - ifrFrame.top
    //                            = (host.top + 0.5*644) - (host.top + HEADER)
    //                            = 0.5*644 - 44 = 322 - 44 = 278
    //                       →  docY = vy + scrollY = 278 + 20 = 298
    // Rendered position within overlay: docY - scroll.y = 298 - 20 = 278 = vy ✓
    const hostHeight = iframeHeight + HEADER  // 644
    const scrollY = 20
    const expectedDocY = 0.5 * hostHeight - HEADER + scrollY  // 278
    render(
      <BrowserPinLayer
        {...baseProps}
        pins={[pin({ nx: 0.5, ny: 0.5, context: { url: 'http://x/', docX: 400, docY: expectedDocY } })]}
        iframeWidth={iframeWidth}
        iframeHeight={iframeHeight}
        scroll={{ x: 0, y: scrollY }}
      />,
    )
    const marker = screen.getByTestId('pin-marker-p1')
    // Rendered top = docY - scroll.y = (0.5*hostHeight - HEADER + scrollY) - scrollY
    //             = 0.5*644 - 44 = 278px
    expect(marker.parentElement!.style.top).toBe('278px')
  })
})
