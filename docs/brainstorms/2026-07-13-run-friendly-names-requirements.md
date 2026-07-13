---
date: 2026-07-13
topic: run-friendly-names
---

# Run Friendly Names

## Summary

Give every run an optional friendly name — free text like `PM Vpp project` — that the UI shows wherever it shows the raw run id today. The name defaults to the id, so nothing changes visually until someone sets one, and any run can be renamed at any time from the sidebar or the run card header. The run id itself stays immutable.

## Problem Frame

A run's id is its identity everywhere that matters physically: it is the tmux session name, the worktree directory, the git branch, the NATS subject token, and the key under which widget layouts, pins, and constellations are stored. It is chosen once, at creation, from a free-text field — and it is never correctable, because correcting it would mean moving a worktree, renaming a branch, and re-keying a broker subject.

Two things make the ids degrade. Typos survive forever (`general-pourpose`). And hand-spawned runs are named by concatenation — parent name, hand role, a random suffix — so a hand of a hand of a run inherits the whole chain and adds to it. The result is a fleet whose sidebar reads as a wall of near-identical slugs, where telling one run from another means reading the middle of a 40-character string.

The cost is paid every time the user scans the sidebar, the inbox, or the fleet view to find the run they want, which is many times an hour.

## Key Decisions

**The id stays immutable; the friendly name is a separate, display-only field.** Renaming the id is not a display change — it is a filesystem, git, and broker migration. A parallel display field gets the entire benefit at none of that risk. This is the decision the whole feature rests on.

**The friendly name defaults to the run id, not to a derived name.** Deriving a default from the task name or from an LLM summary of the opening prompt were both considered and rejected: they add a rule (or a model call) to the create path that can be wrong, and they buy little for runs the user creates by hand, since the user is already typing a name in that moment. A run is born showing its id, exactly as today, and becomes nicer only when someone names it.

**Friendly names are not unique and nothing addresses a run by one.** Every route, subject, socket path, and storage key stays keyed by the id. Two runs can both be called `PM Vpp project` without ambiguity, because nothing ever has to resolve that string back to a run. This is what keeps the field cheap — it removes any need for collision suffixes, uniqueness checks, or a rename-safety story.

**Hands get named by their spawning agent, via a nudge in the `tinstar-hand` skill, not by an API requirement.** The worst names in a fleet belong to runs no human ever named. The fix is to put the naming in the hands of the only party that knows what the hand is for — the agent spawning it — at the moment it spawns it. Making the API *require* a name would force every existing caller to change and would produce a hard failure where a soft default is fine.

## Requirements

**The name itself**

R1. A run has an optional friendly name: free text, including spaces, capitals, and punctuation. It is not passed through the id sanitizer that strips those characters.
R2. When a run has no friendly name, every surface falls back to displaying the run id. A fresh install and an untouched run look exactly as they do today.
R3. A run's friendly name persists across server restarts and survives the boot rehydrate that reconstructs runs from sessions.
R4. Setting a friendly name never changes the run id, the tmux session, the worktree path, the git branch, or the NATS subject.

**Where it shows**

R5. Every surface that renders a run's id to the user renders the friendly name instead, falling back per R2. This covers at minimum: the run card header, the hierarchy sidebar, the task-group widget, the inbox, the fleet view, the Saloon header, and the agent avatar tooltip.
R6. The run id remains reachable from the run card header — the friendly name is the title, and the id sits beneath it in a muted line that copies to the clipboard on click.
R7. The hierarchy sidebar exposes the run id on hover, so a run can be identified without opening its card.
R8. A retired run's tombstone carries the friendly name it had at retire-time, so the graveyard stays readable.

**Editing**

R9. A run can be renamed inline from the hierarchy sidebar, using the same interaction the taxonomy entities already use — Enter commits, Escape cancels, blur commits.
R10. A run can be renamed from its run card header by clicking the title.
R11. A rename appears immediately in the UI without waiting for the server round-trip.
R12. Clearing a run's friendly name reverts it to displaying the id.

**Hands**

R13. A hand can be given a friendly name at spawn time, so it is born named rather than renamed afterwards.
R14. The `tinstar-hand` skill instructs the spawning agent to give each hand it spawns a friendly name describing that hand's job.
R15. An agent can set or change a run's friendly name — its own or another's — through the same interface a human uses. No agent-only or human-only path.

## Acceptance Examples

AE1. **Covers R2, R5.** A run created today, never renamed, appears in the sidebar as `vpppm-general-pourpose-2dc86` and in its card header as it does now. Nothing about the fleet looks different from before the feature shipped.

AE2. **Covers R9, R11, R5.** The user clicks the pencil on that run in the sidebar, types `PM Vpp project`, and presses Enter. The sidebar row changes on keypress. The run's card header, its inbox rows, and its fleet row all read `PM Vpp project` without a reload.

