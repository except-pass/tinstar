// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getPref, setPref, readJSON, writeJSON, familyKeys, migrateLegacyPrefs,
  getHiddenSlateSurfaces, addHiddenSlateSurface,
  getMinimizedSlateSurfaces, addMinimizedSlateSurface, removeMinimizedSlateSurface,
} from '../uiPrefs'

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
    expect(familyKeys.constellations('space-1')).toBe('tinstar-constellations-v1-space-1')
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

describe('minimized Slate surfaces family (S6 U3)', () => {
  const RUN = 'run-A'

  it('round-trips add / remove and stays a separate store from hidden', () => {
    expect([...getMinimizedSlateSurfaces(RUN)]).toEqual([])

    addMinimizedSlateSurface(RUN, 's1')
    addMinimizedSlateSurface(RUN, 's1') // idempotent
    addMinimizedSlateSurface(RUN, 's2')
    expect([...getMinimizedSlateSurfaces(RUN)]).toEqual(['s1', 's2'])
    expect(localStorage.getItem(familyKeys.minimizedSlateSurfaces))
      .toBe(JSON.stringify([`${RUN}\u001Fs1`, `${RUN}\u001Fs2`]))

    // Minimize and hide are DIFFERENT states in DIFFERENT keys — minimizing must
    // never hide, which is the whole point of the unit.
    addHiddenSlateSurface('s3')
    expect([...getMinimizedSlateSurfaces(RUN)]).toEqual(['s1', 's2'])
    expect([...getHiddenSlateSurfaces()]).toEqual(['s3'])
    expect(familyKeys.minimizedSlateSurfaces).not.toBe(familyKeys.hiddenSlateSurfaces)

    removeMinimizedSlateSurface(RUN, 's1')
    expect([...getMinimizedSlateSurfaces(RUN)]).toEqual(['s2'])
    removeMinimizedSlateSurface(RUN, 'nope') // no-op
    expect([...getMinimizedSlateSurfaces(RUN)]).toEqual(['s2'])
  })

  it('scopes by run — the same surface id on another run is untouched', () => {
    // Surface ids come from the author's file and the contract asks for a stable
    // slug, so `decisions` on run A and `decisions` on run B are DIFFERENT surfaces.
    // Minimizing one must not collapse the other on its next mount.
    addMinimizedSlateSurface('run-A', 'decisions')

    expect([...getMinimizedSlateSurfaces('run-A')]).toEqual(['decisions'])
    expect([...getMinimizedSlateSurfaces('run-B')]).toEqual([])

    addMinimizedSlateSurface('run-B', 'decisions')
    removeMinimizedSlateSurface('run-A', 'decisions')
    expect([...getMinimizedSlateSurfaces('run-A')]).toEqual([])
    expect([...getMinimizedSlateSurfaces('run-B')]).toEqual(['decisions'])
  })

  it('survives a malformed persisted value, and ignores legacy un-scoped entries', () => {
    localStorage.setItem(familyKeys.minimizedSlateSurfaces, '{"not":"an array"}')
    expect([...getMinimizedSlateSurfaces(RUN)]).toEqual([])
    localStorage.setItem(
      familyKeys.minimizedSlateSurfaces,
      JSON.stringify([`${RUN}\u001Fok`, 7, null, 'legacy-unscoped', `${RUN}\u001F`]),
    )
    expect([...getMinimizedSlateSurfaces(RUN)]).toEqual(['ok'])
  })
})
