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
// - Per-id families (per-session prompt stash, per-space constellations, hidden
//   runs) keep their own keys — they're larger, more frequently updated,
//   and would hurt the singleton blob's read/write cost if merged. They
//   still route through this module's readJSON/writeJSON so the
//   "no raw localStorage" rule holds.

const PREFS_KEY = 'tinstar-ui-prefs'

/** localStorage key for the singleton prefs blob — exported for cross-tab
 *  `storage`-event listeners (mirrors familyKeys for the per-id families). */
export const PREFS_STORAGE_KEY = PREFS_KEY

export interface UiPrefs {
  hotkeysSidebarWidth?: number
  hotkeysSidebarCollapsed?: boolean
  hotkeysHeight?: number
  widgetsPaletteHeight?: number
  minimapVisible?: boolean
  hudVisible?: boolean
  canvasSidebarCollapsed?: boolean
  marshalVisible?: boolean
  noTasksNudgeDismissed?: boolean
  /** Reveal background sessions on the canvas/sidebar/cycling (R8–R10).
   *  Per-browser view preference — never changes a session's `background`
   *  property. Default false (background sessions hidden). */
  showBackgroundSessions?: boolean
  sidebarViewBySpace?: Record<string, 'hierarchy' | 'inbox'>
  inboxReadKeys?: string[]
  /** Persisted width (px) of a run card's Slate column (Slate v2 U1/R1).
   *  Per-browser view preference; restored on mount, written on drag end. */
  slateWidth?: number
  /** Per-browser: telemetry panel manually collapsed in the run workspace, so the
   *  Slate can reclaim the right side. Default false (shown). */
  telemetryCollapsed?: boolean
  /** Per-browser: keep the Slate column open even with zero surfaces, so it can be
   *  opened blank and filled via Explain / + Add surface. Default false. */
  slateOpen?: boolean
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
  // constellations: V5 rename of the legacy `hotgroups` family. Storage version reset to v1
  // since the schema is unchanged but the key is new — pre-V5 data is intentionally not migrated.
  constellations: (spaceId: string): string => `tinstar-constellations-v1-${spaceId}`,
  hiddenRuns: 'tinstar-hidden-runs',
  // Slate v2 (U2/R4): per-browser set of hidden Slate surface ids. A hide is a
  // non-destructive VIEW preference — the agent's file stays intact and a file
  // re-projection can't resurrect a hidden surface (the filter reads this set on
  // every render). Mirrors `hiddenRuns`.
  hiddenSlateSurfaces: 'tinstar-hidden-slate-surfaces',
  // S6 U3: per-browser set of MINIMIZED Slate surfaces, stored as RUN-SCOPED keys
  // (`<runId>\u001F<surfaceId>`). Distinct from hidden — a minimized surface keeps
  // its slot and its title bar (with a restore control); a hidden one leaves the view
  // entirely. Same non-destructive view-preference contract.
  //
  // The run scope is load-bearing and mirrors the server store's own composite key
  // (`SlateStore.k`): a surface id is only unique WITHIN a run, and the author
  // contract asks agents for a stable slug, so the generic ids they reach for
  // (`decisions`, `blockers`, `session-arc`) collide across runs by design.
  // Minimizing `decisions` on one run must not collapse `decisions` on every other.
  // NOTE: `hiddenSlateSurfaces` above still has the un-scoped shape and should follow;
  // changing it is a data migration, so it's deliberately left for its own change.
  minimizedSlateSurfaces: 'tinstar-minimized-slate-surfaces',
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

// --- Inbox view prefs ---

const INBOX_READ_KEYS_CAP = 5000

export function getSidebarView(spaceId: string): 'hierarchy' | 'inbox' {
  const map = getPref('sidebarViewBySpace') ?? {}
  return map[spaceId] ?? 'hierarchy'
}

export function setSidebarView(spaceId: string, view: 'hierarchy' | 'inbox'): void {
  const map = getPref('sidebarViewBySpace') ?? {}
  setPref('sidebarViewBySpace', { ...map, [spaceId]: view })
}

export function getInboxReadKeys(): Set<string> {
  return new Set(getPref('inboxReadKeys') ?? [])
}

export function markInboxRead(key: string): void {
  const list = getPref('inboxReadKeys') ?? []
  // Move-to-end semantics: if already present, dedupe first
  const filtered = list.filter(k => k !== key)
  filtered.push(key)
  const trimmed = filtered.length > INBOX_READ_KEYS_CAP
    ? filtered.slice(filtered.length - INBOX_READ_KEYS_CAP)
    : filtered
  setPref('inboxReadKeys', trimmed)
}

export function markInboxUnread(key: string): void {
  const list = getPref('inboxReadKeys') ?? []
  setPref('inboxReadKeys', list.filter(k => k !== key))
}

// --- Hidden Slate surfaces (Slate v2 U2/R4) ---
//
// A per-browser view preference mirroring the `hiddenRuns` family: hiding a
// surface is non-destructive (no server route, no file unlink) and survives a
// file re-projection because the filter reads this set on every render. Stored
// as a JSON array of surface ids; exposed as a Set for O(1) membership tests.

export function getHiddenSlateSurfaces(): Set<string> {
  const arr = readJSON<string[]>(familyKeys.hiddenSlateSurfaces, [])
  if (!Array.isArray(arr)) return new Set()
  return new Set(arr.filter((v): v is string => typeof v === 'string'))
}

export function addHiddenSlateSurface(id: string): void {
  const ids = getHiddenSlateSurfaces()
  if (ids.has(id)) return
  ids.add(id)
  writeJSON(familyKeys.hiddenSlateSurfaces, [...ids])
}

export function removeHiddenSlateSurface(id: string): void {
  const ids = getHiddenSlateSurfaces()
  if (!ids.delete(id)) return
  writeJSON(familyKeys.hiddenSlateSurfaces, [...ids])
}

// --- Minimized Slate surfaces (S6 U3) ---
//
// The same per-browser, non-destructive view preference as the hidden set, for a
// DIFFERENT state: a minimized surface collapses to just its title bar and keeps
// its slot (with a restore control); a hidden surface leaves the view. A surface
// can be neither, minimized, or hidden — hide wins if somehow both.
//
// Keyed by (runId, surfaceId), because a surface id is only unique within a run —
// see the note on `familyKeys.minimizedSlateSurfaces`. The joiner is a unit-separator
// (U+001F), which can't appear in a runId (a tmux session name) or an author's slug,
// so the split is unambiguous. Written as a JS escape, never a raw control byte.
const MINIMIZED_JOINER = '\u001F'

function minimizedKey(runId: string, id: string): string {
  return runId + MINIMIZED_JOINER + id
}

/** The minimized surface ids for ONE run. Entries from other runs (and legacy
 *  un-scoped entries written before the key gained a run) are ignored, so a stale
 *  set can never collapse a surface the user never touched. */
export function getMinimizedSlateSurfaces(runId: string): Set<string> {
  const arr = readJSON<string[]>(familyKeys.minimizedSlateSurfaces, [])
  if (!Array.isArray(arr)) return new Set()
  const prefix = runId + MINIMIZED_JOINER
  const out = new Set<string>()
  for (const v of arr) {
    if (typeof v !== 'string' || !v.startsWith(prefix)) continue
    const id = v.slice(prefix.length)
    if (id) out.add(id)
  }
  return out
}

/** Every stored key, including other runs' — the read/modify/write basis. */
function allMinimizedKeys(): Set<string> {
  const arr = readJSON<string[]>(familyKeys.minimizedSlateSurfaces, [])
  if (!Array.isArray(arr)) return new Set()
  return new Set(arr.filter((v): v is string => typeof v === 'string'))
}

export function addMinimizedSlateSurface(runId: string, id: string): void {
  const keys = allMinimizedKeys()
  const key = minimizedKey(runId, id)
  if (keys.has(key)) return
  keys.add(key)
  writeJSON(familyKeys.minimizedSlateSurfaces, [...keys])
}

export function removeMinimizedSlateSurface(runId: string, id: string): void {
  const keys = allMinimizedKeys()
  if (!keys.delete(minimizedKey(runId, id))) return
  writeJSON(familyKeys.minimizedSlateSurfaces, [...keys])
}
