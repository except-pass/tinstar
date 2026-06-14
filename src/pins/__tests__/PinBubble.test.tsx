// @vitest-environment jsdom
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PinBubble } from '../PinBubble'
import type { Reply } from '../../domain/pinSet'

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
        replies={[]} resolved={false}
        anchorEl={anchor()}
        onCommentChange={() => {}} onDelete={onDelete} onSubmit={() => {}}
        onReply={() => {}} onResolve={() => {}} onReopen={() => {}}
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
        replies={[]} resolved={false}
        anchorEl={anchor()}
        onCommentChange={() => {}} onDelete={() => {}} onSubmit={() => {}}
        onReply={() => {}} onResolve={() => {}} onReopen={() => {}}
      />,
    )
    expect(screen.getByTestId('pin-comment-p2')).toBeTruthy()
    expect(screen.getByTestId('pin-submit-p2')).toBeTruthy()
    expect(screen.getByTestId('pin-delete-p2')).toBeTruthy()
  })
})

// ── Thread / reply tests ──────────────────────────────────────────────────────

const reply = (over: Partial<Reply> = {}): Reply => ({
  id: 'r1', author: 'agent', text: 'because X', createdAt: 2, ...over,
})

type RenderBubbleOpts = Partial<{
  id: string
  comment: string
  sent: boolean
  canSubmit: boolean
  replies: Reply[]
  resolved: boolean
  onCommentChange: (c: string) => void
  onDelete: () => void
  onSubmit: (comment: string) => void
  onReply: (text: string) => void
  onResolve: () => void
  onReopen: () => void
}>

function renderBubble(opts: RenderBubbleOpts = {}) {
  const props = {
    id: 'p1',
    comment: '',
    sent: false,
    canSubmit: true,
    replies: [] as Reply[],
    resolved: false,
    anchorEl: anchor(),
    onCommentChange: vi.fn(),
    onDelete: vi.fn(),
    onSubmit: vi.fn(),
    onReply: vi.fn(),
    onResolve: vi.fn(),
    onReopen: vi.fn(),
    ...opts,
  }
  return render(<PinBubble {...props} />)
}

it('renders the comment and agent reply as a thread when sent', () => {
  const { getByText } = renderBubble({ sent: true, comment: 'why?', replies: [reply()] })
  expect(getByText('why?')).toBeTruthy()
  expect(getByText('because X')).toBeTruthy()
})

it('shows a reply input once sent and calls onReply with the typed text', () => {
  const onReply = vi.fn()
  const { getByTestId } = renderBubble({ sent: true, comment: 'q', replies: [reply()], onReply })
  fireEvent.change(getByTestId('pin-reply-input-p1'), { target: { value: 'thanks' } })
  fireEvent.click(getByTestId('pin-reply-send-p1'))
  expect(onReply).toHaveBeenCalledWith('thanks')
})

it('shows the awaiting-reply shimmer when the last message is from the user', () => {
  const { getByTestId } = renderBubble({ sent: true, comment: 'q', replies: [] }) // comment is last → user
  expect(getByTestId('pin-awaiting-p1')).toBeTruthy()
})

it('hides the shimmer when the agent has replied last', () => {
  const { queryByTestId } = renderBubble({ sent: true, comment: 'q', replies: [reply()] })
  expect(queryByTestId('pin-awaiting-p1')).toBeNull()
})

it('resolve calls onResolve; a resolved bubble offers reopen', () => {
  const onResolve = vi.fn(); const onReopen = vi.fn()
  const a = renderBubble({ sent: true, comment: 'q', replies: [reply()], onResolve })
  fireEvent.click(a.getByTestId('pin-resolve-p1'))
  expect(onResolve).toHaveBeenCalled()
  cleanup()
  const b = renderBubble({ sent: true, resolved: true, comment: 'q', replies: [reply()], onReopen })
  fireEvent.click(b.getByTestId('pin-reopen-p1'))
  expect(onReopen).toHaveBeenCalled()
})
