# Entity Labels — Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

Users can rename and re-icon their hierarchy levels (currently hardcoded as Initiative → Epic → Task) and control how many levels are active (1–3). Configuration is per-space and persisted on the Space record. No data migration is required — labels are display-only.

**Example:** A team using "Client → Project → Ticket" renames all three levels and saves. The sidebar, canvas container headers, GroupingControls, and entity creation dialogs all reflect the new names immediately.

---

## Scope

This spec covers **Tier 1 + constrained Tier 2** from the broader generic-entities design brief (`docs/design-generic-entities.md`):

- Rename label, plural, and icon for each active level
- Add or remove levels (1–3 cap; removing reduces from the top, leaf level is fixed)
- Per-space configuration
- No changes to internal entity type IDs, FK fields, API routes, or data model

Tier 3 (fully generic entity model) is out of scope.

---

## Data Model

### Space record extension

```ts
interface Space {
  id: string
  name: string
  // existing fields...
  labelConfig?: SpaceLabelConfig
}

interface SpaceLabelConfig {
  levels: LevelLabel[]  // length 1–3, ordered top-to-bottom
}

interface LevelLabel {
  icon: string    // emoji character, e.g. "🚀"
  label: string   // singular display name, e.g. "Initiative"
  plural?: string // optional override; auto-pluralized if absent
}
```

### Internal mapping

The `levels` array always maps to the **bottom N** of the three internal types:

| levels.length | levels[0]    | levels[1] | levels[2] |
|---------------|--------------|-----------|-----------|
| 1             | —            | —         | task      |
| 2             | —            | epic      | task      |
| 3             | initiative   | epic      | task      |

The leaf level (`levels[levels.length - 1]`) always maps to `task` and cannot be removed.

### Defaults (when `labelConfig` is absent)

```ts
const DEFAULT_LEVELS: LevelLabel[] = [
  { icon: '🚀', label: 'Initiative' },
  { icon: '🏔️', label: 'Epic' },
  { icon: '🗂️', label: 'Task' },
]
```

---

## Auto-Pluralization

When `plural` is absent or empty, the display plural is computed client-side:

```ts
function autoPlural(word: string): string {
  if (word.match(/[sxz]$/i) || word.match(/[cs]h$/i)) return word + 'es'
  if (word.match(/[^aeiou]y$/i)) return word.slice(0, -1) + 'ies'
  return word + 's'
}
```

Used in: sidebar section headers, GroupingControls chips, entity creation dialog titles.

---

## Frontend Architecture

### `useDimensionMeta()` hook

New hook that replaces all reads of the hardcoded `DIMENSION_REGISTRY` and `getDimensionIcon()`:

```ts
interface LevelMeta {
  internalType: 'initiative' | 'epic' | 'task'
  label: string
  plural: string
  icon: string
  index: number  // 0 = top level
}

function useDimensionMeta(): LevelMeta[]
```

Reads from the active space's `labelConfig.levels`, falling back to defaults. Returns only the active levels (1–3 entries).

### `dimensions` array derivation

`WorkspaceShell` currently stores `dimensions: GroupingDimension[]` in state, seeded from localStorage `tinstar-dimensions`. After this change:

- `dimensions` is derived from `labelConfig.levels.length` via the internal mapping table above
- It is no longer stored in localStorage
- `GroupingControls` is retired (level count is now controlled from Settings only)

### One-time localStorage migration

On first load, if a space has no `labelConfig`:
1. Read `tinstar-dimensions` from localStorage
2. Use its length to set the initial `levels` count (with default labels/icons)
3. Save back to the space via `PATCH /api/spaces/:id`
4. Remove the `tinstar-dimensions` localStorage key

### Call sites to update

All reads of `DIMENSION_REGISTRY` / `getDimensionIcon()` / hardcoded dimension strings replaced with `useDimensionMeta()`:

