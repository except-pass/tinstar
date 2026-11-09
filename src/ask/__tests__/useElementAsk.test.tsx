import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { askElement } from '../element'
import { useElementAsk } from '../useElementAsk'
import { useAskGesture } from '../useAskGesture'
import type { AskSeed } from '../semantic'

const subject = { cardId: 'a'.repeat(32) }
function Harness({ open, itemAsk = vi.fn() }: { open: (seed: AskSeed) => void; itemAsk?: () => void }) {
  const root = useRef<HTMLDivElement>(null), affordance = useElementAsk(root, subject, open), swipe = useAskGesture(itemAsk)
  return <><div ref={root}><button ref={swipe.ref} type="button"><span {...askElement('next_check_in', 'Overdue 3d · Next check-in', 'Nov 6, 10:00 AM ET', 'overdue')}>Overdue 3d</span><span {...askElement('status')}>In progress</span></button></div>{affordance}<p>Outside card</p></>
}
const hold = (node: HTMLElement, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x = 100, y = 100, count = 1) => fireEvent[type](node, { touches: type === 'touchEnd' || type === 'touchCancel' ? [] : Array.from({ length: count }, () => ({ clientX: x, clientY: y })) })
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.useRealTimers() })
describe('shared element Ask gestures on the overdue badge', () => {
  it('reveals a layout-independent affordance on hover and captures the exact badge on click', () => {
    const open = vi.fn(); render(<Harness open={open} />)
    expect(screen.queryByRole('button', { name: /^Ask about/ })).toBeNull()
    fireEvent.mouseOver(screen.getByText('Overdue 3d'))
    fireEvent.click(screen.getByRole('button', { name: /^Ask about Overdue 3d/ }))
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ ...subject, element: { field_name: 'next_check_in', label: 'Overdue 3d · Next check-in', value: 'Nov 6, 10:00 AM ET', type: 'overdue' }, question: 'Why is this overdue?' }))
  })
  it('lets keyboard focus reach the affordance and preserves the ContextMenu shortcut', () => {
    const open = vi.fn(); render(<Harness open={open} />)
    const field = screen.getByText('Overdue 3d')
    act(() => field.focus())
    fireEvent.keyDown(field, { key: 'Tab' })
    expect(screen.getByRole('button', { name: /^Ask about Overdue 3d/ })).toHaveFocus()
    fireEvent.click(document.activeElement!)
    fireEvent.keyDown(field, { key: 'F10', shiftKey: true })
    expect(open).toHaveBeenCalledTimes(2)
  })
  it('opens on a stationary long-press once and cancels the item swipe and synthetic click', () => {
    vi.useFakeTimers(); const open = vi.fn(), itemAsk = vi.fn(); render(<Harness open={open} itemAsk={itemAsk} />)
    const field = screen.getByText('Overdue 3d'), click = vi.fn(); field.parentElement!.addEventListener('click', click)
    hold(field, 'touchStart'); act(() => vi.advanceTimersByTime(550))
    expect(open).toHaveBeenCalledOnce()
    hold(field, 'touchMove', 20); hold(field, 'touchEnd', 20); fireEvent.click(field); fireEvent.contextMenu(field)
    expect(open).toHaveBeenCalledOnce(); expect(itemAsk).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled()
  })
  it.each(['vertical scroll', 'swipe', 'cancel', 'multitouch', 'scroll event'])('cancels long-press on %s', kind => {
    vi.useFakeTimers(); const open = vi.fn(); render(<Harness open={open} />)
    const field = screen.getByText('Overdue 3d'); hold(field, 'touchStart')
    if (kind === 'vertical scroll') hold(field, 'touchMove', 100, 125)
    if (kind === 'swipe') hold(field, 'touchMove', 30, 100)
    if (kind === 'cancel') hold(field, 'touchCancel')
    if (kind === 'multitouch') hold(field, 'touchStart', 100, 100, 2)
    if (kind === 'scroll event') fireEvent.scroll(window)
    act(() => vi.advanceTimersByTime(600)); expect(open).not.toHaveBeenCalled()
  })
  it('offers Ask about this only for text selected inside this card', () => {
    const open = vi.fn(); render(<Harness open={open} />)
    const select = (from: Node, to = from) => {
      const range = document.createRange(); range.setStart(from, 0); range.setEnd(to, to.textContent!.length)
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
      fireEvent(document, new Event('selectionchange'))
    }
    select(screen.getByText('Outside card').firstChild!)
    expect(screen.queryByRole('button', { name: 'Ask about this' })).toBeNull()
    select(screen.getByText('Overdue 3d').firstChild!)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ element: expect.objectContaining({ field_name: 'next_check_in', value: 'Overdue 3d' }) }))
    select(screen.getByText('Overdue 3d').firstChild!, screen.getByText('Outside card').firstChild!)
    expect(screen.queryByRole('button', { name: 'Ask about this' })).toBeNull()
  })
})

it('keeps unmarked action controls inside a marked block native', () => {
  const open = vi.fn()
  function Block() {
    const root = useRef<HTMLDivElement>(null), affordance = useElementAsk(root, subject, open)
    return <><div ref={root} {...askElement('receipt')}><a href="https://example.test/receipt">Read receipt</a><input aria-label="Native input" /></div>{affordance}</>
  }
  render(<Block />)
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  fireEvent(screen.getByRole('link'), event)
  fireEvent.mouseOver(screen.getByRole('textbox'))
  expect(event.defaultPrevented).toBe(false); expect(open).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /^Ask about/ })).toBeNull()
})
