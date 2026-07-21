# Tinstar v5.3 — feature reference

Single-source reference for every feature shipped in v5.3. Organized by subsystem. Points at the relevant code and existing timeless docs.

> **Why this doc exists:** v5.0–5.2 built the plugin platform, the ecosystem, and a richer canvas. v5.3 is about **agents that talk to you** and **a fleet you can keep tidy**. Three throughlines: **(1) The Graveyard** turns dead sessions into a durable, queryable memory — a session that has ended leaves a tombstone you can revive and *ask questions*, now filterable by project and worktree. **(2) Roundup** is a live notice board where agents author their own UI — notices render via an agent-to-UI schema (A2UI), and you answer, dismiss, and ask follow-ups without leaving the widget. **(3) Organizing a busy fleet** — runs get friendly display names, projects can be starred/hidden/reordered, and sessions can launch hidden or spawn passively so background work stops fighting for canvas space. Underneath: non-Claude agents (cursor/codex/generic) launch cleanly, the marshal runs on Sonnet with the tinstar skill pre-loaded, shell execution and dependencies were hardened, and CLI-template edits go live without a server restart. The per-feature brainstorms and plans that drove each of these are retired; this file is the pointer map to the living code. Same pattern as `release-notes-v5-2.md`.
>
> No new ADRs this release — v5.3 builds on the two from v5.0 (`docs/adrs/0001-response-envelope.md`, `docs/adrs/0002-plugin-api-boundary.md`). Every API added below returns the ADR-0001 envelope and lives behind the ADR-0002 boundary.

---

## The Graveyard — necro dead sessions to ask them questions

**A headline of v5.3.** When a session ends, its context is normally gone. The Graveyard keeps a **tombstone** for every retired run so you can bring it back and interrogate what it knew.

- **Tombstone snapshot.** At retire-time a snapshot captures the run's identity and workspace so the grave survives the live session's disappearance. The tombstone carries `displayName`, `project` (resolved from entity settings at retire-time — the only source, so older graves have no project by design and there is no backfill), and a `worktree` derived from the workspace path (so it works on *every* grave).
- **Revive to question.** A grave can be reanimated into a fresh session that answers with the dead run's context — you ask a question, the necro'd agent responds.
- **Project + worktree search.** The widget gains a text search plus Project/Worktree chip rows that *compose*: chips narrow the set, then the query runs over what's left. A facet row with no values hides rather than showing a lone "all".
- **Palette-registered.** The widget is registered in the **server-side** palette registry (not just client-bundled) so the tile is actually visible — the client-only registration was a silently invisible tile (see `docs/solutions/` on the two-place plugin-registration gotcha).
- **Correctness guard.** `tombstoneEqual()` now compares `displayName` and `project`, so re-tombstoning a renamed run emits the change instead of silently keeping the stale name.

Code: `src/server/sessions/graveyard-snapshot.ts` (snapshot), `src/server/api/` (graveyard route), `src/server/stores/` (docstore graveyard store), `src/plugins/graveyard/src/` (`GraveyardWidget.tsx`, `types.ts`), `public/widget-icons/graveyard.svg`.

---

## Roundup — a live notice board agents author themselves

**A headline of v5.3.** Agents need a way to raise something to you that isn't a chat line buried in a transcript. Roundup is a **live notice board**: agents post notices, you triage them, and the notices render themselves.

- **Agent-authored notices.** A notice is posted by the agent and appears on the board live. Old notices recede; you can dismiss them.
- **A2UI rendering (agent-to-UI).** Instead of a fixed card layout, a notice ships a small UI *schema* the widget renders from a whitelisted control catalog — the agent decides what the notice looks like, within a safe, typed vocabulary. Started read-only, then grew interactivity.
- **Answer, dismiss, follow up.** You can answer a notice's controls from the widget (the answer flows back to the agent), dismiss a notice so it recedes, and ask a **follow-up question** on a notice — a two-way exchange, not a one-shot alert.
- **Agent skill.** The `roundup-notices` agent skill teaches agents how to post and shape notices.

Code: `src/plugins/roundup/src/` (`RoundupWidget.tsx`, `age.ts`), `src/plugins/roundup/src/a2ui/` (`A2uiRenderer.tsx`, `schema.ts`, `catalog.tsx`, `controlComponents.tsx`, `controls.ts`, `followUps.ts`), `agent-skills/skills/roundup-notices/SKILL.md`, `public/widget-icons/roundup.svg`.