AE3. **Covers R4, R6.** After AE2, `tmux ls` still lists `tinstar-vpppm-general-pourpose-2dc86`, and the worktree is still on disk under its original directory. The user clicks the muted id line under the card title and pastes `vpppm-general-pourpose-2dc86` into a terminal.

AE4. **Covers R12.** The user renames the run to an empty string. The sidebar reverts to showing `vpppm-general-pourpose-2dc86`.

AE5. **Covers R13, R14.** An agent working in `PM Vpp project` spawns a reviewer hand and, following the skill, names it `Reviewer — dispatch retry`. The hand appears in the sidebar under that name on first render, never having displayed its generated id.

AE6. **Covers R13, R2.** A different agent spawns a hand without passing a friendly name. The hand appears under its generated id. Nothing errors.

AE7. **Covers R1.** The user names a run `PM: Vpp project (Q3)`. The colon, spaces, and parentheses are preserved. The run id is unchanged and still contains none of those characters.

## Scope Boundaries

- **No derivation of names.** Not from the task name, not from the opening prompt, not from a model call. Rejected in dialogue; see Key Decisions.
- **No uniqueness enforcement.** No collision suffixes, no "name already taken" error.
- **No lookup by friendly name.** API routes, NATS subjects, and session commands stay id-keyed. There is no "attach to `PM Vpp project`".
- **No change to id generation.** The New Session dialog keeps its current single-name field and its sanitizer. Splitting creation into a friendly-name field plus a derived id was considered and is not part of this.
- **No change to telemetry.** The Prometheus `tinstar_session` label and OTEL resource attributes stay keyed by the id, so historical series remain continuous.

## Dependencies / Assumptions

- The run entity is persisted wholesale as a document, so an added field persists without a migration. **Verified** against the docstore snapshot and hydrate paths.
- The boot path that reconstructs runs from sessions spreads the existing run record rather than rebuilding it, so a friendly name survives a restart. **Verified**; only the cold-create path builds a run from scratch, and that path has no name to preserve.
- The run PATCH route is a catch-all merge, so a name field lands and persists without a new endpoint. **Verified**, though the field is undocumented in the API schema and should be added there.
- The sidebar's inline rename already exists and is explicitly guarded off for runs. **Verified.** Removing that guard is the intended path, not a new rename UI.
- The optimistic-update hook already maps the run entity, so R11 needs wiring, not new machinery. **Verified.**
- **Assumption, unverified:** no plugin or external consumer reads a run's displayed label and depends on it being the id. Worth a grep during planning.

## Sources / Research

Code locations that orient the planner:

- `src/domain/types.ts` — `RunData` / `Run`. No name, title, or label field exists today. The field goes here.
- `src/server/api/routes.ts` — `PATCH /api/runs/:id` (catch-all merge, already persists arbitrary run fields); `POST /api/sessions/:name/spawn` (hand naming by concatenation); `POST /api/sessions` (`runId = name`).
- `src/server/api/openapi.ts` — the run PATCH schema, which lists only `taskId`, `attention`, `background`.
- `src/domain/grouping.ts` — `label: run.id`, in three separate tree-build paths. Feeds both the sidebar and the task-group widget.
- `src/components/HierarchySidebar.tsx` — the inline rename, and the `node.type !== 'run'` guard in `commitRename` that currently blocks it.
- `src/components/WorkspaceShell.tsx` — `handleRename`, the existing PATCH-per-entity-type dispatcher.
- `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx` — renders `Run_{run.id}` as the title; also holds the color-picker PATCH, the closest existing precedent for editing a run field in place.
- `src/hooks/useServerEvents.ts` — `applyOptimistic`, which already maps the run entity.
- `src/hooks/useInbox.ts` — `sourceLabel: run.id`.
- `src/plugins/roborev/src/FleetView.tsx`, `src/plugins/nats-traffic/src/Saloon.tsx`, `src/plugins/graveyard/src/GraveyardWidget.tsx`, `src/components/CanvasHud/AgentAvatar.tsx` — the remaining display surfaces.
- `agent-skills/tinstar-hand/` — where the naming nudge for spawning agents lands.

Why the id cannot be renamed instead (each is a hard dependency on the id string):

- `src/server/sessions/backends/tmux.ts` — tmux session name, session state directory, NATS control socket path, injected `TINSTAR_SESSION_NAME`.
- `src/server/sessions/workspace.ts` — worktree directory and `git worktree add -b <sessionName>`.
- `src/server/sessions/nats-subscriptions.ts` — the DM subject's trailing token.
- `src/hooks/useWidgetLayouts.ts` and the docstore's constellation and pin records — all keyed by the `run-<id>` node id.
