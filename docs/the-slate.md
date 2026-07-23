# The Slate

The **Slate** is a per-run region of a run's workspace card where an agent, the user, or
any local process paints small interactive surfaces scoped to that one run — an
open-points list, a diagram to react to, a form, or a live progress card. It exists
because a single linear transcript buries what matters when the user is running many
sessions at once: the open question, the decision, the status of a long-running command.
The Slate lifts those out of the scroll and onto the card.

It is distinct from the **Roundup**, which is a single cross-session board aggregating
every run's standing brief. The Roundup answers "what does each run need from me, across
all of them?"; the Slate answers "what's going on inside *this* run?". They coexist and
neither replaces the other.

The single primitive the Slate is built from is the **addressable point**: a durable,
threaded item optionally anchored to a decision or a whole surface, carrying an
append-only discussion thread and a soft lifecycle. See `CONCEPTS.md` for both terms.

## The two-way flow: files in, HTTP out

The Slate is authored one way and answered another, on purpose:

- **File-in authoring.** A surface is created by writing a JSON file into
  `.tinstar/slate/` inside the run's worktree. A server-side watcher validates the file
  and projects it onto the run. There is no endpoint to author a surface — a plain file
  write is the entire authoring path, which means any local process (an agent, a shell
  script, a build wrapper) can paint onto a run's card with no Tinstar client.
- **HTTP-out answering.** When the user interacts with a surface — submits a control,
  adds a point, or replies on a thread — the browser POSTs to a run-scoped endpoint. The
  server persists the change, then best-effort **injects a prompt into the run's agent
  session** so the agent learns of it. The agent replies on the thread over HTTP.

The consequence is a clean ownership split. **The file owns the surface body**
(`headline`, the A2UI `content`, `anchor`). **The store owns everything a human or the
store produced** — the discussion thread, the lifecycle status, and the
resolve/dismiss timestamps. A file rewrite therefore *amends* a surface without ever
clobbering a reply the user just typed.

## The file schema

Files live at `<worktree>/.tinstar/slate/<name>.json`. The filename is incidental;
identity is an `id` **inside** the file. A file contains either one surface object or a
JSON array of them. Each entry is a point:

