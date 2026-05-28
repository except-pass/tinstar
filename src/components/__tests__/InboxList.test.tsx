// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InboxList } from '../InboxList'

const fixtures: any[] = []

vi.mock('../../hooks/useInbox', () => ({
  useInbox: () => ({ rows: fixtures, unreadCount: fixtures.filter(r => r.unread).length }),
}))

vi.mock('../../lib/uiPrefs', () => ({
  markInboxRead: vi.fn(),
  markInboxUnread: vi.fn(),
}))

let selectedId: string | null = null
vi.mock('../SelectionProvider', () => ({
  useSelection: () => ({ isSelected: (id: string) => id === selectedId }),
}))

vi.mock('../../apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../../canvas/flashAndFocus', () => ({
  dispatchFlashFocus: vi.fn(),
}))

beforeEach(() => {
  fixtures.length = 0
  selectedId = null
})

function row(overrides: Partial<any> = {}) {
  return {
    widgetId: 'pw-1', source: 'plugin', widgetType: 'w', sourceLabel: 'w',
    attention: { level: 'info', reason: 'r', setAt: '2026-05-27T00:00:00.000Z' },
    status: null, color: null, createdAt: null, readKey: 'pw-1:2026-05-27T00:00:00.000Z',
    unread: true, taskPath: [], sessionName: null, worktree: null,
    ...overrides,
  }
}

// Match the row container only — not nested elements like inbox-row-dot-* or inbox-row-clear-*.
const ROW_RE = /^inbox-row-(?!dot-|clear-)/

describe('InboxList', () => {
  it('renders all rows when filter is all', () => {
    fixtures.push(row({ widgetId: 'a' }), row({ widgetId: 'b' }), row({ widgetId: 'c' }))
    render(<InboxList activeSpaceId="spc-1" />)
    expect(screen.getAllByTestId(ROW_RE)).toHaveLength(3)
  })

  it('level filter chip filters rows', () => {
    fixtures.push(
      row({ widgetId: 'a', attention: { level: 'urgent', reason: 'r', setAt: 't' } }),
      row({ widgetId: 'b', attention: { level: 'info', reason: 'r', setAt: 't' } }),
    )
    render(<InboxList activeSpaceId="spc-1" />)
    fireEvent.click(screen.getByTestId('inbox-filter-urgent'))
    expect(screen.getAllByTestId(ROW_RE)).toHaveLength(1)
  })

  it('shows attention-free sessions under "all" but hides them under a level filter', () => {
    fixtures.push(
      row({ widgetId: 'a', attention: { level: 'urgent', reason: 'r', setAt: 't' } }),
      row({ widgetId: 'b', source: 'run', attention: null, status: 'idle', unread: false, readKey: 'b' }),
    )
    render(<InboxList activeSpaceId="spc-1" />)
    expect(screen.getAllByTestId(ROW_RE)).toHaveLength(2)
    fireEvent.click(screen.getByTestId('inbox-filter-urgent'))
    expect(screen.getAllByTestId(ROW_RE)).toHaveLength(1)
  })

  it('unread-only toggle filters out read rows', () => {
    fixtures.push(row({ widgetId: 'a', unread: false }), row({ widgetId: 'b', unread: true }))
    render(<InboxList activeSpaceId="spc-1" />)
    fireEvent.click(screen.getByTestId('inbox-filter-unread-only'))
    expect(screen.getAllByTestId(ROW_RE)).toHaveLength(1)
  })

  it('searchQuery filters by reason text', () => {
    fixtures.push(
      row({ widgetId: 'a', attention: { level: 'info', reason: 'Build failed', setAt: 't' } }),
      row({ widgetId: 'b', attention: { level: 'info', reason: 'All green', setAt: 't' } }),
    )
    render(<InboxList activeSpaceId="spc-1" searchQuery="build" />)
    expect(screen.getAllByTestId(ROW_RE)).toHaveLength(1)
  })

  it('renders empty state when no rows match', () => {
    render(<InboxList activeSpaceId="spc-1" searchQuery="nomatch-xyz" />)
    expect(screen.getByTestId('inbox-empty')).toBeInTheDocument()
  })

  it('highlights the row whose canvas widget is selected', () => {
    selectedId = 'run-tailscale'
    fixtures.push(
      row({ widgetId: 'tailscale', source: 'run', sourceLabel: 'tailscale', status: 'idle', attention: null }),
      row({ widgetId: 'other', source: 'run', sourceLabel: 'other', status: 'idle', attention: null }),
    )
    render(<InboxList activeSpaceId="spc-1" />)
    expect(screen.getByTestId('inbox-row-tailscale')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('inbox-row-other')).not.toHaveAttribute('data-selected')
  })

  it('clicking a row dispatches flash-focus', async () => {
    fixtures.push(row({ widgetId: 'pw-1', source: 'plugin' }))
    const { dispatchFlashFocus } = await import('../../canvas/flashAndFocus')
    render(<InboxList activeSpaceId="spc-1" />)
    fireEvent.click(screen.getByTestId('inbox-row-pw-1'))
    expect(dispatchFlashFocus).toHaveBeenCalledWith({ widgetId: 'pw-1', source: 'plugin' })
  })
})