| File | Change |
|------|--------|
| `src/domain/dimension-meta.ts` | Export `DEFAULT_LEVELS`; `getDimensionIcon` reads from hook context or accepts `LevelMeta[]` |
| `src/components/GroupingControls.tsx` | **Deleted** — level count moved to Settings |
| `src/components/HierarchySidebar.tsx` | Node icon/label from `useDimensionMeta()` |
| `src/components/CreateEntityDialog.tsx` | Dialog title uses label from meta (e.g. "New Client" not "New Initiative") |
| `src/components/WorkspaceShell.tsx` | Derive `dimensions` from `labelConfig`; remove GroupingControls; localStorage migration |
| `src/components/SettingsDialog.tsx` | New "Entity Labels" tab |

---

## Settings Dialog UI

New **"Entity Labels"** tab added to the existing `SettingsDialog`. Accessible via the gear icon (top-right).

### Layout

```
Entity Labels                              [Work Space ▾]
──────────────────────────────────────────────────────
  Level   Icon   Singular         Plural
  ─────────────────────────────────────────────────
  Level 1  [🚀]  [Initiative    ] [          ] ✕
  Level 2  [🏔️]  [Epic          ] [          ] ✕
  Level 3● [🗂️]  [Task          ] [          ]
  ─────────────────────────────────────────────────
  [+ Add level above leaf              ]  (hidden when 3 levels)

  Labels apply to this space only. Plural defaults to auto if left
  blank. No data migration needed.

──────────────────────────────────────────────────────
  Live Preview
  ┌──────────────────────────────────┐
  │ INITIATIVES                      │
  │ 🚀 Acme Platform                 │
  │   EPICS                          │
  │   🏔️ Auth overhaul              │
  │      🗂️ OAuth2 integration       │
  │         ● claude-session-1       │
  └──────────────────────────────────┘
──────────────────────────────────────────────────────
  Reset to defaults          [Cancel]  [Save]
```

### Behaviour

- **Level 3 (leaf)** marked with a green dot; ✕ button absent/disabled — leaf can never be removed
- **✕ on Level 1** removes it; levels renumber; preview updates
- **"+ Add level above leaf"** prepends a new row with defaults (`📦 Group`); hidden when 3 levels exist
- **Plural input** placeholder shows the auto-plural of the current singular as a hint
- **Save button** disabled until any field changes; enables on first keystroke
- **Live preview** updates as you type; the actual app only updates on Save
- **Space badge** (top-right of section) shows the active space name — reminder that settings are per-space

---

## Backend Changes

### `PATCH /api/spaces/:id`

Extend the existing endpoint to accept and persist `labelConfig`:

```ts
// Request body (partial)
{ labelConfig: { levels: LevelLabel[] } }
```

Validation:
- `levels` length must be 1–3
- Each level must have a non-empty `label` and `icon`
- `plural` is optional

No new endpoints needed. `GET /api/state` already returns full space records, so `labelConfig` is available to the frontend on bootstrap and space switch.

---

## What Is Not Changed

- Internal entity type IDs (`initiative`, `epic`, `task`) — unchanged in API, DB, FK fields
- Entity CRUD API routes (`/api/initiatives`, `/api/epics`, `/api/tasks`)
- `GroupingDimension` TypeScript union — unchanged
- `worktree` dimension — remains a separate peer axis, not part of `labelConfig`
- Canvas layout, widget system, hotgroups, sessions — untouched
- `file-editor` and `browser-widget` synthetic node types — untouched

---

## Migration Summary

| Item | Before | After |
|------|--------|-------|
| Active levels | `tinstar-dimensions` localStorage | `space.labelConfig.levels.length` |
| Level labels/icons | Hardcoded in `dimension-meta.ts` | `space.labelConfig.levels[i]` |
| GroupingControls | Chip bar at top of screen | Removed |
| Level count UI | GroupingControls add/remove chips | Settings → Entity Labels tab |
