# Procedures Sidebar — Design Spec

**Date:** 2026-03-13
**Status:** Approved

---

## Overview

The RunWorkspace procedures sidebar is currently a placeholder. This spec defines a fully functional **Procedures** feature: a contextual shortcut bar that lets users pin Claude Code skills to their project hierarchy (Initiative / Epic / Task) and fire them as slash commands into the active Claude session.

**Core mental model:**
- **Skills** — reusable patterns, discovered from the Claude Code filesystem (system and repo level). Timeless, global.
- **Procedures** — curated shortcuts into the skill library, scoped to a specific entity (Task / Epic / Initiative). Contextual, project-specific.

---

## Data Model

### `Skill` (runtime, never persisted)

Discovered from the filesystem on demand. Never stored. `path` is server-side only and is not included in the `GET /api/skills` API response.

```ts
// Server-side only (used for staging/saving)
interface Skill {
  name: string           // e.g. "design", "sec-review"
  description?: string   // from skill file frontmatter
  source: 'system' | 'repo' | 'plugin'
  path: string           // absolute path to the .md file — not sent to client
}

// API response shape (path omitted)
interface SkillDTO {
  name: string
  description?: string
  source: 'system' | 'repo' | 'plugin'
}
```

Source badges: `sys` for `'system'` and `'plugin'`, `repo` for `'repo'`.

### `Procedure` (persisted on entity)

A procedure is a reference to a skill. `entityId` and `entityType` are **not** stored — they are redundant with the entity the procedure is stored on, and would risk going stale. They exist only as a runtime convenience when building the resolved list.

`customPrompt` is post-MVP and is **not** included in the stored type. It will be added when custom prompt editing is in scope and its firing semantics are fully defined.

```ts
// Stored shape (inside EntitySettings.procedures)
interface StoredProcedure {
  id: string
  skillName: string        // matches Skill.name
}

// Runtime shape (after resolving the hierarchy)
interface ResolvedProcedure extends StoredProcedure {
  entityId: string
  entityType: 'task' | 'epic' | 'initiative'
}
```

Procedures are stored inside `EntitySettings` on each entity. The existing `settings?: EntitySettings` field on `Task`, `Epic`, and `Initiative` gains a `procedures: StoredProcedure[]` field.

### Pending skill (runtime, for shimmer state)

```ts
interface PendingSkill {
  id: string               // client-generated UUID, matches draftId sent to agent
  placeholderName: string  // typed description, shown while agent works
  status: 'defining' | 'saving' | 'error'
  // entity context preserved so the procedure can be persisted after save
  entityId: string
  entityType: 'task' | 'epic' | 'initiative'
}
```

The `draftId` is generated client-side and passed as part of the message fired to the agent (e.g. `"Define a new skill [draftId=abc123]: review changes for perf regressions"`). The agent includes this ID in the draft filename. When the `skill.drafted` SSE event arrives carrying `draftId`, the UI correlates it to the correct shimmer entry.

**Visual states:**
- `'defining'` and `'saving'` both show the same pulse shimmer — the presence of `SaveSkillModal` on screen is sufficient to communicate the `'saving'` state.
- `'error'` shows red tint + retry button.

### Resolved procedure list (runtime)

When a Run is active, the UI resolves the full procedure list by merging:

```
Task.settings.procedures      → entityType: 'task'
  + Epic.settings.procedures  → entityType: 'epic'
  + Initiative.settings.procedures → entityType: 'initiative'
```

Displayed in sidebar with a divider between own (Task) and inherited (Epic / Initiative), labeled by entity name.

---

## Skill Discovery

Skills are discovered by scanning three directory groups on every picker open, with a **5–10s in-memory TTL cache**. Lazy — scan triggered by picker open, not on mount.

| Source | Directory | `Skill.source` | Badge |
|--------|-----------|----------------|-------|
| System | `~/.claude/commands/` | `'system'` | `sys` |
| Repo | `.claude/commands/` (project root) | `'repo'` | `repo` |
| Plugins | `~/.claude/plugins/cache/**/skills/*/` | `'plugin'` | `sys` |

Each directory is scanned for `.md` files. Frontmatter (`name`, `description`) is parsed. Both `'system'` and `'plugin'` sources display the `sys` badge — they are visually identical to the user. No persistent file watcher — scan-on-open with TTL cache is sufficient. Cache is explicitly busted when a newly defined skill is saved.