---

## Organizing a busy fleet

As the number of runs and projects grows, the canvas and sidebar need a way to stay legible. v5.3 adds naming, curation, and quieter spawning.

### Friendly run display names

Runs get human-readable display names instead of raw session ids. The name is editable inline from the run workspace title, and reused session names no longer leave **hidden-run ghosts** lingering in the hierarchy.

Code: `src/domain/` (run display name), run workspace title editing, hidden-runs de-ghosting.

### Star, hide, and reorder projects

Projects can be **starred** (float to the top), **hidden** (removed from the picker without deleting), and **reordered**. The ordering is honored everywhere a project is chosen — the create-session dialog, the project picker, settings, and onboarding.

Code: `src/lib/projects.ts`, `src/components/ProjectPickerOptions.tsx`, `src/components/SettingsDialog.tsx`, `src/server/sessions/workspace.ts`, `src/server/api/routes.ts`.

### Hidden background sessions & passive spawn

Sessions can now be **hidden by default** (background work that doesn't clutter the canvas) and spawned **passively** (`focus:false`) so a newly created run lands on empty canvas space without stealing focus.

Code: `src/server/sessions/` (hidden-by-default sessions), passive-spawn + empty-canvas placement wiring.

---

## Agents & sessions — launch, marshal, isolation

- **Non-Claude agents launch cleanly.** Cursor, Codex, and generic CLI agents now start without the Claude-specific launch assumptions tripping them up.
- **Marshal on Sonnet.** The marshal upgrades to Sonnet and pre-loads the `tinstar` skill, so the traffic-cop agent knows the control plane out of the box.
- **NATS `.mcp.json` out of the workspace.** The per-session NATS `.mcp.json` is written outside the git workspace, so it can't leave the repo dirty (see `docs/solutions/` on the resolver reading `--mcp-config`).
- **Orphan ttyd reaping.** ttyds whose tmux session has died are reaped on restart.

Code: `src/server/sessions/backends/tmux.ts`, `src/server/sessions/` (mcp-config placement, ttyd reaping), marshal config.

---

## Telemetry, downloads & widgets

- **Tool-call whisker.** The turn-length histogram overlays a per-bucket **tool-call whisker**, so you can read how many tool calls a turn made against how long it ran.
- **Agent-pushed browser downloads.** An agent can push a file straight to your browser as a download — no clicking through the file tree (see the `tinstar-push-file` skill).
- **WIDGETS palette resizable.** The palette is vertically resizable, and the `ServerStatusDot` popover portals out of the palette's overflow-clip so it isn't cut off.
- **Reject self-embed.** Browser widgets refuse to embed Tinstar inside itself (which caused lockups).
- **Saloon Clear.** The firehose header gets a Clear button.

Code: `src/plugins/model-attribution/` + telemetry (whisker), agent-pushed downloads, `src/components/` (palette resize, `ServerStatusDot`), `src/widgets/primitives/` (self-embed guard), saloon firehose.

---

## Reliability, security & polish

- **Hardened shell execution + dependency bumps.** Shell command execution was hardened and vulnerable dependencies updated.
- **Swallowed errors logged.** Errors that were silently dropped are now logged instead of vanishing.
- **CLI-template edits hot-reload.** Editing a CLI template reflects without a server restart.
- **File-editor pins & images.** `submitPin`/`replyToPin` are stabilized via a `pinsRef` (no stale closure), and relative markdown image paths resolve through the image-file endpoint.
- **Canvas.** Reset-layout reserves constellation footprints so widgets don't overlap; the constellation star replays its entrance pop on focus; plugin browser-primitive widgets no longer double-render pins.
- **Coverage & refactor.** Unit tests added for low-coverage modules; shared utilities extracted for duplicated patterns.
- **CI guard.** A case-only filename-collision check now runs on every PR (the v5.2.0 lesson, promoted from release pre-flight to a standing gate).

Code: `src/server/` (shell hardening, error logging, CLI-template reload), `src/plugins/file-editor/`, `src/canvas/`, `scripts/check-case-collisions.mjs`, `.github/workflows/ci.yml`.
