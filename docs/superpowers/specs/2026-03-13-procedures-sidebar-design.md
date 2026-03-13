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

Discovered from the filesystem on demand. Never stored.

```ts
interface Skill {
  name: string           // e.g. "design", "sec-review"
  description?: string   // from skill file frontmatter
  source: 'system' | 'repo'
  path: string           // absolute path to the .md file
}
```

### `Procedure` (persisted on entity)

A procedure is a reference to a skill, optionally with a custom prompt modifier.

```ts
interface Procedure {
  id: string
  skillName: string        // matches Skill.name
  customPrompt?: string    // optional prefix/suffix when firing
  entityId: string         // owning Task / Epic / Initiative id
  entityType: 'task' | 'epic' | 'initiative'
}
```

Procedures are stored inside `EntitySettings` on each entity. The existing `settings?: EntitySettings` field on `Task`, `Epic`, and `Initiative` gains a `procedures: Procedure[]` field.

### Resolved procedure list (runtime)

When a Run is active, the UI resolves the full procedure list by merging:

```
Task.settings.procedures
  + Epic.settings.procedures
  + Initiative.settings.procedures
```

Displayed in sidebar with a divider between own (Task) and inherited (Epic / Initiative), labeled by entity name.

---

## Skill Discovery

Skills are discovered by scanning three directories on every picker open, with a **5–10s in-memory TTL cache**:

| Source | Directory | Badge |
|--------|-----------|-------|
| System | `~/.claude/commands/` | `sys` |
| Repo | `.claude/commands/` (project root) | `repo` |
| Plugins | `~/.claude/plugins/cache/**/skills/*/` | `sys` |

Each directory is scanned for `.md` files. Frontmatter (`name`, `description`) is parsed. No persistent file watcher — scan-on-open is fast enough given how rarely skills change. Cache is explicitly busted when a newly defined skill is saved.

---

## UI Components

### `ProceduresPanel` (rewrite of existing placeholder)

Fixed 160px sidebar panel inside `RunWorkspaceWidget`.

- **Inherited group** (from Epic / Initiative): labeled with entity name, rendered above a divider
- **Task group**: task-own procedures
- Each row: icon + skill name + `▶` run button (visible on hover)
- **Shimmer rows**: optimistic entries for in-progress skill definitions — pulse animation, placeholder name from typed description
- **`+ New` button** at bottom: opens `SkillPickerModal`

### `SkillPickerModal` (new)

Full-screen overlay with centered command picker (480px wide).

**Input:** placeholder `"Search or define skill…"` — dual-purpose.

**Behaviour:**
- Typing filters skills by name
- Each skill row shows: icon, name, description, source badge (`sys` / `repo`), star button
- **Star button** → inline entity popover (Task / Epic / Initiative, current task highlighted) → selecting an entity adds the procedure immediately (optimistic)
- **No match state**: list collapses to a single focused row: `Define "[typed text]" as new skill… ↵`
- **Partial match state**: filtered results shown + define row at bottom with typed text
- `↵` on define row: closes picker, fires to agent, adds shimmer entry to sidebar

**Keyboard:** `↑↓` navigate, `↵` select/define, `Esc` close.

### `SaveSkillModal` (new)

Small modal appearing after agent drafts a new skill.

- Shows skill name preview
- Two options: **System** (`~/.claude/skills/`) or **Repo** (`.claude/skills/`)
- Confirm → `POST /api/skills/save` → skill written to chosen location, cache busted, shimmer resolves
- Cancel → draft deleted, shimmer fades out

### `useSkills` hook (new)

- Fetches `/api/skills` on mount (cached)
- Subscribes to `skill.drafted` SSE event → triggers `SaveSkillModal`
- Exposes `pendingSkills: string[]` for shimmer state management

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
{ draftId: string, location: 'system' | 'repo' }
```

Busts the skill cache after write. Emits `skill.saved` SSE event.

### Skill staging

When the agent defines a new skill, it writes to `~/.config/tinstar/skill-drafts/[id].md`. The backend watches this directory (fs.watch, scoped and cheap — this is the one location worth watching since it's the hot path for the define flow) and emits `skill.drafted` SSE event to the frontend.

### Procedures persistence

`PATCH /api/entities/:type/:id/procedures` — adds/removes procedures on a Task, Epic, or Initiative. Persists to existing entity storage under `~/.config/tinstar/`.

### Session input

Running a procedure fires the slash command into the active Claude session via the existing **prompt submission API** (not raw send-keys). `POST /api/sessions/:id/prompt` with `{ text: "/design" }`.

---

## Define-New-Skill Flow (end-to-end)

1. User types description in picker → `↵`
2. Picker closes immediately
3. Shimmer entry appears in procedures sidebar (pulse animation, typed text as placeholder name)
4. UI fires message to active session via prompt API: `"Define a new skill: [description]"`
5. Agent writes skill draft to `~/.config/tinstar/skill-drafts/[id].md`
6. Backend detects draft file → emits `skill.drafted` SSE event
7. `SaveSkillModal` appears: System or Repo?
8. User confirms → draft moved to chosen location → cache busted
9. Shimmer resolves to final skill name

**Failure path:** If no `skill.drafted` event arrives within 30s, shimmer entry shows error state (red tint, retry option). User can dismiss.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Skill directory missing | `/api/skills` returns empty array for that source, no error |
| Agent fails to define skill | Shimmer entry shows error state after 30s timeout |
| User cancels SaveSkillModal | Draft deleted, shimmer entry fades out |
| Duplicate skill name | Picker highlights existing skill, star it instead |
| Procedure entity deleted | Inherited procedures silently dropped from resolved list |

---

## Testing

**Unit tests:**
- Skill discovery: mock filesystem, verify frontmatter parsing and source tagging
- Procedure inheritance: Task + Epic + Initiative → merged list in correct order

**E2E (Playwright):**
- Open picker → search for skill → star it → verify appears in sidebar
- Open picker → type unknown description → `↵` → verify shimmer appears in sidebar
- Complete define flow → verify shimmer resolves to skill name

---

## Out of Scope

- Custom prompt editing per procedure (post-MVP)
- Reordering procedures within the sidebar (post-MVP)
- Keyboard shortcut (1–8) hotbar for procedures (post-MVP)
- Procedure run history / status tracking (the current status model is removed)