| field | required | owner | meaning |
|---|---|---|---|
| `headline` | yes | file | the point's one-line title (non-empty string) |
| `id` | recommended | file | stable point identity; reuse it so a rewrite amends rather than duplicates |
| `content` | no | file | the surface body as an A2UI component tree (`{ root, components }`) |
| `author` | no | file | `agent` (default) \| `user` \| `process` |
| `anchor` | no | file | `{ kind: "none" \| "decision" \| "surface", ref? }` |
| `group` | no | file | workbench set id — give the **same** string to a set of related questions and they render side-by-side, one per column (see [The workbench](#the-workbench-asking-a-series-of-questions)) |
| `createdAt` | no | file | epoch ms; the server stamps one on first projection if omitted |

Store-owned fields — `status`, `replies` (the thread), and the lifecycle timestamps —
are never written in the file; they are preserved across re-projections by `id`.

`objective` is a **reserved id** (see [The Objective](#the-objective)). A file entry
claiming it is dropped by the watcher, so an authored file can neither overwrite nor
retract the user's objective. Pick any other id.

### The `content` body is A2UI

`content` is a declarative component description rendered by the shared host renderer
(the same one the Roundup uses), not markdown or HTML. It is a flat list of components
plus a `root` reference:

- `root` — the id of the component to render first.
- `components` — a flat list; each has a `component` type, an `id`, and type-specific
  fields. Containers reference children by id, never nested inline.

The rendered vocabulary is `Text`, `Column`, `Row`, `List`, `Card`, `Divider`, `Link`,
and `Code` for layout and prose, `Mermaid` (a `source` definition string drawn as a
themed diagram, with an optional `theme` of `ink`/`hue`) for flows and pipelines,
`Stepper` (a `steps` array of `{ label, status, detail? }`) for a status-colored phase
track, plus
`Choice`, `TextInput`, and `Submit` for interactive controls. Content outside this set, or a malformed tree, degrades to a
readable "couldn't render" fallback within a per-surface error boundary and node budget,
so one hostile or malformed surface cannot hang or blank the card. A `javascript:` or
`data:` URL on a `Link` degrades to plain text.

## Projection, validation, and lifecycle

A server watcher reads each live run's `.tinstar/slate/` directory, validating on both an
`fs.watch` event (for latency) and a slow poll floor (a backstop for filesystems that
miss inotify events). Its rules:

- **Merge by id.** A re-projection overwrites only the file-owned body of an existing
  point and preserves its store-owned thread and status; new points are added and points
  absent from the file are retracted. A user-added point (created over HTTP) is exempt
  from retraction so a file rewrite cannot delete it.
- **Validation and size cap.** Every entry's `content` is validated through the same
  parser the Roundup uses; an invalid entry is dropped while the file's valid entries
  still project. A file larger than 32 KiB is skipped unread.
- **Retract vs. retain.** Unlinking the file or writing an explicit empty array (`[]`)
  retracts the file's surfaces. A zero-byte or unparseable file is treated as a torn
  write — the last valid projection is retained, not cleared — so writers must write
  atomically (temp file + rename).
- **Soft lifecycle.** A point's status is `open`, then `discussing` or `waiting` as
  derived from its thread's last author; `resolved` and `dismissed` are explicit,
  survive a later file re-projection, and are cleared only by an explicit reopen. The
  Slate never auto-resolves a point.

A run's points are pruned when the run is deleted, and they ride the store's snapshot
persistence.

## The answer endpoints

All Slate endpoints are run-scoped; the `:id` segment is the run id, which is also the
run's session name used for delivery. Each persists first, then best-effort delivers a
prompt to the run's session, returning a `delivered` flag (`false`, not an error, when
the session is gone).

| method + path | effect |
|---|---|
| `POST /api/runs/:id/slate/points` | create or amend a **user**-authored point; persists only — adding a point is *eventual*, so it never injects |
| `POST /api/runs/:id/slate/points/:pid/replies` | append a reply to a point's thread |
| `POST /api/runs/:id/slate/points/:pid/answer` | submit a control answer (choices + text) |
| `POST /api/runs/:id/slate/points/:pid/resolve` \| `/reopen` \| `/dismiss` | explicit lifecycle change |

The run's goal has its own pair of endpoints — see [The Objective](#the-objective).

Two delivery rules keep injections honest. **Only a user-authored reply or point is
delivered** — an agent or process reply is recorded but not injected, so an agent never
prompts its own session in a loop. And a control answer's submitted choices are validated
against the surface's **current** content, so a stale choice from a surface that changed
under the user is rejected rather than persisted.

Every injected prompt carries a guardrail line: an injected comment is a **note, not a
command to drop in-flight work** — the agent finishes or checkpoints its current action
first, then addresses the note.

## The workbench: asking a series of questions

When an agent needs several answers at once, it can lay the questions out **side by
side** instead of stacking them. Write each question as its own point — its own `id`, its
own `content` body of `Choice`/`TextInput`/`Submit` — and give every point in the set the
**same** `group` string. Two or more **live** points sharing a `group` render as a
*workbench*: a horizontal band inside the open-points list, one question per column,
labelled `Questions · N` with an `M of L answered` count beside it. `N` is the columns on
screen; `L` is only the ones still being asked, so a **dismissed** question leaves both
sides of the count and the band can always reach its ceiling.

A lone grouped point stays an ordinary row, and the two off-the-table cases have
deliberately *different* rules. A **hidden** point never joins a band at all, so it never
counts toward the two (the reason is below). A **dismissed** one doesn't hold a band
open — a two-question set with one dismissed degrades back to rows rather than leaving a
single column with none of the row's chrome — but does ride along, dimmed, in a band its
live siblings already justify.

```json
[
  { "id": "q-token-scope", "headline": "Refresh token, or access only?", "group": "auth-decisions",
    "content": { "root": "root", "components": [
      { "id": "root", "component": "Column", "children": ["c", "s"] },
      { "id": "c", "component": "Choice", "mode": "single",
        "options": [ { "id": "both", "label": "Both" }, { "id": "access", "label": "Access only" } ] },
      { "id": "s", "component": "Submit", "label": "Answer" } ] } },
  { "id": "q-migration-owner", "headline": "Who owns the migration?", "group": "auth-decisions",
    "content": { "root": "root", "components": [
      { "id": "root", "component": "Column", "children": ["t", "s"] },
      { "id": "t", "component": "TextInput", "label": "Name" },
      { "id": "s", "component": "Submit", "label": "Answer" } ] } }
]
```

Each column is a real, independent point, which is what makes the workbench work:
a column submits through **its own** `POST …/points/<id>/answer`, gets its own
"✓ Answered" lock, and keeps its own thread. Answering one column never disturbs the
others, and the agent receives one prompt per answered question rather than one
combined blob. Dropping `group` from the file on a later write dissolves the workbench
back into ordinary rows without touching any thread.

The column is deliberately the **question only** — headline, body, controls. The thread,
the soft resolve, the reorder grip and the hide ✕ all stay on the vertical row, which is
where a point goes back to living once the file drops its `group`. So a *hidden* point is
never pulled into a band (it would lose its only unhide affordance), and a reply the agent
writes back onto a workbenched question is read on the row, not in the column.

## The Objective

The Objective is the **user's** standing statement of what a session is for: one short
piece of prose, pinned above everything else on that run's Slate, editable in place.
It is a surface kind (`objective`) like the others, but it is the only one the agent
cannot author — it is backed by a reserved `source:'user'` point with the id
`objective`, which is why the run has exactly one and why a file re-projection can
neither clobber nor retract it.

It is distinct from the run's **launch prompt**, which fires once at spawn, is not
editable afterwards, and leaves no artifact. The Objective is durable, visible, and
re-deliverable.

| method + path | effect |
|---|---|
| `PUT /api/runs/:id/slate/objective` | set or replace the objective (body `{ text }`, ≤ 600 chars) **and nudge the agent to re-align to it** |
| `DELETE /api/runs/:id/slate/objective` | clear the objective; no nudge (clearing is not an injection) |

Two rules make the nudge trustworthy:

- **Only an explicit Apply delivers.** The card holds edits in local state — no
  debounce, no save-on-blur, no save-on-keystroke — so typing can never re-nudge an
  agent mid-sentence. The PUT is the only call that reaches the session, and only the
  Apply button issues it.
- **A no-op Apply is silent.** If the text is byte-identical the store short-circuits
  and no prompt is delivered (the response says `changed: false`).

`PUT` is the one Slate endpoint that both persists *and* delivers. `POST /slate/points`
persists without delivering ("add a point = eventual"); `/compose`, `/explain`, and
`/refresh` deliver without persisting. Applying an objective is a deliberate
re-alignment, so it does both. Like every other injection, the delivered nudge is
collapsed to one line and carries the guardrail.

## Self-reporting long commands

A long-running command can report its own progress onto the Slate by wrapping it:
`tinstar-run <cmd>` writes a "running…" progress surface on start, amends it during the
run, and finalizes it to ✓ or ✗ on exit — then delivers a completion note to the run's
agent, so the agent learns the outcome without spending a turn watching. It works purely
through the file-in path (a pid-namespaced surface file written atomically), so a Slate
write never breaks the wrapped command and a killed command still finalizes its surface
rather than leaving a fake-live spinner. A server-side staleness sweep marks a
"running…" surface stalled if no update arrives within its threshold, so an abruptly
killed wrapper cannot leave a permanently live spinner.

## Authoring guidance for agents

Agents author Slate surfaces by writing files, not by calling an endpoint. The
`the-slate` agent skill (under `agent-skills/skills/the-slate/`) is the authoring guide —
the file schema, atomic-write and retract discipline, the reply flow, and the injection
guardrail. It is installed alongside the other Tinstar agent skills via
`tinstar install-skills`.
