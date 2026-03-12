# Entity Context Menu, Settings & Inherited Session Defaults

**Date**: 2026-03-11
**Status**: Approved

## Problem

Entities (initiatives, epics, tasks) have scattered action buttons (✏ rename, + add, × delete) that don't scale. There's no way to configure settings on an entity or start a session scoped to one. Users must manually fill in project, backend, worktree, etc. every time they create a session.

## Solution

1. **Kebab context menu (⋮)** on both sidebar nodes and canvas container headers, replacing scattered buttons
2. **Entity settings** with closest-ancestor inheritance (amber = inherited, cyan = local override)
3. **"Start Session" action** that pre-fills `CreateSessionDialog` from resolved entity settings

---

## Data Model

### EntitySettings type

Added to `src/domain/types.ts`:

```typescript
interface EntitySettings {
  project?: string            // registered project name
  worktree?: 'none' | 'new' | 'existing'
  backend?: 'docker' | 'tmux'
  skipPermissions?: boolean
  profile?: string            // Docker image override
}
```

All fields are optional. Only explicitly set values are persisted. Absence (`undefined` / key not present) means "inherit from parent" or "not set." Keys with `null` values are stripped during storage — the PATCH handler deletes `null`-valued keys from the settings object before persisting.

### Scope

Settings apply to **initiatives, epics, and tasks only**. Worktree entities do not have settings or a context menu with Start Session / Settings items. When the EntityMenu is opened for a worktree node, only Rename, Add Child, and Delete are shown.

### Storage

A `settings?: EntitySettings` field is added to `Initiative`, `Epic`, and `Task` interfaces. Stored inline in the DocumentStore alongside existing entity fields. Persisted to `docstore.json` automatically.

### Resolution

`resolveEntitySettings(entityId, entityType, docStore)` is a **server-only** function. The client accesses resolved settings exclusively via the `GET /api/{type}/{id}/settings` endpoint.

The function walks the hierarchy bottom-up:

1. Read the entity's local `settings`
2. If entity is a Task, read parent Epic's `settings` (via `task.epicId`)
3. Read parent Initiative's `settings` (via `task.initiativeId` or `epic.initiativeId`)
4. Merge closest-wins: Task overrides Epic overrides Initiative
5. If a parent entity is missing (stale FK / deleted), skip it and continue up the chain

Returns:

```typescript
interface ResolvedSettings {
  resolved: EntitySettings           // merged result
  sources: Partial<Record<keyof EntitySettings, { type: GroupingDimension; name: string }>>  // where each inherited value comes from
  local: EntitySettings              // only values set directly on this entity
}
```

---

## UI Components

### 1. EntityMenu (new component)

A positioned dropdown menu triggered by a ⋮ button. Used by both the sidebar and canvas.

**Menu items:**
| Item | Icon | Action |
|------|------|--------|
| Start Session | ▶ (blue) | Opens pre-filled CreateSessionDialog |
| Settings... | ⚙ | Opens EntitySettingsDialog |
| Rename | ✏ | Triggers inline rename (sidebar) or opens rename input |
| Add Child | + | Creates child of next dimension type |
| Delete | ✗ (red) | Deletes entity, children become orphans |

