// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { getInboxReadKeys, markInboxRead, markInboxUnread, getSidebarView, setSidebarView } from '../uiPrefs'

beforeEach(() => localStorage.clear())

describe('inbox uiPrefs', () => {
  it('getInboxReadKeys returns empty Set by default', () => {
    expect(getInboxReadKeys().size).toBe(0)
  })

  it('markInboxRead adds key and persists', () => {
    markInboxRead('pw-1:2026-05-27T00:00:00.000Z')
    expect(getInboxReadKeys().has('pw-1:2026-05-27T00:00:00.000Z')).toBe(true)
  })

  it('markInboxUnread removes key', () => {
    markInboxRead('pw-1:t1')
    markInboxUnread('pw-1:t1')
    expect(getInboxReadKeys().has('pw-1:t1')).toBe(false)
  })

  it('read-key cap trims to 5000 most-recent', () => {
    for (let i = 0; i < 5100; i++) markInboxRead(`pw-${i}:t${i}`)
    const keys = getInboxReadKeys()
    expect(keys.size).toBe(5000)
    // The most-recent ones should be retained (last 5000)
    expect(keys.has('pw-5099:t5099')).toBe(true)
    expect(keys.has('pw-0:t0')).toBe(false)
  })

  it('sidebar view is per-space, defaults to hierarchy', () => {
    expect(getSidebarView('spc-1')).toBe('hierarchy')
    setSidebarView('spc-1', 'inbox')
    setSidebarView('spc-2', 'hierarchy')
    expect(getSidebarView('spc-1')).toBe('inbox')
    expect(getSidebarView('spc-2')).toBe('hierarchy')
  })
})
