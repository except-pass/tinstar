# Design Brief: Generic Entity Hierarchy

## Problem

Tinstar's work organization is hardcoded to three specific entity types: **Initiative → Epic → Task**. This means:

- A solo dev who thinks in "Project → Feature → Bug" can't relabel things
- An agency using "Client → Project → Ticket" has to mentally translate constantly
- A researcher using "Theme → Study → Experiment" is locked out
- Adding a 4th level (e.g. "Program" above Initiative) requires touching 15+ files

The entity types, their labels, icons, parent/child relationships, API routes, FK field names, settings inheritance chain, and database schema are all separately hardcoded. They move together as a rigid unit.

## Goal

Let users define their own entity type hierarchy — name, icon, and parent/child relationships — while the rest of Tinstar (canvas, sidebar, hotgroups, sessions, settings inheritance) continues to work unchanged.

A user should be able to say: *"I want 3 levels called Client, Project, Ticket"* and have the whole app reflect that.

---

## What Is Actually Generic vs. What Is Not

The research reveals a crucial distinction:

**Already generic (algorithm-level):**
- Tree building (`buildGroupTree`) — already works with any ordered dimension list
- Sidebar rendering — already uses `getDimensionIcon(node.type)` and iterates dimensions
- Canvas layout — works on `TreeNode[]`, doesn't care about type names
- Hotgroup/selection system — already operates on node IDs and type strings

**Hardcoded (needs generalization):**
- The `GroupingDimension` TypeScript union type and `ALL_DIMENSIONS` array
- FK field names on entities (`epicId`, `initiativeId`, `taskId`)
- Parent-child relationship rules (`getChildEntitiesForParent`, `getOrphanEntities`)
- Settings inheritance chain (`buildAncestorChain`)
- API routes (`/api/initiatives`, `/api/epics`, `/api/tasks`)
- The document store (separate arrays per type)
- The taxonomy repository (per-type methods)
- `DIMENSION_REGISTRY` metadata
- Entity creation dialog endpoint/prefix maps

The good news: the hardcoding is **concentrated**. The algorithm layer is already clean.

---

## Proposed Model

### EntityType definition

Replace the hardcoded union with a user-configurable schema stored in `~/.config/tinstar/entity-types.json`:

```json
[
  { "id": "initiative", "label": "Initiative", "icon": "rocket" },
  { "id": "epic",       "label": "Epic",        "icon": "mountain" },
  { "id": "task",       "label": "Task",        "icon": "card_index_dividers" }
]
```

The ordered array IS the hierarchy. Index 0 is the top level. Each type can parent the next type in the list. No FK field names are specified — the generic layer handles them.

