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

  it('only returns widgets with attention in the active space', () => {
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
    expect(result.current.rows.map(r => r.attention.level)).toEqual(['urgent', 'attention', 'info'])
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
