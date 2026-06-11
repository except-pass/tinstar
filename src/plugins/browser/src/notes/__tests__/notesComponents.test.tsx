// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { NotesToolbar } from '../NotesToolbar'
import { NotesOverlay } from '../NotesOverlay'
import type { BrowserNote } from '../../../../../domain/types'

const note = (over: Partial<BrowserNote> = {}): BrowserNote => ({
  id: 'n1', url: 'http://x/', comment: 'hi', x: 100, y: 150, nx: 0.1, ny: 0.2, createdAt: 1, ...over,
})

const toolbarProps = {
  placing: false, unsentCount: 1, totalCount: 1, hasSession: true,
  submitting: false, submitError: null as string | null,
  onTogglePlacing: vi.fn(), onSubmit: vi.fn(), onClearAll: vi.fn(), accent: '#abc',
}

describe('NotesToolbar', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('submit is disabled without a session, with a hint', () => {
    render(<NotesToolbar {...toolbarProps} hasSession={false} />)
    const btn = screen.getByTestId('bw-notes-submit')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringContaining('Attach a session'))
  })

  it('submit is disabled with zero unsent notes', () => {
    render(<NotesToolbar {...toolbarProps} unsentCount={0} />)
    expect(screen.getByTestId('bw-notes-submit')).toBeDisabled()
  })

  it('shows the unsent count badge and fires onSubmit', () => {
    render(<NotesToolbar {...toolbarProps} unsentCount={3} />)
    expect(screen.getByTestId('bw-notes-unsent-badge')).toHaveTextContent('3')
    fireEvent.click(screen.getByTestId('bw-notes-submit'))
    expect(toolbarProps.onSubmit).toHaveBeenCalled()
  })

  it('clear-all requires a confirming second click within 2s', () => {
    const onClearAll = vi.fn()
    render(<NotesToolbar {...toolbarProps} onClearAll={onClearAll} />)
    fireEvent.click(screen.getByTestId('bw-notes-clear'))
    expect(onClearAll).not.toHaveBeenCalled()           // armed, not fired
    fireEvent.click(screen.getByTestId('bw-notes-clear'))
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })

  it('clear-all disarms after 2s', () => {
    const onClearAll = vi.fn()
    render(<NotesToolbar {...toolbarProps} onClearAll={onClearAll} />)
    fireEvent.click(screen.getByTestId('bw-notes-clear'))
    act(() => { vi.advanceTimersByTime(2100) })
    fireEvent.click(screen.getByTestId('bw-notes-clear'))
    expect(onClearAll).not.toHaveBeenCalled()           // re-armed instead
  })

  it('add-note button title reflects placing state', () => {
    const { rerender } = render(<NotesToolbar {...toolbarProps} placing={false} />)
    expect(screen.getByTestId('bw-notes-add')).toHaveAttribute('title', expect.stringContaining('Add note'))
    rerender(<NotesToolbar {...toolbarProps} placing={true} />)
    expect(screen.getByTestId('bw-notes-add')).toHaveAttribute('title', expect.stringContaining('Cancel'))
  })

  it('submit button is disabled when submitting is true', () => {
    render(<NotesToolbar {...toolbarProps} submitting={true} />)
    expect(screen.getByTestId('bw-notes-submit')).toBeDisabled()
  })

  it('clear-all button is absent when totalCount is 0', () => {
    render(<NotesToolbar {...toolbarProps} totalCount={0} />)
    expect(screen.queryByTestId('bw-notes-clear')).toBeNull()
  })

  it('shows the submit error', () => {
    render(<NotesToolbar {...toolbarProps} submitError="boom" />)
    expect(screen.getByTestId('bw-notes-error')).toHaveAttribute('title', expect.stringContaining('boom'))
  })
})

const overlayProps = {
  notes: [note()], scroll: { x: 0, y: 0 }, placing: false, accent: '#abc',
  onPlace: vi.fn(), onCommentChange: vi.fn(), onDelete: vi.fn(),
  openNoteId: null as string | null, onToggleOpen: vi.fn(),
}

describe('NotesOverlay', () => {
  it('renders a numbered pin at the note position minus scroll', () => {
    render(<NotesOverlay {...overlayProps} scroll={{ x: 10, y: 50 }} />)
    const pin = screen.getByTestId('bw-note-pin-n1')
    expect(pin).toHaveTextContent('1')
    expect(pin.parentElement!.style.left).toBe('90px')
    expect(pin.parentElement!.style.top).toBe('100px')
  })

  it('marks sent pins', () => {
    render(<NotesOverlay {...overlayProps} notes={[note({ sentAt: 9 })]} />)
    expect(screen.getByTestId('bw-note-pin-n1')).toHaveAttribute('data-sent', 'true')
  })

  it('clicking the placement layer reports viewport coords', () => {
    render(<NotesOverlay {...overlayProps} placing />)
    fireEvent.click(screen.getByTestId('bw-notes-placement-layer'), { clientX: 123, clientY: 45 })
    expect(overlayProps.onPlace).toHaveBeenCalledWith({ viewportX: 123, viewportY: 45 })
  })

  it('open unsent note shows an editable textarea that commits on blur', () => {
    render(<NotesOverlay {...overlayProps} openNoteId="n1" />)
    const ta = screen.getByTestId('bw-note-comment-n1')
    fireEvent.change(ta, { target: { value: 'new text' } })
    fireEvent.blur(ta)
    expect(overlayProps.onCommentChange).toHaveBeenCalledWith('n1', 'new text')
  })

  it('open sent note is read-only with no delete button', () => {
    render(<NotesOverlay {...overlayProps} notes={[note({ sentAt: 9 })]} openNoteId="n1" />)
    expect(screen.queryByTestId('bw-note-comment-n1')).toBeNull()
    expect(screen.queryByTestId('bw-note-delete-n1')).toBeNull()
    expect(screen.getByTestId('bw-note-popover-n1')).toHaveTextContent('hi')
  })

  it('delete button fires onDelete for unsent notes', () => {
    render(<NotesOverlay {...overlayProps} openNoteId="n1" />)
    fireEvent.click(screen.getByTestId('bw-note-delete-n1'))
    expect(overlayProps.onDelete).toHaveBeenCalledWith('n1')
  })
})
