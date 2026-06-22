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

  // Ctrl/Cmd+Enter sends the note, mirroring the prompt composer. Plain Enter is
  // left for newlines (notes can be multi-line), and the canSubmit gate that
  // disables the Send button must also gate the keyboard send.
  it.each([
    ['ctrlKey', { ctrlKey: true }],
    ['metaKey', { metaKey: true }],
  ])('sends the note on %s+Enter', (_label, mods) => {
    const onCommentChange = vi.fn(); const onSubmit = vi.fn()
    render(
      <PinBubble
        id="p3" comment="" sent={false} canSubmit
        replies={[]} resolved={false}
        anchorEl={anchor()}
        onCommentChange={onCommentChange} onDelete={() => {}} onSubmit={onSubmit}
        onReply={() => {}} onResolve={() => {}} onReopen={() => {}}
      />,
    )
    fireEvent.change(screen.getByTestId('pin-comment-p3'), { target: { value: 'fix this spacing' } })
    fireEvent.keyDown(screen.getByTestId('pin-comment-p3'), { key: 'Enter', ...mods })
    expect(onCommentChange).toHaveBeenCalledWith('fix this spacing')
    expect(onSubmit).toHaveBeenCalledWith('fix this spacing')
  })

  it('does NOT send on plain Enter (reserved for newlines)', () => {
    const onSubmit = vi.fn()
    render(
      <PinBubble
        id="p4" comment="" sent={false} canSubmit
        replies={[]} resolved={false}
        anchorEl={anchor()}
        onCommentChange={() => {}} onDelete={() => {}} onSubmit={onSubmit}
        onReply={() => {}} onResolve={() => {}} onReopen={() => {}}
      />,
    )
    fireEvent.keyDown(screen.getByTestId('pin-comment-p4'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Ctrl+Enter does not send when canSubmit is false', () => {
    const onSubmit = vi.fn()
    render(
      <PinBubble
        id="p5" comment="" sent={false} canSubmit={false}
        replies={[]} resolved={false}
        anchorEl={anchor()}
        onCommentChange={() => {}} onDelete={() => {}} onSubmit={onSubmit}
        onReply={() => {}} onResolve={() => {}} onReopen={() => {}}
      />,
    )
    fireEvent.keyDown(screen.getByTestId('pin-comment-p5'), { key: 'Enter', ctrlKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

// ── Canvas clipping ───────────────────────────────────────────────────────────
// The bubble is portaled to <body> (position:fixed) so the canvas's overflow-clip
// can't clip it. It must clip itself to the canvas viewport, or a marker that the
// canvas pans off-screen (e.g. clicking inbox sessions → flash-focus → centerOn)
// leaves its note floating over the sidebar/inbox. See [data-testid="infinite-canvas"].
describe('PinBubble canvas clipping', () => {
  function mockRect(el: Element, r: Partial<DOMRect>) {
    const base = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
    el.getBoundingClientRect = () => ({ ...base, ...r }) as DOMRect
  }
  // Append a mock canvas with an anchor inside it, tracking the canvas for teardown
  // (RTL's cleanup() unmounts rendered components but not these hand-appended nodes).
  const canvases: HTMLElement[] = []
  function makeCanvas(rect: Partial<DOMRect>): HTMLElement {
    const canvas = document.createElement('div')
    canvas.setAttribute('data-testid', 'infinite-canvas')
    mockRect(canvas, rect)
    document.body.appendChild(canvas)
    canvases.push(canvas)
    return canvas
  }
  function canvasWithAnchor(anchorRect: Partial<DOMRect>): HTMLElement {
    const canvas = makeCanvas({ left: 300, top: 0, right: 1000, bottom: 800, width: 700, height: 800 })
    const a = document.createElement('div')
    canvas.appendChild(a)
    mockRect(a, anchorRect)
    return a
  }
  afterEach(() => { canvases.splice(0).forEach(c => c.remove()) })

  it('hides the bubble when its anchor is panned left of the canvas (onto the sidebar)', () => {
    // Marker center x ≈ 55, left of the canvas's left edge (300) — i.e. under the sidebar.
    const a = canvasWithAnchor({ left: 50, top: 100, right: 60, bottom: 110, width: 10, height: 10 })
    render(
      <PinBubble id="off" comment="hi" sent canSubmit replies={[]} resolved={false}
        anchorEl={a}
        onCommentChange={() => {}} onDelete={() => {}} onSubmit={() => {}}
        onReply={() => {}} onResolve={() => {}} onReopen={() => {}} />,
    )
    expect(screen.queryByTestId('pin-bubble-off')).toBeNull()
  })

  it('renders the bubble when its anchor is inside the canvas viewport', () => {
    const a = canvasWithAnchor({ left: 500, top: 100, right: 510, bottom: 110, width: 10, height: 10 })
    render(
      <PinBubble id="in" comment="hi" sent canSubmit replies={[]} resolved={false}
        anchorEl={a}
        onCommentChange={() => {}} onDelete={() => {}} onSubmit={() => {}}
        onReply={() => {}} onResolve={() => {}} onReopen={() => {}} />,
    )
    expect(screen.getByTestId('pin-bubble-in')).toBeTruthy()
  })

  it('clamps the bubble to the canvas rect, not the window viewport', () => {
    // Canvas inset from the jsdom window (1024x768) on all sides, so canvas-vs-window
    // clamping is distinguishable. Anchor near the canvas BOTTOM: the bubble must be
    // shifted up to sit inside the CANVAS, not merely inside the window — this is the
    // load-bearing behavior (bounds.bottom, not window.innerHeight).
    const canvas = makeCanvas({ left: 300, top: 200, right: 700, bottom: 600, width: 400, height: 400 })
    const a = document.createElement('div')
    canvas.appendChild(a)
    mockRect(a, { left: 400, top: 500, right: 410, bottom: 510, width: 10, height: 10 })
    render(
      <PinBubble id="clamp" comment="hi" sent canSubmit replies={[]} resolved={false}
        anchorEl={a}
        onCommentChange={() => {}} onDelete={() => {}} onSubmit={() => {}}
        onReply={() => {}} onResolve={() => {}} onReopen={() => {}} />,
    )
    const bubble = screen.getByTestId('pin-bubble-clamp') as HTMLElement
    // BUBBLE_H=140, MARGIN=8 → clamped to the canvas bottom: 600-140-8=452. A window
    // clamp (innerHeight 768) would leave it at the anchor's top (500).
    expect(bubble.style.top).toBe('452px')
    expect(parseFloat(bubble.style.left)).toBeGreaterThanOrEqual(300) // within canvas
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
