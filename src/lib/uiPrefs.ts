// Single typed home for UI preferences stored in localStorage.
//
// Before this module, 10+ raw localStorage keys were scattered across 9
// components and hooks, contradicting the CLAUDE.md claim that the
// frontend only persists `tinstar-layouts-v3`. New rule: no raw
// localStorage.getItem/setItem outside this file. Layout-cache is the
// documented exception and lives in useWidgetLayouts.
//
// Storage shape:
// - Singletons (booleans, numbers, simple flags) are folded into ONE blob
//   at `tinstar-ui-prefs` so localStorage isn't littered with one key per
//   setting.
// - Per-id families (per-session prompt stash, per-space hotgroups, hidden
//   runs) keep their own keys — they're larger, more frequently updated,
//   and would hurt the singleton blob's read/write cost if merged. They
//   still route through this module's readJSON/writeJSON so the
//   "no raw localStorage" rule holds.

const PREFS_KEY = 'tinstar-ui-prefs'

export interface UiPrefs {
  hotkeysSidebarWidth?: number
  hotkeysSidebarCollapsed?: boolean
  hotkeysHeight?: number
  minimapVisible?: boolean
  hudVisible?: boolean
  canvasSidebarCollapsed?: boolean
  marshalVisible?: boolean
  noTasksNudgeDismissed?: boolean
}

function readAll(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as UiPrefs : {}
  } catch {
    return {}
  }
}

function writeAll(prefs: UiPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* quota or storage disabled — silent */
  }
}

export function getPref<K extends keyof UiPrefs>(key: K): UiPrefs[K] {
  return readAll()[key]
}

export function setPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void {
  const all = readAll()
  all[key] = value
  writeAll(all)
}

// Per-entity-id families
export const familyKeys = {
  promptStash: (sessionId: string): string => `tinstar-prompt-stash-v1:${sessionId}`,
  hotgroups: (spaceId: string): string => `tinstar-hotgroups-v2-${spaceId}`,
  hiddenRuns: 'tinstar-hidden-runs',
} as const

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const v = JSON.parse(raw)
    return v as T
  } catch {
    return fallback
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota or storage disabled — silent */
  }
}

// One-time legacy-key migration. Reads the 8 old singleton keys, folds them
// into the consolidated blob, then deletes the legacy entries. Idempotent.
const LEGACY_KEYS = {
  hotkeysSidebarWidth: 'tinstar-sidebar-hotkeys-width',
  hotkeysSidebarCollapsed: 'tinstar-sidebar-hotkeys-collapsed',
  hotkeysHeight: 'tinstar-sidebar-hotkeys-height',
  minimapVisible: 'tinstar-minimap-visible',
  hudVisible: 'tinstar-hud-visible',
  canvasSidebarCollapsed: 'tinstar-canvas-sidebar-collapsed',
  marshalVisible: 'tinstar-marshal-visible',
  noTasksNudgeDismissed: 'tinstar-no-tasks-nudge-dismissed',
} as const

function parseLegacyValue(raw: string, kind: 'number' | 'boolean'): number | boolean | undefined {
  if (kind === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  // legacy booleans were stored as String(boolean): 'true' | 'false'
  if (raw === 'true') return true
  if (raw === 'false') return false
  // noTasksNudgeDismissed used '1' as the dismissed marker
  if (raw === '1') return true
  return undefined
}

const LEGACY_KIND: Record<keyof typeof LEGACY_KEYS, 'number' | 'boolean'> = {
  hotkeysSidebarWidth: 'number',
  hotkeysSidebarCollapsed: 'boolean',
  hotkeysHeight: 'number',
  minimapVisible: 'boolean',
  hudVisible: 'boolean',
  canvasSidebarCollapsed: 'boolean',
  marshalVisible: 'boolean',
  noTasksNudgeDismissed: 'boolean',
}

export function migrateLegacyPrefs(): void {
  const current = readAll()
  let touched = false
  for (const [field, legacyKey] of Object.entries(LEGACY_KEYS) as Array<[keyof UiPrefs, string]>) {
    const raw = localStorage.getItem(legacyKey)
    if (raw === null) continue
    if (current[field] === undefined) {
      const parsed = parseLegacyValue(raw, LEGACY_KIND[field as keyof typeof LEGACY_KEYS])
      if (parsed !== undefined) {
        current[field] = parsed as never
        touched = true
      }
    }
    // Either way, clear the legacy key — the migration only runs once and
    // leaving the old key around is exactly the rot this module exists to
    // delete.
    localStorage.removeItem(legacyKey)
  }
  if (touched) writeAll(current)
}
