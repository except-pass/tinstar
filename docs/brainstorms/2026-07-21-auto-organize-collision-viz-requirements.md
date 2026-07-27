---
date: 2026-07-21
topic: auto-organize-collision-viz
---

# Auto-organize: Relationship & Collision Visualization

## Summary

Once runs are sorted into durable groups (Unit 7), draw the relationships between them directly on the canvas as an overlay — who spawned whom, which repo and worktree each run lives in, which runs are related versus independent. The headline new signal is collision detection: when two related runs share a worktree and their git diffs touch the same files, put a warning badge on the glass. Nothing moves; the relationships are painted on top of the arrangement the user built.

## Problem Frame

The user runs many agents at once and, past a handful, loses the mental model of how they fit together. He has said the panic plainly: "are they colliding? same workspace? stepping on each other? I don't know." Those are three distinct questions — is this run a child of that one, are these two in the same repo/worktree, are these two even related — and today all three are answered only by clicking into each run and reading scrollback, or by remembering what he set up an hour ago.

Unit 7 gives the runs durable membership: it categorizes them into groups from observable signals (spawn lineage, repo, worktree). But membership is a fact in a data structure, not something the eye can see on the canvas. A group the user cannot perceive spatially is a group he still has to reconstruct in his head — which is the exact cost the product exists to remove.

The collision question is the sharpest of the three and the one nothing in the product answers. A parent and the hand it spawned very often share a worktree, because spawned hands inherit the parent's task and workdir. Two agents editing the same file in the same worktree will clobber each other, and the user finds out only when something breaks. Yet Tinstar already has every fact needed to warn him first: it polls each run's worktree with `git diff --numstat` and stores the result as `touchedFiles` on the run (`src/server/sessions/git-diff.ts`, populated in `src/server/index.ts`). The changed-files panel in the run card already shows this per run. Nobody has cross-referenced those file lists across related runs. That cross-reference is the whole feature: observable artifacts the product already holds, lifted onto the pane as an answer.

## Key Decisions

**Relationships are an overlay, never a rearrangement.** The load-bearing constraint of both auto-organize units is that arrangement is the user's — spatial memory is destroyed the instant a widget moves on its own. So this unit is forbidden from moving anything. It draws lineage links, repo tints, cluster hulls, and collision badges *on top of* wherever the user placed each widget. The relationship layer and the layout layer are independent: the user can reset or rearrange the canvas and the overlay simply re-renders against the new positions. This is the same discipline the constellation system already respects (a reset-layout button exists; auto-organize adds no spatial movement of its own).

**Collision is derived, not declared.** A collision is not a state an agent reports or a lock the product takes out. It is a computed predicate over data already on the runs: two runs collide when they share a worktree AND the intersection of their `touchedFiles` paths is non-empty. Both halves are required. Same worktree with disjoint files is fine — two agents can safely work different corners of one tree. Overlapping filenames in different worktrees is fine — that is just two copies of a file, no contention. Only the conjunction means "stepping on each other." Because it is derived, it updates as the diffs update and clears itself with no user action when the overlap goes away.

**Legibility is the goal, not completeness.** The bar is "the user glances and understands how these runs relate," not "every possible relationship edge is drawn." Three relationship facts are in scope because the user named them: parent/child lineage, repo/worktree location, and related-vs-independent. A dense graph of every conceivable edge would be less legible, not more. When in doubt, draw fewer, clearer marks.

**The overlay reads group membership; it does not compute it.** Unit 7 owns the question "which runs form a group and why." This unit consumes that membership and annotates it. If Unit 7 says two runs share a worktree group, this unit draws the halo and runs the collision check across that group's members. It never re-derives grouping.

## Requirements

**Lineage visualization (parent/child)**