**Behavior:**
- Opens on ⋮ click, positioned adjacent to the trigger element
- Closes on click-outside, Escape, or menu item selection
- On canvas: positioned in screen coords, not canvas coords (so it doesn't zoom/pan)

**Worktree nodes:** Only show Rename, Add Child, and Delete. Hide Start Session and Settings.

**Delete confirmation:** Delete shows an inline confirmation ("Delete {name}? Children will be ungrouped.") before executing. Simple text confirm/cancel in the menu itself, not a separate modal.

**Props:**
```typescript
interface EntityMenuProps {
  entityId: string
  entityType: GroupingDimension
  entityName: string
  anchorRect: DOMRect              // trigger element bounding rect for positioning
  onStartSession: () => void
  onSettings: () => void
  onRename: () => void
  onAddChild: () => void
  onDelete: () => void
  onClose: () => void
}
```

### 2. EntitySettingsDialog (new component)

Modal dialog for viewing and editing entity settings with inheritance visualization.

**Setting row states:**

1. **Not set anywhere** — Unchecked checkbox, gray label, italic "Not set" text
2. **Inherited from ancestor** — Unchecked checkbox, gray label, amber pill showing resolved value + `(set in Epic Auth Rewrite)` source label
3. **Local override** — Checked cyan checkbox, cyan label, cyan selector/toggle for the value

**Interactions:**
- Check the box → copies inherited value (if any) as starting local value, shows cyan options
- Pick a different value → immediately PATCHes the entity
- Uncheck the box → clears local override via PATCH with `null`, falls back to inheritance

**Settings displayed:**
- Project: dropdown of registered projects
- Backend: toggle (Docker / Tmux)
- Worktree: toggle (None / New / Existing)
- Skip Permissions: toggle (Yes / No)
- Profile: dropdown/text input for Docker image

**Props:**
```typescript
interface EntitySettingsDialogProps {
  entityId: string
  entityType: GroupingDimension
  entityName: string
  onClose: () => void
}
```

Fetches resolved settings on mount via `GET /api/{type}/{id}/settings`.

### 3. GroupContainer (modified)

- Remove the × close button from the header
- Add ⋮ kebab button, hover-revealed, in the same position (far right of header)
- ⋮ click opens EntityMenu positioned below the button

### 4. HierarchySidebar (modified)

- Remove ✏ rename, + add child, × delete buttons from sidebar nodes
- Add single ⋮ kebab button, hover-revealed, after the count badge
- ⋮ click opens EntityMenu positioned adjacent to the button

### 5. CreateSessionDialog (modified)

- Accept optional `prefill` prop:
  ```typescript
  interface SessionPrefill {
    project?: string
    backend?: 'docker' | 'tmux'
    worktreeMode?: 'none' | 'new' | 'existing'
    skipPermissions?: boolean
    profile?: string
    taskId?: string              // set if source entity is a task
  }
  ```
- When `prefill` is provided, fields are pre-populated but still editable
- `taskId` is set to the entity's ID if it's a task, otherwise omitted

### 6. WorkspaceShell (modified)

- Remove `onRename`, `onDelete`, and `onAdd` props from HierarchySidebar (all moved into menu)
- HierarchySidebar receives a single `onMenuOpen(entityId, entityType, entityName, anchorRect)` callback
- Add state management for EntityMenu and EntitySettingsDialog
- Wire "Start Session" to resolve settings then open CreateSessionDialog with prefill

---

## API Changes

### New: GET /api/{initiatives|epics|tasks}/:id/settings

Returns the resolved settings chain for the entity.

**Response:**
```json
{
  "ok": true,
  "data": {
    "resolved": {
      "project": "tinstar",
      "backend": "tmux",
      "skipPermissions": true
    },
    "sources": {
      "project": { "type": "initiative", "name": "Q1 Planning" },
      "backend": { "type": "epic", "name": "Auth Rewrite" },
      "skipPermissions": { "type": "initiative", "name": "Q1 Planning" }
    },
    "local": {
      "worktree": "new"
    }
  }
}
```

**Implementation:** Uses `resolveEntitySettings()` shared function in a new file `src/server/sessions/entity-settings.ts`.

### Modified: PATCH /api/{initiatives|epics|tasks}/:id

The existing PATCH handlers use shallow spread (`{ ...existing, ...patch }`). **The handler must be updated** to deep-merge the `settings` sub-object so that patching one setting key doesn't wipe others.

Settings are passed as:
```json
{ "settings": { "backend": "tmux" } }
```

This merges into the existing settings: `{ ...existing.settings, ...patch.settings }`.

To clear a local override, send `null`:
```json
{ "settings": { "backend": null } }
```

The PATCH handler strips `null`-valued keys from the merged settings object before persisting, so the key is removed entirely (returning to "inherit" state). This means `undefined` (absent) and `null` (explicitly cleared) both result in the key not being stored.

### Error handling: GET /api/{type}/:id/settings

- Returns 404 if the entity ID doesn't exist
- If a parent in the chain has been deleted (stale FK), the resolver skips it and continues up — partial inheritance still works

### No changes to POST /api/sessions

The "Start Session" menu action resolves settings client-side (one GET call), then opens the existing CreateSessionDialog pre-filled. The session creation payload is unchanged.

---

## Inheritance Visual Language

| State | Checkbox | Border/Text Color | Extra |
|-------|----------|-------------------|-------|
| Not set anywhere | Unchecked, gray | Gray | Italic "Not set" |
| Inherited from ancestor | Unchecked, gray | Amber (#ffaa00) | `(set in {Type} {Name})` label |
| Local override | Checked, cyan | Cyan (#00f0ff) | Standard selected styling |

- Checking the box on an inherited value promotes it to a local override (amber → cyan)
- Unchecking clears the local value and falls back to inheritance or "Not set"
- Each change immediately PATCHes — no save button

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/components/EntityMenu.tsx` | Positioned kebab dropdown menu |
| `src/components/EntitySettingsDialog.tsx` | Settings modal with inheritance UI |
| `src/server/sessions/entity-settings.ts` | `resolveEntitySettings()` function |

## Files to Modify

| File | Changes |
|------|---------|
| `src/domain/types.ts` | Add `EntitySettings` type, `settings?` field on Initiative/Epic/Task |
| `src/components/GroupContainer.tsx` | Replace × with ⋮, open EntityMenu |
| `src/components/HierarchySidebar.tsx` | Replace ✏/+/× with ⋮, open EntityMenu |
| `src/components/InfiniteCanvas.tsx` | Pass menu callbacks to GroupContainer, manage menu state |
| `src/components/WorkspaceShell.tsx` | Wire EntityMenu/EntitySettingsDialog, manage state |
| `src/components/CreateSessionDialog.tsx` | Accept optional `prefill` prop |
| `src/server/api/routes.ts` | Add GET settings endpoint, handle `settings` in PATCH |
| `src/server/stores/document-store.ts` | Persist `settings` field on entities (already works — stored inline) |
| `docs/feature-catalog.md` | Document new features |