The `worktree` dimension is special (it's a peer grouping axis, not a hierarchy level) and stays hardcoded separately.

### Generic entity storage

Replace the three separate entity collections with a single generic store:

```
Entity { id, typeId, name, parentId, spaceId, color?, status?, settings? }
```

One table/array, one CRUD API (`/api/entities`), one repository method. Parent/child relationships are expressed via `parentId` + `typeId` — no `epicId`/`initiativeId` dual-FK complexity. Orphan detection becomes: entity whose `parentId` doesn't exist or doesn't match the expected parent type.

Run attachment: runs currently hold `taskId`. Under the new model, runs hold `entityId` pointing to whichever entity type is at the **leaf position** in the active hierarchy (the last non-worktree dimension). This is resolved at runtime from the entity-types config.

### Settings inheritance

Currently hardcoded as Task → Epic → Initiative. With `parentId` on every entity, inheritance becomes a generic parent-chain walk. No more hardcoded cases.

---

## Scope of Change

### Tier 1 — Backward-compatible rename UI (smallest useful thing)

Don't change the data model at all. Just make labels and icons configurable:

- Add an **"Entity Labels"** section to the existing Settings dialog (the gear icon, top-right)
- Show one row per active dimension: a text input for the label, an icon picker (or emoji input)
- Live-preview: renaming "Epic" to "Feature" immediately updates the sidebar, grouping controls, and canvas container headers
- Persist to `~/.config/tinstar/display.json` via `PATCH /api/display-config`; served back on startup via `GET /api/display-config`
- The tree, API, FKs, everything else stays the same — pure display layer change

**Settings UI mockup:**

```
Entity Labels
─────────────────────────────────────
  Level 1   [rocket]  [Initiative    ]
  Level 2   [mountain][Epic          ]
  Level 3   [card]    [Task          ]
─────────────────────────────────────
  Reset to defaults
```

**Effort:** ~1 day. **Value:** Huge — solves the vocabulary problem for most users.
**Risk:** Minimal. Data model unchanged, no migration needed.

### Tier 2 — Configurable number of levels (medium)

Allow users to define N levels (not just 3), without changing the entity storage model yet:

- Keep the existing entity types but allow adding new ones in the chain
- The grouping algorithm already supports arbitrary depth; the constraint is in the fixed type list
- Adding "Program" above Initiative means a new entity type, a new FK, new API route, and new ancestry logic — the pain is real but scoped

**Effort:** ~3 days. **Value:** Moderate — serves power users.
**Risk:** Medium. Requires migration for existing data.

### Tier 3 — Fully generic entity model (full redesign)

Implement the generic `Entity` storage model described above:

- Single `/api/entities?type=X&parentId=Y` endpoint replaces 4 specific endpoints
- `entity-types.json` config replaces the TypeScript union
- Migration path: existing initiatives/epics/tasks become entities with `typeId = 'initiative'`/`'epic'`/`'task'`
- Run's `taskId` becomes `entityId` (pointing to leaf entity)
- TypeScript: `GroupingDimension` becomes `string` (loaded at runtime), losing compile-time safety — or a generated type from config

**Effort:** ~1 week. **Value:** Maximum — any hierarchy, any labels.
**Risk:** High. Full migration, loss of some type safety, needs careful testing.

---

## Recommended Approach: Tier 1 Now, Design Tier 3 Properly

**Ship Tier 1 immediately.** The label/icon customization is almost purely cosmetic and unblocks 80% of the user frustration. "I want to call these things Client/Project/Ticket" is satisfied by Tier 1.

**Design Tier 3 as a standalone migration.** The generic entity model is worth doing but is a breaking change to the data layer. It should be its own branch with a proper migration script, not bolted onto Tier 1.

**Skip Tier 2.** It's the worst of both worlds — medium complexity, hardcoded FKs for N levels, partial solution. If you're going to generalize, go all the way.

---

## Key Design Decisions for Tier 3

### 1. How does the tree algorithm know what "leaf" entities runs attach to?

**Option A:** Always the last dimension in the active list. Simple, but a user with `[Client, Project]` active can't attach runs to Clients.

**Option B:** Mark one entity type as `canHaveRuns: true` in the config. More explicit.

**Recommendation:** Option A for now. Runs always attach to the deepest active dimension. Override can come later.

### 2. What happens to existing data?

Migration script: read `initiatives[]`, `epics[]`, `tasks[]` from the JSON store, emit `entities[]` with `typeId` set. The `epicId`/`initiativeId` FKs become `parentId` via the known relationship chain. One-way, non-destructive (keep a backup).

### 3. TypeScript types

`GroupingDimension` as a string literal union provides compile-time safety throughout. Moving to `string` loses this. Options:

- Keep the union but generate it from config at build time (config-as-source-of-truth, but breaks hot-reload)
- Use `string` everywhere and add runtime validation at the API boundary
- Keep `GroupingDimension` as a type alias for `string` with a runtime registry for validation

**Recommendation:** Use `string` with a runtime registry. The app already has enough run-time type guards (node type checks everywhere) that compile-time guarantees here are less valuable than flexibility.

### 4. Settings inheritance

Generic parent-chain walk. An entity with no `parentId` is the root; its settings are the base. Children inherit and can override. Already how it conceptually works — just needs to be expressed in code without the hardcoded cases.

---

## Files Touched by Each Tier

**Tier 1 (label/icon rename):**
- `src/domain/dimension-meta.ts` — read from config instead of hardcoded array; expose a `useDimensionMeta()` hook
- `src/components/GroupingControls.tsx` — use dynamic labels from hook
- `src/components/HierarchySidebar.tsx` — use dynamic icons/labels from hook
- `src/components/CreateEntityDialog.tsx` — use dynamic labels in dialog title ("New Initiative" → "New Client")
- `src/server/api/routes.ts` — new `GET /api/display-config` and `PATCH /api/display-config` endpoints
- `src/components/SettingsDialog.tsx` — add "Entity Labels" section with inline editor rows
- `~/.config/tinstar/display.json` — new config file (created on first save, falls back to defaults)

**Tier 3 (generic entities, additional to Tier 1):**
- `src/domain/types.ts` — `GroupingDimension` becomes `string`, new `EntityType` type, `Entity` type
- `src/domain/repositories.ts` — generic entity methods replace per-type methods
- `src/domain/grouping.ts` — `getChildEntitiesForParent` / `getOrphanEntities` become generic
- `src/server/stores/document-store.ts` — `entities[]` replaces `initiatives[]`/`epics[]`/`tasks[]`
- `src/server/api/routes.ts` — `/api/entities` replaces 4 specific endpoints
- `src/server/sessions/entity-settings.ts` — generic parent-chain walk
- `src/components/CreateEntityDialog.tsx` — drive from entity-type config
- `src/components/WorkspaceShell.tsx` — run's `taskId` → `entityId`
- Migration script: `scripts/migrate-entities.ts`

---

## What This Does NOT Change

- Canvas rendering, widget shells, zoom/pan
- Hotgroup system (operates on node IDs)
- Session/run lifecycle
- File editor and browser widgets (already synthetic/outside the taxonomy)
- Worktree dimension (stays separate)
- The sidebar tree-rendering algorithm (already generic)
- SSE event bus

The feature is almost entirely a data-model and API change. The visual layer is already general enough.
