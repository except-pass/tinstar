// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { getPref, setPref, readJSON, writeJSON, familyKeys, migrateLegacyPrefs } from '../uiPrefs'

beforeEach(() => {
  localStorage.clear()
})

describe('uiPrefs singletons', () => {
  it('round-trips a single field', () => {
    setPref('hudVisible', true)
    expect(getPref('hudVisible')).toBe(true)
  })

  it('persists multiple fields into a single blob', () => {
    setPref('hudVisible', false)
    setPref('hotkeysSidebarWidth', 420)
    expect(getPref('hudVisible')).toBe(false)
    expect(getPref('hotkeysSidebarWidth')).toBe(420)
    // Only one localStorage key for all singletons
    expect(localStorage.getItem('tinstar-ui-prefs')).not.toBeNull()
  })

  it('returns undefined for unset fields', () => {
    expect(getPref('hudVisible')).toBeUndefined()
  })
})

describe('uiPrefs JSON helpers', () => {
  it('readJSON returns fallback for missing key', () => {
    expect(readJSON('does-not-exist', [])).toEqual([])
  })

  it('round-trips an object', () => {
    writeJSON('any-key', { a: 1, b: 'x' })
    expect(readJSON('any-key', null)).toEqual({ a: 1, b: 'x' })
  })

  it('readJSON returns fallback on corrupt JSON', () => {
    localStorage.setItem('corrupt', '{ not json')
    expect(readJSON('corrupt', { ok: false })).toEqual({ ok: false })
  })
})

describe('familyKeys', () => {
  it('builds stable per-id keys', () => {
    expect(familyKeys.promptStash('demo')).toBe('tinstar-prompt-stash-v1:demo')
    expect(familyKeys.hotgroups('space-1')).toBe('tinstar-hotgroups-v2-space-1')
    expect(familyKeys.hiddenRuns).toBe('tinstar-hidden-runs')
  })
})

describe('migrateLegacyPrefs', () => {
  it('folds legacy singleton keys into the consolidated blob and deletes them', () => {
    localStorage.setItem('tinstar-hud-visible', 'false')
    localStorage.setItem('tinstar-sidebar-hotkeys-width', '420')
    localStorage.setItem('tinstar-no-tasks-nudge-dismissed', '1')

    migrateLegacyPrefs()

    expect(getPref('hudVisible')).toBe(false)
    expect(getPref('hotkeysSidebarWidth')).toBe(420)
    expect(getPref('noTasksNudgeDismissed')).toBe(true)
    // Legacy keys removed
    expect(localStorage.getItem('tinstar-hud-visible')).toBeNull()
    expect(localStorage.getItem('tinstar-sidebar-hotkeys-width')).toBeNull()
    expect(localStorage.getItem('tinstar-no-tasks-nudge-dismissed')).toBeNull()
  })

  it('is idempotent — does not overwrite existing consolidated values', () => {
    setPref('hudVisible', true)
    localStorage.setItem('tinstar-hud-visible', 'false')
    migrateLegacyPrefs()
    expect(getPref('hudVisible')).toBe(true)
    expect(localStorage.getItem('tinstar-hud-visible')).toBeNull()
  })

  it('handles malformed legacy values by skipping them', () => {
    localStorage.setItem('tinstar-sidebar-hotkeys-width', 'not-a-number')
    migrateLegacyPrefs()
    expect(getPref('hotkeysSidebarWidth')).toBeUndefined()
    expect(localStorage.getItem('tinstar-sidebar-hotkeys-width')).toBeNull()
  })
})
