# Spaces — Design Spec

**Date:** 2026-03-12
**Status:** Approved

---

## Overview

Spaces are named containers for document store data (initiatives, epics, tasks, worktrees, runs). They allow users to maintain separate working contexts — e.g., real project work vs. test data — without losing state when switching between them. Sessions (Docker containers, tmux sessions) are global infrastructure and do not belong to any space.

---

## Data Model

### Space entity

```typescript
interface Space {
  id: string        // shortId(), e.g. "spc-a1b2c3"
  name: string      // user-facing, e.g. "Work Space", "_tinstar_e2e"
  createdAt: string // ISO 8601
}
```

No nesting, no hierarchy, no embedded snapshots.

### Entity association

Every entity (initiative, epic, task, worktree, run) gets a `spaceId: string` field. This links it to a space. Entities are filtered by the active space for all reads.

### Sessions

Sessions have no `spaceId`. They are global infrastructure. Runs (which do have a `spaceId`) are the link between a session and a space.

### Active space

The server tracks `activeSpaceId` in memory. It is persisted to `~/.config/tinstar/config.json` (as `activeSpaceId`) so it survives restarts.

### First boot

On first boot with no spaces, the server auto-creates a space named "Work Space" and activates it. The user lands in a working state with no setup required. They can rename it or create additional spaces.

---

## API

### Endpoints

```
GET    /api/spaces              # List all spaces
POST   /api/spaces              # Create { name } → returns created space
PATCH  /api/spaces/:id          # Update { name }
DELETE /api/spaces/:id          # Delete (rules below)
POST   /api/spaces/:id/activate # Set as active space
```

### Creation

`POST /api/spaces` with `{ name }`. Returns the new space. Does NOT auto-activate — user stays on their current space unless they explicitly switch.

### Activation

`POST /api/spaces/:id/activate` sets `activeSpaceId`. The server:
1. Persists the new `activeSpaceId` to config
2. Sends a fresh SSE snapshot filtered to the new space's entities
3. All connected clients switch simultaneously

### Deletion rules

- Cannot delete the active space → 400 error ("Switch to another space first")
- Cannot delete the last space → 400 error ("Must have at least one space")
- On delete: all entities with that `spaceId` are removed from the document store
- Runs are removed but sessions keep running
- Response includes a warning: count of orphaned sessions + hint ("Use `tmux ls` or `docker ps` to manage orphaned sessions")

### Entity creation

When the API creates an initiative/epic/task/worktree/run, it stamps `spaceId: activeSpaceId` automatically. No client-side change needed.

---

## SSE & State

### Snapshot shape

```typescript
interface SSESnapshot {
  activeSpaceId: string
  spaces: Space[]           // ALL spaces (unfiltered, for the switcher dropdown)
  initiatives: Initiative[] // filtered to active space
  epics: Epic[]
  tasks: Task[]
  worktrees: Worktree[]
  runs: Run[]
}
```

Spaces are always sent in full so the dropdown can render all options regardless of which is active.

### Deltas

Deltas for entities not in the active space are suppressed (not sent to clients). Space CRUD deltas (entity type `space`) are always sent so the dropdown stays up to date.

### Activation delta

When the active space changes, the server sends a fresh snapshot (not a delta). This is the same mechanism as initial connection — the frontend replaces its entire state.

---

## Widget Layouts

### Per-space localStorage

Change localStorage key from `tinstar-layouts-v3` to `tinstar-layouts-v3-{spaceId}`.

### Switch sequence (frontend)

1. User selects a space from the dropdown
2. Frontend calls `POST /api/spaces/:id/activate`
3. Server sends new SSE snapshot (includes `activeSpaceId`)
4. `useServerEvents` replaces state (same as initial connect)
5. `useWidgetLayouts` reads `tinstar-layouts-v3-{activeSpaceId}` from localStorage
6. If found → restore exact widget positions. If missing → generate fresh layout.
7. Canvas redraws

Switching from space A → B → A restores space A's widget positions exactly.

### Dimensions

`tinstar-dimensions` remains global (not per-space). Grouping preferences apply across all spaces.

---

## UI: Space Switcher

### Location

Replaces the "Hierarchy" label in the sidebar header. The tree content is self-evident; no sub-header needed.

### Default state

Dropdown trigger showing the active space name, styled with `panel-header` / `panel-label` classes.

### Popover (on click)

```
┌─────────────────────────────────┐
│ ▾ Work Space              [⚙]  │  ← dropdown trigger
├─────────────────────────────────┤
│  ● Work Space              ✓   │  ← active (checkmark)
│  ○ Experiment Alpha             │
│  ○ Client Work                  │
│ ─────────────────────────────── │
│  + New Space                    │
└─────────────────────────────────┘
```

### Interactions

- **Click a space** → `POST /api/spaces/:id/activate`, popover closes
- **"+ New Space"** → inline text input at bottom of list. Enter to create (via `POST /api/spaces`), Escape to cancel. Does NOT auto-activate.
- **Right-click a space** → context menu: Rename, Delete
- **Delete confirmation** → shows orphaned session count and warning before proceeding

### Styling

- Dropdown trigger: `panel-header` classes, cyan accent for active name
- Popover: `bg-surface-raised`, `border-primary/25`, matches existing dark theme
- Active space: cyan dot + checkmark
- Inactive spaces: slate dot
- Hover: `bg-surface-hover`

---

## Simulator & E2E

### `TINSTAR_FAST_SIM=1` behavior

1. Server auto-creates a space named `_simulator` (or reuses if exists)
2. Activates it
3. Populates with mock data as today
4. Space persists until manually deleted or E2E teardown

### E2E test lifecycle

1. **Playwright `globalSetup`**: `POST /api/spaces` (create `_tinstar_e2e`) → `POST /api/spaces/:id/activate`
2. Tests run against that space
3. **Playwright `globalTeardown`**: activate another space → `DELETE /api/spaces/:id`

This means E2E tests never touch real working spaces.

---

## Backend Changes Summary

| File | Change |
|------|--------|
| `src/types.ts` | Add `Space` interface, add `spaceId` to entity types |
| `src/server/types.ts` | Add space-related event types |
| `src/server/stores/document-store.ts` | Add `spaces` map + CRUD, filter reads by `activeSpaceId`, include `spaces` in snapshot, stamp `spaceId` on entity creation |
| `src/server/api/routes.ts` | Add `/api/spaces` CRUD + `/activate` endpoint, stamp `spaceId` on entity creation |
| `src/server/api/sse.ts` | Include `activeSpaceId` + `spaces` in snapshot, suppress non-active deltas |
| `src/server/index.ts` | Auto-create "Work Space" on first boot, handle `TINSTAR_FAST_SIM` space creation |
| `src/server/sessions/config.ts` | Persist/load `activeSpaceId` in config |

## Frontend Changes Summary

| File | Change |
|------|--------|
| `src/hooks/useServerEvents.ts` | Add `spaces` + `activeSpaceId` to `ServerState`, handle space deltas |
| `src/hooks/useWidgetLayouts.ts` | Namespace localStorage key by `activeSpaceId` |
| `src/components/HierarchySidebar.tsx` | Replace "Hierarchy" header with space switcher dropdown |
| `src/components/SpaceSwitcher.tsx` | New component: dropdown, popover, inline create, context menu |
