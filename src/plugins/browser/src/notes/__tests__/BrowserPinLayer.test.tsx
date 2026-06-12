// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BrowserPinLayer } from '../BrowserPinLayer'
import type { Pin } from '../../../../../domain/pinSet'

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
    fireEvent.pointerDown(screen.getByTestId('pin-marker-p1'))
    const ta = screen.getByTestId('pin-comment-p1')
    fireEvent.change(ta, { target: { value: 'new text' } })
    fireEvent.blur(ta)
    expect(onCommentChange).toHaveBeenCalledWith('p1', 'new text')
  })

  it('delete button fires onDelete and closes the bubble', () => {
    const onDelete = vi.fn()
    render(<BrowserPinLayer {...baseProps} onDelete={onDelete} />)
    fireEvent.pointerDown(screen.getByTestId('pin-marker-p1'))
    fireEvent.click(screen.getByTestId('pin-delete-p1'))
    expect(onDelete).toHaveBeenCalledWith('p1')
    expect(screen.queryByTestId('pin-comment-p1')).toBeNull()
  })

  it('Send fires onSubmit and is disabled without a session', () => {
    const onSubmit = vi.fn()
    const { rerender } = render(<BrowserPinLayer {...baseProps} onSubmit={onSubmit} />)
    fireEvent.pointerDown(screen.getByTestId('pin-marker-p1'))
    fireEvent.click(screen.getByTestId('pin-submit-p1'))
    expect(onSubmit).toHaveBeenCalledWith('p1')
    rerender(<BrowserPinLayer {...baseProps} canSubmit={false} />)
    expect(screen.getByTestId('pin-submit-p1')).toBeDisabled()
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
