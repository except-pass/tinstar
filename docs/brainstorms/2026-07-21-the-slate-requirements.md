---
date: 2026-07-21
topic: the-slate
status: ready-to-plan
supersedes:
  - 2026-07-21-fan-out-surfaces-and-open-points-requirements.md
  - 2026-07-21-a2ui-run-workspace-requirements.md
---

# The Slate — requirements / design

**The Slate** is a new region of the run workspace card where an agent (or the user, or
any local process) paints small, interactive, A2UI-described surfaces scoped to *that one
run* — open points, forms, tables, choices, progress cards, diagrams. It's the run's own
drawing board: chalk a panel on, rewrite it as things change, wipe it clean when it's
resolved. "Out of the brain onto the pane," per session.

**Prototype:** the interactive strawman published this session (session `a2ui`) — the
"pane of glass" showing a session's content laid onto scoped, two-way surfaces.

---

## 1. Problem

An agent talks to the user through a single linear transcript. The transcript is the
source of truth, but a scroll is a poor interface to it: the user runs several sessions
at once, must read serially, and can only reply at one point. To talk about one facet
they must re-describe it. Anything an agent "decides it's done with" (open questions it
resolved by assumption, follow-up work, calls it made, the status of a long-running
command) evaporates into the scroll. (Origins: CMT-1302 — an agent believed it was done
while an unresolved human decision remained; session vppOps — a long-running deploy with
no live status surface, so the user had to ask.)

**Why not the Roundup.** The Roundup is a *global* board aggregating every session's
notices. At ~10 concurrent sessions it's a firehose — you cannot visualize per-session
state there. The rich, detailed surface belongs **inside each run's own workspace**, not
in a cross-session aggregate. (Roundup rework is explicitly out of scope — see §11.)

## 2. The Slate: home is the run workspace card

The Slate is a **distinct region of the `RunWorkspaceWidget`**, additive to the existing
panels. Target layout: `[files] [session — skinnier] [The Slate] [telemetry]`. When a run
has no Slate content, the card renders its current layout unchanged (the Slate is
additive, never displacing derived facts). At 10-up density the Slate column is the hero;
files/telemetry stay compact and the surface can expand.

Reference: `src/components/RunWorkspaceWidget/` (FileTreePanel, RunSessionPanel,
TelemetryPanel, TouchedFilesPanel, HandsPanel, index.tsx).

## 3. Core primitive: the addressable threaded point

Every Slate surface decomposes to one primitive. Build **one primitive**, render it in
different frames — do not build parallel special cases.

An **addressable point** is:

- **authored** by the agent, the user, *or any local process* (author-agnostic — this
  unifies agent-authored notices, user-authored comments, and a shell script reporting
  its own progress);
- **anchored** optionally: nothing (a standalone open point), a decision, or a whole
  surface (a per-surface discussion thread);
- **threaded** — an append-only discussion of `Reply { author, text, createdAt }` (the
  type already shared by `src/domain/pinSet.ts` and the Roundup follow-ups);
- **lifecycled** — open → discussing → waiting → resolved, plus dismissed; soft (the
  thread stays readable), never hard-deleted;
- **live** — create/amend/resolve fans out over an SSE delta.

This is the strongest form of "converge": a notice, a canvas pin, an FYI comment, and a
per-surface thread are the same object with a different anchor and default author.

## 4. Rendering: reuse the shared A2UI stack (do not fork it)

Surfaces are described in **A2UI** (the `@a2ui/web_core` v0_9 schema already adopted for
Roundup notices) and drawn by the existing host-owned, host-themed renderer. We adopt the
**schema, not the runtime** (standing decision — see
`docs/plans/2026-07-17-002-feat-roundup-a2ui-rendering-plan.md`, KTD1).

**R1.** The Slate renders A2UI content by calling the existing shared renderer
(`A2uiRenderer`), not a re-implemented walker.
**R2.** Reuse the renderer budgets unchanged — `MAX_DEPTH`, `MAX_NODES` (stops diamond-ref
explosion), and the per-surface React error boundary — so a hostile/malformed panel can
never hang or blank the run card.
**R3.** Reuse the host `CATALOG` and the `safeHref` allowlist, so a `javascript:`/`data:`
URL in a `Link` degrades to plain text as it does in a notice.
**R4.** Promote the a2ui module to a shared home (`src/a2ui/`) so the run widget doesn't
depend on the Roundup plugin's internals. Share the *universal* parts (walker, budgets,
degrade path, `parseA2uiContent`) regardless; the *catalog* may diverge if the Slate
needs components notices don't. (See origin: a2ui-run-workspace R-decisions.)

