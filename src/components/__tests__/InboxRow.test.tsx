// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InboxRow } from '../InboxRow'
import type { InboxRow as InboxRowData } from '../../hooks/useInbox'

const baseRow: InboxRowData = {
  widgetId: 'pw-1',
  source: 'plugin',
  widgetType: 'agent-build',
  sourceLabel: 'agent-build',
  attention: { level: 'urgent', reason: 'Build failed', setAt: new Date(Date.now() - 2 * 60_000).toISOString() },
  unread: true,
  taskPath: ['canvas-v5', 'build'],
  sessionName: 'agent-build',
  worktree: 'plugin-widget-spawn',
}

describe('InboxRow', () => {
  it('renders headline + task path + session + worktree', () => {
    render(<InboxRow row={baseRow} onClick={() => {}} onClear={() => {}} onToggleRead={() => {}} />)
    expect(screen.getByText('Build failed')).toBeInTheDocument()
    expect(screen.getByText(/canvas-v5/)).toBeInTheDocument()
    expect(screen.getByText(/agent-build/)).toBeInTheDocument()
    expect(screen.getByText(/plugin-widget-spawn/)).toBeInTheDocument()
  })

  it('urgent unread row has filled red dot', () => {
    render(<InboxRow row={baseRow} onClick={() => {}} onClear={() => {}} onToggleRead={() => {}} />)
    const dot = screen.getByTestId('inbox-row-dot-pw-1')
    expect(dot.className).toMatch(/bg-red-500/)
  })

  it('read row has hollow dot and reduced opacity', () => {
    render(<InboxRow row={{ ...baseRow, unread: false }} onClick={() => {}} onClear={() => {}} onToggleRead={() => {}} />)
    const dot = screen.getByTestId('inbox-row-dot-pw-1')
    expect(dot.className).toMatch(/border/)
  })

  it('info level uses slate tone', () => {
    render(<InboxRow row={{ ...baseRow, attention: { ...baseRow.attention, level: 'info' } }} onClick={() => {}} onClear={() => {}} onToggleRead={() => {}} />)
    const dot = screen.getByTestId('inbox-row-dot-pw-1')
    expect(dot.className).toMatch(/bg-slate-400/)
  })

  it('clicking the row body calls onClick with widgetId', () => {
    const onClick = vi.fn()
    render(<InboxRow row={baseRow} onClick={onClick} onClear={() => {}} onToggleRead={() => {}} />)
    fireEvent.click(screen.getByTestId('inbox-row-pw-1'))
    expect(onClick).toHaveBeenCalledWith('pw-1')
  })

  it('clicking the dot toggles read (stops row click)', () => {
    const onClick = vi.fn()
    const onToggleRead = vi.fn()
    render(<InboxRow row={baseRow} onClick={onClick} onClear={() => {}} onToggleRead={onToggleRead} />)
    fireEvent.click(screen.getByTestId('inbox-row-dot-pw-1'))
    expect(onToggleRead).toHaveBeenCalledWith('pw-1')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('clicking the × calls onClear (stops row click)', () => {
    const onClick = vi.fn()
    const onClear = vi.fn()
    render(<InboxRow row={baseRow} onClick={onClick} onClear={onClear} onToggleRead={() => {}} />)
    fireEvent.click(screen.getByTestId('inbox-row-clear-pw-1'))
    expect(onClear).toHaveBeenCalledWith('pw-1')
    expect(onClick).not.toHaveBeenCalled()
  })
})
