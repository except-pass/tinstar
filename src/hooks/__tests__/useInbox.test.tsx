// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useInbox } from '../useInbox'

let mockState: any = { pluginWidgets: [], runs: [] }
vi.mock('../useServerEvents', () => ({
  useServerEvents: () => ({ state: mockState, connected: true, loading: false }),
}))

let mockReadKeys = new Set<string>()
vi.mock('../../lib/uiPrefs', () => ({
  getInboxReadKeys: () => mockReadKeys,
}))

const attn = (level: any, reason: string, setAt: string) => ({ level, reason, setAt })

beforeEach(() => {
  mockReadKeys = new Set()
})

describe('useInbox', () => {
  it('returns empty when no active space', () => {
    const { result } = renderHook(() => useInbox(null))
    expect(result.current.rows).toHaveLength(0)
    expect(result.current.unreadCount).toBe(0)
  })

  it('only surfaces plugin widgets that have attention in the active space', () => {
    mockState = {
      pluginWidgets: [
        { id: 'pw-1', spaceId: 'spc-1', widgetType: 'w', attention: attn('info', 'r', '2026-05-27T00:00:00.000Z') },
        { id: 'pw-2', spaceId: 'spc-2', widgetType: 'w', attention: attn('info', 'r', '2026-05-27T00:00:00.000Z') },
        { id: 'pw-3', spaceId: 'spc-1', widgetType: 'w' },                  // no attention
      ],
      runs: [],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]?.widgetId).toBe('pw-1')
  })

  it('shows every session in the space, even without attention', () => {
    mockState = {
      pluginWidgets: [],
      runs: [
        { id: 'r-idle', spaceId: 'spc-1', status: 'idle', sessionId: 's1', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-05-27T00:00:00.000Z' },
        { id: 'r-other', spaceId: 'spc-2', status: 'running', sessionId: 's2', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-05-27T00:00:00.000Z' },
      ],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]?.widgetId).toBe('r-idle')
    expect(result.current.rows[0]?.attention).toBeNull()
    expect(result.current.rows[0]?.status).toBe('idle')
    expect(result.current.rows[0]?.unread).toBe(false)
    expect(result.current.unreadCount).toBe(0)
  })

  it('sorts attention sessions above attention-free ones', () => {
    mockState = {
      pluginWidgets: [],
      runs: [
        { id: 'r-idle', spaceId: 'spc-1', status: 'idle', sessionId: 's1', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-05-27T00:09:00.000Z' },
        { id: 'r-urgent', spaceId: 'spc-1', status: 'needs_attention', sessionId: 's2', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-05-27T00:01:00.000Z', attention: attn('urgent', 'help', '2026-05-27T00:01:00.000Z') },
      ],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows.map(r => r.widgetId)).toEqual(['r-urgent', 'r-idle'])
    expect(result.current.unreadCount).toBe(1)
  })

  it('sorts attention-free sessions by createdAt descending', () => {
    mockState = {
      pluginWidgets: [],
      runs: [
        { id: 'r-old', spaceId: 'spc-1', status: 'idle', sessionId: 's1', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-05-27T00:01:00.000Z' },
        { id: 'r-new', spaceId: 'spc-1', status: 'running', sessionId: 's2', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-05-27T00:09:00.000Z' },
      ],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows.map(r => r.widgetId)).toEqual(['r-new', 'r-old'])
  })

  it('sorts urgent before attention before info, then by setAt desc', () => {
    mockState = {
      pluginWidgets: [
        { id: 'pw-info', spaceId: 'spc-1', widgetType: 'w', attention: attn('info', 'r', '2026-05-27T00:02:00.000Z') },
        { id: 'pw-urgent', spaceId: 'spc-1', widgetType: 'w', attention: attn('urgent', 'r', '2026-05-27T00:00:00.000Z') },
        { id: 'pw-attn', spaceId: 'spc-1', widgetType: 'w', attention: attn('attention', 'r', '2026-05-27T00:01:00.000Z') },
      ],
      runs: [],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows.map(r => r.attention?.level)).toEqual(['urgent', 'attention', 'info'])
  })

  it('within same level, sorts by setAt descending', () => {
    mockState = {
      pluginWidgets: [
        { id: 'pw-a', spaceId: 'spc-1', widgetType: 'w', attention: attn('info', 'a', '2026-05-27T00:01:00.000Z') },
        { id: 'pw-b', spaceId: 'spc-1', widgetType: 'w', attention: attn('info', 'b', '2026-05-27T00:02:00.000Z') },
      ],
      runs: [],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows.map(r => r.widgetId)).toEqual(['pw-b', 'pw-a'])
  })

  it('marks rows in readKeys as read', () => {
    const setAt = '2026-05-27T00:00:00.000Z'
    mockState = {
      pluginWidgets: [{ id: 'pw-1', spaceId: 'spc-1', widgetType: 'w', attention: attn('info', 'r', setAt) }],
      runs: [],
    }
    mockReadKeys = new Set([`pw-1:${setAt}`])
    const { result } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows[0]?.unread).toBe(false)
    expect(result.current.unreadCount).toBe(0)
  })

  it('produces no passive row for a background run without attention (R6)', () => {
    mockState = {
      pluginWidgets: [],
      runs: [
        { id: 'r-bg', spaceId: 'spc-1', status: 'idle', background: true, sessionId: 's1', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-07-02T00:00:00.000Z' },
        { id: 'r-fg', spaceId: 'spc-1', status: 'idle', background: false, sessionId: 's2', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-07-02T00:01:00.000Z' },
      ],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    // Non-background runs are unaffected; the background run is skipped.
    expect(result.current.rows.map(r => r.widgetId)).toEqual(['r-fg'])
  })

  it('breaks a background run through when attention is pending, sorted by level (R11/R16)', () => {
    mockState = {
      pluginWidgets: [],
      runs: [
        { id: 'r-bg-urgent', spaceId: 'spc-1', status: 'idle', background: true, sessionId: 's1', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-07-02T00:00:00.000Z', attention: attn('urgent', 'Waiting on permission', '2026-07-02T00:02:00.000Z') },
        { id: 'r-fg-info', spaceId: 'spc-1', status: 'stopped', background: false, sessionId: 's2', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-07-02T00:01:00.000Z', attention: attn('info', 'Run stopped', '2026-07-02T00:03:00.000Z') },
        { id: 'r-fg-idle', spaceId: 'spc-1', status: 'idle', background: false, sessionId: 's3', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-07-02T00:04:00.000Z' },
      ],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    // Urgent background breakthrough sorts above the info row; the passive
    // non-background row lists below both.
    expect(result.current.rows.map(r => r.widgetId)).toEqual(['r-bg-urgent', 'r-fg-info', 'r-fg-idle'])
    expect(result.current.rows[0]?.attention?.level).toBe('urgent')
    expect(result.current.rows[0]?.unread).toBe(true)
  })

  it('drops the background run row again once attention clears (R16)', () => {
    const bgRun = { id: 'r-bg', spaceId: 'spc-1', status: 'idle', background: true, sessionId: 's1', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', createdAt: '2026-07-02T00:00:00.000Z' }
    mockState = { pluginWidgets: [], runs: [{ ...bgRun, attention: attn('urgent', 'Waiting on permission', '2026-07-02T00:02:00.000Z') }] }
    const { result, rerender } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows).toHaveLength(1)

    mockState = { pluginWidgets: [], runs: [{ ...bgRun }] } // attention cleared
    rerender()
    expect(result.current.rows).toHaveLength(0)
    expect(result.current.unreadCount).toBe(0)
  })

  it('merges plugin-widget + run attention', () => {
    mockState = {
      pluginWidgets: [{ id: 'pw-1', spaceId: 'spc-1', widgetType: 'w', attention: attn('attention', 'r', '2026-05-27T00:00:00.000Z') }],
      runs: [{ id: 'r-1', spaceId: 'spc-1', sessionId: 's1', initiative: 'i', epic: 'e', task: 't', worktree: 'wt', attention: attn('urgent', 'r', '2026-05-27T00:00:00.000Z') }],
    }
    const { result } = renderHook(() => useInbox('spc-1'))
    expect(result.current.rows).toHaveLength(2)
    expect(result.current.rows[0]?.source).toBe('run')      // urgent first
    expect(result.current.rows[0]?.taskPath).toEqual(['i', 'e', 't'])
    expect(result.current.rows[0]?.worktree).toBe('wt')
  })
})