R1. When a run was spawned by another run (spawn lineage, as tracked by Unit 7's grouping signals), the canvas shall draw a directed link from parent widget to child widget so the direction of the spawn is visible at a glance.

R2. Lineage links shall be rendered as a canvas overlay anchored to the current positions of the two widgets, and shall re-anchor when either widget is moved, without moving either widget.

R3. Lineage links shall remain legible under pan and zoom, and shall visually recede (not disappear) when the related widgets are far apart or off-screen, so a long link never dominates the canvas.

R4. When a parent has multiple children, all child links shall be distinguishable rather than collapsing into one ambiguous bundle.

**Repo / worktree encoding**

R5. Each run widget shall carry a visual encoding of the repo it is running in (for example a color tint or halo), so runs in the same repo read as visually kin without the user opening any of them.

R6. The repo encoding shall be stable for a given repo across the session, so the user learns "the green ones are the API repo" and that mapping does not shift underneath him.

R7. Runs sharing a worktree (not merely the same repo) shall be distinguishable from runs that merely share a repo, because shared-worktree is the collision-relevant relationship and same-repo-different-worktree is not.

R8. The repo/worktree encoding shall degrade gracefully when a run has no worktree or an unknown repo — rendered as a neutral/absent state, never as a false shared-repo signal, and never as a zero-value stand-in.

**Related vs independent**

R9. Runs that belong to the same durable group (per Unit 7) shall be visually clustered on the canvas — for example a soft hull or affordance drawn around their current positions — so related runs read as a set and independent runs read as standalone.

R10. Cluster affordances shall be drawn from the widgets' existing positions and shall not intercept pointer events for the widgets beneath them, so the overlay never blocks interaction with a run it surrounds.

R11. A run that belongs to no group (independent) shall carry no cluster affordance and no lineage link, so "unrelated and alone" is legible by the absence of marks.

**Collision detection & warning**

R12. The product shall continuously evaluate, across the members of each shared-worktree group, whether any two runs' `touchedFiles` path sets intersect, reusing the per-run git-diff data already produced by `src/server/sessions/git-diff.ts` — no new watcher.

R13. When two related runs share a worktree AND touch at least one file in common, the product shall surface a collision warning badge on both involved widgets (and/or on the link between them), reading as "these two are stepping on each other."

R14. The collision badge shall let the user see *which* file(s) overlap without opening either run — the answer, not just the alarm.

R15. The collision badge shall clear automatically when the overlap resolves (one run commits, reverts, or moves off the shared file), with no user action required to dismiss it.

R16. Collision evaluation shall fire only on the shared-worktree + overlapping-files conjunction; runs that are unrelated, or in the same repo but different worktrees, or in the same worktree but touching disjoint files, shall not raise a collision.

R17. The collision signal shall be derived server-side from run state and delivered to clients over the existing SSE stream as run state, so every viewer (including future multiplayer participants) sees the same warning — it is not a client-local computation.

## Key Flows

F1. **Two related runs edit the same file.**
**Trigger:** A parent run and its spawned hand share a worktree; the hand saves an edit to `src/server/api/routes.ts`, a file the parent has also modified.
**Actors:** The two runs (data source), the git-diff poller, the collision evaluator, the user (observer).
**Steps:** The poller refreshes each run's `touchedFiles` from `git diff --numstat`. The evaluator, scoped to the shared-worktree group, intersects the two path sets and finds `routes.ts` in both. It marks both runs as colliding on that path and emits the updated run state over SSE. The canvas overlay renders a collision badge on both widgets naming the overlapping file.
**Outcome:** The user sees "⚠ these two are stepping on each other — `routes.ts`" without having opened either run, and can intervene before the clobber.

F2. **The user glances to reconstruct the mental model.**
**Trigger:** The user returns to a busy canvas after a break and wants to know how the runs relate.
**Actors:** The user, the relationship overlay.
**Steps:** Without clicking anything, the user reads the lineage links (which run spawned which), the repo tints (which runs are in which repo), the cluster hulls (which runs form a related set, which stand alone), and any collision badges.
**Outcome:** The three questions — parent/child, same workspace, related-or-not — are answered by looking, not by opening runs or reading scrollback.

F3. **A collision resolves.**
**Trigger:** One of the two colliding runs commits its change to `routes.ts`, so the file leaves its uncommitted `touchedFiles`.
**Actors:** The git-diff poller, the collision evaluator.
**Steps:** The next poll drops `routes.ts` from that run's touched set. The evaluator recomputes the intersection, finds it empty, and clears the collision on both runs. SSE carries the cleared state.
**Outcome:** The badge disappears on its own; the user is not left dismissing a stale warning.

## Acceptance Examples

AE1. **Collision fires only on the conjunction.**
Given run P and run C share worktree `~/wt/feature-x`, and both have `src/routes.ts` in `touchedFiles`, When the evaluator runs, Then both P and C show a collision badge naming `src/routes.ts`. *(Covers R12, R13, R16)*

AE2. **Same worktree, disjoint files — no collision.**
Given P and C share a worktree but P touches only `a.ts` and C touches only `b.ts`, When the evaluator runs, Then neither shows a collision badge. *(Covers R16)*

AE3. **Same filename, different worktree — no collision.**
Given P is in worktree `wt-1` and C is in worktree `wt-2`, and both touch a file named `config.ts`, When the evaluator runs, Then neither shows a collision badge, because the paths belong to different trees. *(Covers R7, R16)*

AE4. **Unrelated runs never collide.**
Given run X and run Y are in no shared group and different worktrees, When either edits any file, Then no collision is raised between them. *(Covers R11, R16)*

AE5. **The overlay never moves a widget.**
Given the user has placed three related runs at specific canvas positions, When lineage links, repo tints, and a cluster hull are drawn for them, Then all three widgets remain at exactly their user-set positions. *(Covers R1, R2, R9, R10)*

AE6. **The badge clears when overlap resolves.**
Given P and C are colliding on `routes.ts`, When P commits `routes.ts` and the next git-diff poll drops it from P's touched set, Then the collision badge disappears from both P and C with no user action. *(Covers R15)*

AE7. **Repo tint degrades, not lies.**
Given a run has no worktree and an unknown repo, When its widget renders, Then it shows a neutral state and is not tinted as sharing any repo with another run. *(Covers R8)*

## Scope Boundaries

**Deferred for later**

- **Cross-repo semantic relatedness.** Detecting that two runs in *different* repos are working on the same feature (by transcript similarity, shared ticket, or overlapping symbol names) is a richer relationship signal worth exploring later. This unit's "related" is the structural relatedness Unit 7 already computes (lineage, repo, worktree), not semantic inference.
- **Hunk-level collision precision.** This unit detects overlap at the file path. Narrowing to "same hunk / same lines" (two runs touching different functions in one file are arguably not colliding) is a precision upgrade deferred until the file-level signal proves too noisy in practice.
- **Cross-worktree "same logical file" warnings.** Warning that two runs in different worktrees of the same repo are both editing the same tracked file (a real but weaker contention, resolved at merge rather than at save) is out of the first cut, which stays on the concrete same-worktree clobber.

**Outside this product's identity**

- **Auto-resolving or merging collisions.** The product makes the collision *visible* and stops there. It does not take a lock, block a save, auto-stash, or attempt a merge. Arbitrating who wins a shared file is a judgment call that belongs to the user (and the underlying git), consistent with "observable artifacts over agent cooperation" — the product reports what it sees and lets the human act.
- **Rearranging the canvas to express relationships.** Auto-tiling related runs together, repacking clusters, or moving a child next to its parent are all forbidden by the never-auto-manage constraint. Relationships are painted, not staged.

## Dependencies / Assumptions

- **Unit 7 (Auto-organize: durable grouping)** — the hard dependency. It owns the membership this unit annotates: which runs form a group, the spawn-lineage edges, and the repo/worktree assignment. This unit renders and cross-references that membership; it never computes grouping itself.
- **Existing per-run git-diff watching** — `src/server/sessions/git-diff.ts` (`getGitDiffFiles`, `git diff --numstat`) already produces each run's `touchedFiles: TouchedFile[]` (`src/domain/types.ts`), polled in `src/server/index.ts` and already surfaced in the run card's changed-files panel. Collision detection reuses this exhaust; it adds no new file watcher.
- **Canvas overlay surface** — assumes the overlay can be drawn against live widget positions from `src/hooks/useWidgetLayouts.ts` under the `src/components/InfiniteCanvas.tsx` pan/zoom transform, in the same spirit as the existing constellation chrome (`src/canvas/ConstellationChrome.tsx`), without owning or mutating layout.
- **SSE run-state delivery** — assumes the derived collision flag rides existing run state over `/api/events` (`src/server/api/sse.ts`), so it is server-authoritative and consistent for every viewer, including future multiplayer participants (Units 1–4).
- Assumes runs already carry a resolvable `worktree` and repo identity (they do: `worktree: string` on the run in `src/domain/types.ts`).

## Outstanding Questions

**Resolve before planning**

- **What counts as "overlap"?** File-path intersection is the proposed first cut (R12). Confirm file-level is the right granularity for the first ship, versus jumping straight to hunk-level. File-level is cheaper and catches the dangerous case; hunk-level is more precise but needs line ranges the current `--numstat` data does not carry.
- **Does a collision also warn across *unrelated* runs that happen to share a worktree?** Two runs the user launched independently can still land in the same worktree and clobber each other. The predicate in R12/R16 is worktree + files, which would catch them regardless of lineage — but "related" framing in the user's ask centers on spawn lineage. Decide whether collision is scoped strictly to grouped/related runs or to any two runs sharing a worktree (the latter is arguably more useful and the same computation).

**Deferred to planning**

- **How noisy before it is annoying?** Long-lived runs accumulate large touched sets, so a shared config file (`package.json`, a lockfile) could raise a permanent low-value collision. Consider whether certain paths are excluded, whether badges age out, or whether the signal needs a "meaningful overlap" threshold — settle during planning once the raw signal is observable.
- **Where exactly the badge lives** — on each widget, on the lineage link, or both — and how the overlapping-file list is disclosed (inline vs on hover/expand) per R14.
- **Visual language for repo encoding** — tint, halo, corner tag, or border — and how it coexists with the constellation chrome without visual collision of its own.