Mental model: **tool use for UI** — the catalog is a tool schema, an A2UI tree is a batch
of tool calls, the host executes by rendering. The agent can't invent a brick but
composes known bricks into any tree. Growing the catalog grows the surfaces.

Design principle from the prototype: **"go straight to the thing" needs the thing to have
a shape.** Every primitive gets a *visual* form (state track, dataflow graph, concept
map), not just a text form.

## 5. Authoring: file-in, HTTP-out (resolved)

The two directions of flow have opposite needs, so they use opposite mechanisms.

**Authoring (agent / process → Slate): observable file, watcher reads it.**

**R5.** The default authoring path is an **observable artifact**: the author writes A2UI
JSON into the run's worktree under `.tinstar/slate/*.json` (one file per surface, so the
Slate holds several panels at once); a server-side watcher — mirroring
`src/server/sessions/status-watcher.ts`, which already polls worktrees for transcript
JSONL — reads it and updates the run projection.
**R6.** Content is stored as a server-authoritative projection on the run (proposed
`RunData.slate: A2uiContent[]` or a keyed map), reusing the `A2uiContent` host type from
`src/domain/types.ts`; presence/change broadcasts an SSE delta; the client renders it as a
projection of server state. (Adding a `RunData` field is a 3-place change — type,
`runShallowEqual`, `mergeRun` — two of which fail silently; mirror the `attention` field
and add guard tests.)
**R7.** The watcher validates every read through the same `parseA2uiContent()` funnel;
invalid content retains the last-valid panel and logs — never crashes or blanks.
**R8.** Reads are size-capped (reuse the notices byte cap); an empty/absent file clears
that surface (retract works like pulling a notice). Writers use atomic write
(temp-file + rename) so a mid-write read can't surface a torn file. Prefer fs-watch
(inotify) over interval polling so fast progress updates feel live.
**R9.** Rationale for file-first: **agent-agnosticism** — a process that has never heard
of Tinstar paints a surface by writing JSON (no URL, port, sessionId, or auth); the state
is an inspectable on-disk artifact that survives restarts; the run is identified by *where
the file lives*, not a spoofable body param. This is the load-bearing property that makes
the long-running-command pattern (§7) possible.

**Answering (user → agent): HTTP, immediate + confirmed.**

**R10.** Interactive controls (`Choice` single/multi, `TextInput`, `Submit`) render from
the shared `controlComponents` with host-owned form state. Submitting routes the answer to
the **run's agent** over HTTP (proposed `POST /api/runs/:id/slate/answer`, parallel to
`POST /api/notices/:id/answer`) — instant and confirmed, where file-watch latency would
feel broken.
**R11.** The projection is *also* writable by an internal endpoint (not the documented
default), leaving a back door for a rare synchronous or remote-reporting author without
changing the storage shape.

## 6. The two hero surfaces (everything else secondary)

Two surfaces carry the feature; do not gold-plate the rest.

**R12. The open-points list** (`‹threaded-checklist›`) — the addressable point in its
standalone frame: a list where each point shows status, author, a visual **state track**,
an expandable **thread**, a soft **resolve**, and *add your own point*. Agent- and
user-authored points share the list.

**R13. Diagram surfaces with per-surface threads** — agent-authored A2UI surfaces that
render as *pictures* (dataflow graph, concept map, composition tree, before/after), each
carrying its own scoped discussion **thread**. "Talk about just this widget while I hold
the whole conversation" — the transcript stays the single context; the conversation gets
addresses.

Secondary (fall out of the shared primitive for free, not polished this pass): decisions
log, idea shelf, dismissed/graveyard, prototype previews.

## 7. Process-authored surfaces (the long-running-command pattern)

Because authoring is a file write (§5), **any local process can drive a Slate surface**.

**R14.** A wrapper — `tinstar-run <cmd>` (or a shell function) — makes a command
self-reporting by writing to `.tinstar/slate/`: **start** (post a "running…" surface),
**during** (amend it: step N/M, elapsed, last log line, a progress brick — each write
fans out live), **exit** (finalize to ✓/✗ + result, and drop a message that delivers a
completion prompt to the agent's session).

Everyone is notified from one surface: the user by glancing at the Slate, the agent by the
delivery on exit — no agent turn spent babysitting. Motivating gap: vppOps posted a
milestone FYI *after* a deploy step but nothing lived on the board *during* the run.

## 8. Delivery of user input: immediate injection + guardrail (resolved)

**R15.** When the user posts a scoped comment / adds a point while the agent works
elsewhere, **deliver immediately** by injecting into the agent's session (reuse the
notice-reply → prompt delivery path) — no separate queue, polling, or reconciliation.
**R16.** Ship a **guardrail** in the agent skill/prompt: *an injected scoped comment is a
note, not a command to drop in-flight work; if mid-turn, finish or checkpoint the current
action first, then address it — never let it replace your work.* Wrong if work is still
lost with the guardrail → add a lightweight "busy, hold until end of turn" gate.