---

## UI Components

### `ProceduresPanel` (rewrite of existing placeholder)

Fixed 160px sidebar panel inside `RunWorkspaceWidget`.

- **Inherited group** (from Epic / Initiative): labeled with entity name, rendered above a divider. Only shown if the current task has a parent at that level.
- **Task group**: task-own procedures
- Each row: icon + skill name + `▶` run button (visible on hover). `▶` is **disabled** (greyed out, no pointer) when the session status is `running` — a tooltip says "Session is busy".
- **Shimmer rows**: optimistic entries for in-progress skill definitions — pulse animation, placeholder name from typed description. Correlated to `PendingSkill` by `id`.
- **`+ New` button** at bottom: opens `SkillPickerModal`

### `SkillPickerModal` (new)

Full-screen overlay with centered command picker (480px wide).

**Input:** placeholder `"Search or define skill…"` — dual-purpose.

**Behaviour:**
- Skills fetched lazily from `useSkills` when modal opens
- Typing filters skills by name
- Each skill row shows: icon, name, description, source badge (`sys` / `repo`), star button
- **Star button** → inline entity popover. Popover shows only the ancestor levels that exist for the current session's task (e.g. if there is no Initiative, only Task and Epic are shown). Missing ancestors are hidden, not greyed out. Current task is highlighted.
- Selecting an entity in the popover adds the procedure immediately (optimistic, via `PATCH /api/entities/:type/:id/settings`)
- **No match state**: list collapses to a single focused row: `Define "[typed text]" as new skill… ↵`
- **Partial match state**: filtered results shown + define row at bottom with typed text
- `↵` on define row: closes picker, fires to agent, adds shimmer entry to sidebar

**Keyboard:** `↑↓` navigate, `↵` select/define, `Esc` close.

### `SaveSkillModal` (new)

Small modal appearing after agent drafts a new skill (triggered by `skill.drafted` SSE event carrying `draftId`).

- Shows skill name preview (from draft frontmatter)
- Two options: **System** (`~/.claude/commands/`) or **Repo** (`.claude/commands/`)
- Confirm → `POST /api/skills/save` with `{draftId, location}` → on success, client fires `PATCH /api/entities/:type/:id` to add the `StoredProcedure` for the new skill on the entity stored in the matching `PendingSkill` → cache busted, shimmer resolves
- Cancel → `POST /api/skills/discard` with `{draftId}` → draft deleted, shimmer entry fades out

### `useSkills` hook (new)

- **Lazy**: exposes a `fetchSkills()` function, does not fetch on mount
- **Singleton**: mounted once globally in a context provider (e.g. `SkillsProvider` wrapping `WorkspaceShell`). This ensures only one SSE listener handles `skill.drafted` events, preventing duplicate `SaveSkillModal` renders.
- Subscribes to `skill.drafted` SSE event → correlates via `draftId` to the matching `PendingSkill` → transitions its status to `'saving'` → opens `SaveSkillModal`
- Subscribes to `skill.saved` SSE event → busts cache
- Exposes `pendingSkills: PendingSkill[]` for shimmer state

---

## Backend

### `GET /api/skills`

Scans skill directories, parses frontmatter, returns skill list. Result cached for 5–10s. Returns:

```ts
{ skills: Skill[] }
```

### `POST /api/skills/save`

Moves a staged draft to the chosen location.

```ts
// Request
{ draftId: string, location: 'system' | 'repo' }
// Response
{ skill: Skill }
```

Busts the skill cache after write. Emits `skill.saved` SSE event carrying the new `SkillDTO`.

**Name collision:** if a skill with the same `name` already exists at the chosen location, returns `409 { error: 'skill-name-conflict', existingPath: string }`. The frontend should surface this to the user with an option to rename the draft before retrying.

### `POST /api/skills/discard`

Deletes a staged draft.

```ts
{ draftId: string }
```

### Skill staging

When the agent defines a new skill, it writes to `~/.config/tinstar/skill-drafts/[draftId].md`. The backend watches this directory with `fs.watch` (scoped and cheap — this is the only location where real-time detection matters) and emits a `skill.drafted` SSE event carrying `{ draftId, skillName }` when a new file appears.

### Procedures persistence

Procedures are stored by patching the entity's `settings` via the **existing** entity PATCH route with a `settings` payload:

```ts
PATCH /api/entities/:type/:id
Body: { settings: { procedures: StoredProcedure[] } }
```

This avoids a new endpoint and keeps procedures consistent with how other `EntitySettings` fields are persisted. The existing deep-merge behaviour on the PATCH handler means other settings fields are unaffected.

### Session input — `POST /api/sessions/:id/prompt`

**This is a new route.** Running a procedure fires the slash command into the active Claude session. This route sends input via the same mechanism the interactive UI uses to submit prompts to Claude Code — not raw tmux send-keys.

```ts
// Request
{ text: string }  // e.g. "/design"
// Response
{ ok: true } | { error: string }
```

**Valid session states for prompt submission:** only `'idle'` (session is waiting for user input). The `'running'` state means Claude is already processing — no input should be accepted. All other states (`'creating'`, `'stopped'`, `'needs_attention'`) also reject with `400 { error: 'session-not-ready' }`.

**Error behaviour:**
- Session state is not `'idle'` → `400 { error: 'session-not-ready' }`
- Session backend has no input channel → `503 { error: 'input-unavailable' }`

The implementation mechanism (stdin pipe, ttyd channel, etc.) is determined during implementation based on the active backend (Docker / tmux). The frontend run button is disabled for all non-`idle` states — the backend 400 guard is a safety net, not the primary enforcement.

---

## Define-New-Skill Flow (end-to-end)

1. User types description in picker → `↵`
2. Client generates `draftId` (UUID)
3. Picker closes immediately
4. Shimmer entry (`PendingSkill { id: draftId, placeholderName: typed text, status: 'defining' }`) appears in procedures sidebar
5. UI fires message to active session via `POST /api/sessions/:id/prompt`: `"Define a new skill [draftId=abc123]: [description]"`
6. Agent writes skill draft to `~/.config/tinstar/skill-drafts/abc123.md`
7. Backend detects new draft file → emits `skill.drafted { draftId: 'abc123', skillName: 'perf-review' }`
8. `useSkills` receives event, correlates to shimmer by `draftId`, updates shimmer `status: 'saving'`
9. `SaveSkillModal` appears: System or Repo?
10. User confirms → `POST /api/skills/save { draftId, location }` → file written, cache busted
11. Client fires `PATCH /api/entities/:type/:id` with `{ settings: { procedures: [...existing, { id, skillName }] } }` using the entity stored in `PendingSkill`
12. `skill.saved` SSE event received → shimmer resolves to final skill name

**Failure path:** If no `skill.drafted` event arrives within 30s, shimmer `status` → `'error'` (red tint, retry button). Retry re-fires step 5. User can also dismiss to remove the shimmer entry.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Skill directory missing | `/api/skills` returns empty array for that source, no error thrown |
| Agent fails to define skill | Shimmer shows error state after 30s; retry available |
| User cancels SaveSkillModal | `POST /api/skills/discard`; shimmer fades out |
| Duplicate skill name (in picker) | Define row not shown for exact name matches; existing skill highlighted |
| Duplicate skill name (on save) | `409` returned; user prompted to rename before retrying |
| Procedure entity deleted | Inherited procedures silently dropped from resolved list |
| Session busy when firing procedure | Run button disabled; tooltip "Session is busy" |
| Prompt API unavailable | `503` returned; frontend shows brief toast error |
| Task has no Epic/Initiative | Entity popover shows only available ancestor levels; missing levels hidden |

---

## Testing

**Unit tests:**
- Skill discovery: mock filesystem, verify frontmatter parsing, source tagging, and badge assignment for all three source types
- Procedure inheritance: Task + Epic + Initiative → merged resolved list in correct order; orphaned task (no Epic) → only Task procedures shown
- `PendingSkill` correlation: `skill.drafted` event with matching `draftId` updates correct shimmer entry

**E2E (Playwright):**
- Open picker → search for skill → star it (assign to Task) → verify appears in sidebar under task group
- Open picker → type unknown description → `↵` → verify shimmer appears in sidebar
- Complete define flow → confirm save → verify shimmer resolves to skill name
- Star skill to Epic → open new session on sibling task → verify procedure appears in inherited group

---

## Out of Scope

- Custom prompt editing per procedure (post-MVP)
- Reordering procedures within the sidebar (post-MVP)
- Keyboard shortcut (1–8) hotbar for procedures (post-MVP)
- Procedure run history / status tracking (the current status model is removed)
