// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InboxRow } from '../InboxRow'
import type { InboxRow as InboxRowData } from '../../hooks/useInbox'

const baseRow: InboxRowData = {
  widgetId: 'agent-build',
  source: 'plugin',
  widgetType: 'agent-build',
  sourceLabel: 'agent-build',
  attention: { level: 'urgent', reason: 'Build failed', setAt: new Date(Date.now() - 2 * 60_000).toISOString() },
  status: null,
  color: null,
  createdAt: null,
  readKey: 'agent-build:setAt',
  unread: true,
  taskPath: ['canvas-v5', 'build'],
  sessionName: 'agent-build',
  worktree: 'plugin-widget-spawn',
}

const runRow: InboxRowData = {
  widgetId: 'tailscale',
  source: 'run',
  widgetType: 'run',
  sourceLabel: 'tailscale',
  attention: null,
  status: 'idle',
  color: '#ff8800',
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  readKey: 'tailscale',
  unread: false,
  taskPath: ['canvas-v5'],
  sessionName: 'tailscale',
  worktree: 'wt',
}

const runAttentionRow: InboxRowData = {
  ...runRow,
  widgetId: 'tailscale-ready',
  sourceLabel: 'tailscale-ready',
  attention: { level: 'attention', reason: 'Ready for input', setAt: new Date(Date.now() - 60_000).toISOString() },
  readKey: 'tailscale-ready:setAt',
  unread: true,
  sessionName: 'tailscale-ready',
}

describe('InboxRow', () => {
  it('shows the name as the headline, plus task path / worktree', () => {
    render(<InboxRow row={baseRow} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByText('agent-build')).toBeInTheDocument()       // headline = name
    expect(screen.getByText(/canvas-v5/)).toBeInTheDocument()
    expect(screen.getByText(/plugin-widget-spawn/)).toBeInTheDocument()
  })

  it('surfaces the attention reason in the subline for plugin rows', () => {
    render(<InboxRow row={baseRow} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByText('Build failed')).toBeInTheDocument()
  })

  it('shows the session status as an upper-right dot (not the headline)', () => {
    render(<InboxRow row={runRow} onClick={() => {}} onClear={() => {}} />)
    // The run NAME is the headline...
    expect(screen.getByText('tailscale')).toBeInTheDocument()
    // ...and the status is conveyed by the dot's label/color, not visible text.
    const dot = screen.getByTestId('inbox-row-dot-tailscale')
    expect(dot).toHaveAttribute('aria-label', 'Idle')
    expect(dot.className).toMatch(/bg-accent-amber/)
    expect(screen.queryByText('Idle')).not.toBeInTheDocument()
  })

  it('surfaces run attention text when a run is waiting on the user', () => {
    render(<InboxRow row={runAttentionRow} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByText('Ready for input')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-row-dot-tailscale-ready')).toHaveAttribute('aria-label', 'Ready for input')
  })

  it('uses the attention level for the dot when there is no session status', () => {
    render(<InboxRow row={baseRow} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByTestId('inbox-row-dot-agent-build').className).toMatch(/bg-red-500/)
    render(<InboxRow row={{ ...baseRow, widgetId: 'x', attention: { ...baseRow.attention!, level: 'info' } }} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByTestId('inbox-row-dot-x').className).toMatch(/bg-slate-400/)
  })

  it('renders an avatar for run rows', () => {
    render(<InboxRow row={runRow} onClick={() => {}} onClear={() => {}} />)
    // AgentIcon renders either an <img> or the procedural-avatar placeholder span.
    const placeholder = screen.queryByTestId('agent-icon-placeholder')
    const img = document.querySelector('img')
    expect(placeholder || img).toBeTruthy()
  })

  it('unread rows render the name bolder than read rows', () => {
    const { rerender } = render(<InboxRow row={baseRow} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByText('agent-build').className).toMatch(/font-semibold/)
    rerender(<InboxRow row={{ ...baseRow, unread: false }} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByText('agent-build').className).not.toMatch(/font-semibold/)
  })

  it('highlights when selected', () => {
    const { rerender } = render(<InboxRow row={runRow} selected={false} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByTestId('inbox-row-tailscale')).not.toHaveAttribute('data-selected')
    rerender(<InboxRow row={runRow} selected onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByTestId('inbox-row-tailscale')).toHaveAttribute('data-selected', 'true')
  })

  it('clicking the row body calls onClick with widgetId', () => {
    const onClick = vi.fn()
    render(<InboxRow row={baseRow} onClick={onClick} onClear={() => {}} />)
    fireEvent.click(screen.getByTestId('inbox-row-agent-build'))
    expect(onClick).toHaveBeenCalledWith('agent-build')
  })

  it('shows a clear button only for rows with attention', () => {
    const { rerender } = render(<InboxRow row={baseRow} onClick={() => {}} onClear={() => {}} />)
    expect(screen.getByTestId('inbox-row-clear-agent-build')).toBeInTheDocument()
    rerender(<InboxRow row={runRow} onClick={() => {}} onClear={() => {}} />)
    expect(screen.queryByTestId('inbox-row-clear-tailscale')).not.toBeInTheDocument()
  })

  it('clicking the × calls onClear (stops row click)', () => {
    const onClick = vi.fn()
    const onClear = vi.fn()
    render(<InboxRow row={baseRow} onClick={onClick} onClear={onClear} />)
    fireEvent.click(screen.getByTestId('inbox-row-clear-agent-build'))
    expect(onClear).toHaveBeenCalledWith('agent-build')
    expect(onClick).not.toHaveBeenCalled()
  })
})