## 9. Architecture: **A — presentation bricks over a durable store** (only viable option)

- Durable objects (points, threads, lifecycle, anchors, projections) live server-side,
  extending the shipped **notices/docstore** substrate. Bricks are **stateless views**
  that bind by id; interactions hit host endpoints that mutate state; the delta
  re-renders.
- **Do not reuse the `Pin` type.** A pin's identity is geometric (`nx/ny/nodeId`, enforced
  by `isPinSet`) and space-scoped; a point is anchor-optional and run-scoped. Reuse the
  pin's *plumbing pattern* (unsent→submit, threads, soft resolve, merge-preserving
  replies), not its element.
- **A is the only option, not just the safer one.** Process-authored surfaces (§7)
  require a store an ordinary process can write to (a file, or HTTP) — a shell script
  cannot drive A2UI's in-browser stateful runtime (option B). B would lock authoring
  inside the browser, making the long-running-command pattern impossible.

## 10. Data model (sketch — refine in planning)

Reuse `Reply` (`src/domain/pinSet.ts`), `A2uiContent`/`A2uiComponent` + renderer
(shared `src/a2ui/` after R4), notices routes (`src/server/api/routes.ts`), docstore
(`src/server/stores/document-store.ts`), the run projection (`RunData`), and SSE deltas.

```
Point {
  id, runId,
  author: 'agent' | 'user' | 'process',
  anchor?: { kind: 'none' | 'decision' | 'surface', ref?: string },
  headline: string,
  content?: A2uiContent,       // optional A2UI body/view
  status: 'open'|'discussing'|'waiting'|'resolved'|'dismissed',  // derived where possible
  replies?: Reply[],           // append-only thread (shared Reply)
  createdAt, amendedAt, resolvedAt?, dismissedAt?
}
// Run-attached Slate surfaces are a projection on RunData, populated by the watcher.
```

## 11. Non-goals (YAGNI)

- **Roundup rework is out of scope for this work** (per user). Roundup stays as-is; the
  Slate is net-new in the run workspace.
- No A2UI stateful runtime (option B).
- No auth/identity model on the file or endpoint (local-trust); no generic job scheduler
  (just `tinstar-run` + the surface it writes).
- No new pin geometry; no changes to canvas pins.
- Secondary surfaces not built to production polish this pass.

## 12. Risks

- **Menu sprawl** — each interactive brick is bespoke host work (the cost of A). Ship the
  two hero surfaces first; add bricks on demand.
- **Torn/malformed file reads** — mitigated by atomic write + validate-and-retain-last.
- **Watch latency at scale** — fs-watch (not poll) for the Slate dir; measure at 10-up.
- **Silent `RunData` field drops** — the 3-place change trap (R6); add guard tests.
- **Injection derail** — mitigated by the guardrail (R16); watched, not pre-solved.
- **Volatile A2UI dep** — already exact-pinned; do not float.
- **Staleness kills trust** — soft lifecycle + auto-recede (`age.ts`) + pull-when-resolved.

## 13. Acceptance criteria / proof gates

- A **point** is created by the agent *and* the user, threaded by both, soft-resolved,
  with all mutations fanning out live over SSE (unit + one runtime smoke).
- The **open-points list** renders points with a visual state track and per-point thread;
  the user adds a point and resolves one; both round-trip.
- A **diagram surface** renders A2UI as a picture in the run card and carries a
  per-surface thread; a user comment is delivered to the session immediately; the
  guardrail is present in the agent skill.
- A command wrapped by **`tinstar-run`** writes a live progress surface to
  `.tinstar/slate/`, the run card shows it updating live, and on exit the surface
  finalizes *and* a completion prompt reaches the agent — no agent turn spent watching.
- Malformed A2UI still degrades per the existing R16 path; a torn file never surfaces.
- `npm run build:all` bundles the widget(s); typecheck + vitest green.

## 14. Open questions for planning

- Extend `RunData` with a `slate` projection vs a separate points collection keyed by run
  (back-compat: notices have real live data now).
- `.tinstar/slate/` file schema — one A2UI tree per file, plus a small manifest for
  ordering/titles?
- How `status` is derived vs stored (last-author + lifecycle) to avoid a state machine.
- Is the open-points list one of the `.tinstar/slate/` surfaces, or a first-class panel
  with its own store? (Threads argue for a real store; presentation argues for a surface.)
- One unified Slate widget vs. the Slate hosting independently-placeable sub-surfaces.
