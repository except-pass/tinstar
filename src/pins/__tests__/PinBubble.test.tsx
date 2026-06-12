// @vitest-environment jsdom
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PinBubble } from '../PinBubble'

afterEach(() => cleanup())

/** A bare element to anchor the (portal-rendered) bubble against. */
function anchor(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

describe('PinBubble', () => {
  it('renders a delete button in the SENT view that calls onDelete', () => {
    const onDelete = vi.fn()
    render(
      <PinBubble
        id="p1" comment="already sent" sent canSubmit
        anchorEl={anchor()}
        onCommentChange={() => {}} onDelete={onDelete} onSubmit={() => {}}
      />,
    )
    // Sent view shows the comment plus a delete control (no submit button).
    expect(screen.getByText(/already sent/)).toBeTruthy()
    expect(screen.queryByTestId('pin-submit-p1')).toBeNull()
    const del = screen.getByTestId('pin-delete-p1')
    fireEvent.click(del)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('renders the textarea + submit in the UNSENT view', () => {
    render(
      <PinBubble
        id="p2" comment="" sent={false} canSubmit
        anchorEl={anchor()}
        onCommentChange={() => {}} onDelete={() => {}} onSubmit={() => {}}
      />,
    )
    expect(screen.getByTestId('pin-comment-p2')).toBeTruthy()
    expect(screen.getByTestId('pin-submit-p2')).toBeTruthy()
    expect(screen.getByTestId('pin-delete-p2')).toBeTruthy()
  })
})
