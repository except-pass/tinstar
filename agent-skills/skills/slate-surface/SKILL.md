---
name: slate-surface
description: Author a run's Slate — the per-run region of its workspace card where you maintain small interactive Surfaces (an open-points list, a diagram, a form, a live progress card). Use when the user must act, judge the result, or revisit an evolving work object. Inspect the run's authoring context first, amend its existing owner when present, and reserve a visible card before authoring a distinct foreground work object.
---

# The Slate

The **Slate** is a region of your run's workspace card where you paint small
interactive surfaces scoped to **this one run** — an open-points list, a diagram to
react to, a form, a live progress card. The user runs ~10 sessions at once, and a
single linear transcript buries the things that matter: the open question, the
decision, the status of a long-running command. The Slate lifts those out of the
scroll and onto the card, where the user sees them at a glance.

It is **not the Roundup**. The Roundup (see the `roundup-notices` skill) is one
**cross-session** board — every run's standing brief in one place. The Slate is the
**per-run** surface inside a single run's card. They coexist: post a `needs-you` /
`fyi` to the Roundup when the user needs to see it alongside every other run; paint a
Slate surface when the detail belongs inside this run's own workspace. Neither replaces
the other.

## How authoring works: inspect, amend or reserve, then write

The Slate is a **two-way** surface with a deliberate split:

- **You inspect and reserve over HTTP, then author at the returned target.** Read the
  run-scoped authoring context before creating anything. If a Surface already owns the
  subject, amend its returned file or revision-gated API target. For a genuinely
  distinct work object, reserve a visible saved card, then atomically write the
  assigned file, local id, and attempt token.
- **The user answers over HTTP** (HTTP-out). When the user clicks a control, submits a
  form, replies on a thread, or adds their own point, their browser POSTs to a
  run-scoped endpoint. The server persists it, then **injects a note into your session**
  so you learn about it. You reply on the thread with a small `curl` (baked into the
  note you receive).

Direct unreserved `.tinstar/slate/*.json` files remain valid for scripts and older
automation. For new interactive foreground work, reserve first: the saved shell appears
immediately and can fail or recover in place if the first content write is invalid,
late, or interrupted.

## Start with the run's authoring context

Use your managed session name as both the run id and routing actor:

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
RUN_ID="$TINSTAR_SESSION_NAME"
curl -s "$TINSTAR_URL/api/runs/$RUN_ID/slate/authoring/context" \
  -H "x-tinstar-actor: $RUN_ID" \
  -H 'x-tinstar-actor-kind: session'
```

The response separates the user's `objective` from `surfaces`. Each Surface includes
its canonical `surfaceId`, run-local `localId`, creation/freshness state, effective
capabilities, and one exact `target`:

- `slate-file`: atomically rewrite `file`, keeping `localId`; include `attemptToken`
  while the card is still authoring.
- `canonical-content`: `PATCH` the returned `endpoint` with `expectedRev`.
- `unavailable`: do not guess a write path; the response says why it is blocked.

Choose based on the work object, not the conversational turn. If an existing Surface
owns the subject, amend that target and preserve its identity and thread. Reserve only
when the object is genuinely distinct and Surface-worthy.

## Reserve a visible card for a distinct work object

Pick a stable `key` for the work object, not for this attempt or turn. Reuse that same
key after a lost response. A new key means a new card.

```bash
curl -s -X POST "$TINSTAR_URL/api/runs/$RUN_ID/slate/authoring/reservations" \
  -H 'Content-Type: application/json' \
  -H "x-tinstar-actor: $RUN_ID" \
  -H 'x-tinstar-actor-kind: session' \
  -d '{"key":"open-points","label":"Open points","request":"Keep the unresolved questions current as the work evolves."}'
```

The first response is `201`; a retry of the same key is `200` with `replayed:true`.
Both return the same `surfaceId`, `localId`, absolute `file`, `attemptToken`, and
`deadlineAt`. Write only that assigned destination. The reservation itself never
prompts this session, dispatches another author, or runs a refresh recipe.

The first valid write uses the returned values exactly:

```json
{
  "id": "<returned localId>",
  "attemptToken": "<returned attemptToken>",
  "headline": "Open points",
  "content": { "root": "root", "components": [
    { "id": "root", "component": "Text", "variant": "body", "text": "No open points." }
  ] }
}
```

Write that JSON to the returned absolute `file` with the temp-file-and-rename pattern
below. After the watcher accepts it, the same card becomes ready. Later rewrites keep
the same `id` and file; they may retain the token, but never substitute a token from an
older retry.

Do **not** use `POST /api/runs/:id/slate/compose` or the user's add-point endpoint for
agent live authoring: those are user interaction paths and may prompt or dispatch work.

## Write a surface file

Write one JSON file per logical group of surfaces into `.tinstar/slate/` at your
worktree root:

```
<your-worktree>/.tinstar/slate/<name>.json
```

`<name>` is your choice and is **incidental** — identity lives in an `id` field
**inside** the file (see below), not in the filename. A file holds either a single
surface object or a **JSON array** of them.

Each entry is a **point** — the primitive the Slate is built from:

| field | required | owner | meaning |
|---|---|---|---|
| `headline` | **yes** | file | the one-line title of the point (non-empty) |
| `id` | recommended | file | **stable** point identity — reuse it so a rewrite *amends* instead of duplicating |
| `attemptToken` | assigned only | host | for a reserved card, copy the returned token exactly until the first valid write makes the card ready; omit it for direct file authoring |
| `content` | no | file | the surface body: an **A2UI component tree** (see below) |
| `author` | no | file | `agent` (default) \| `user` \| `process` |
| `anchor` | no | file | `{ kind: "none" \| "decision" \| "surface", ref? }` — attach the point to a decision or another surface by id |
| `refresh` | no | file | the ONE recipe that rebuilds this whole surface. A string is prose only *you* can run; `{ "kind": "host", "handler": … }` is a machine check the host runs itself (see "who runs your recipe" below) |
| `claims` | no | file | what would **prove this surface wrong** — the host checks these itself, with no agent session. Declare at least one on every surface you author; see "Declare at least one claim" below |
| `group` | no | file | **workbench set id** — give the *same* string to 2+ **question** points and they render side by side, one per column (see below). Open-point entries only; ignored on a `kind: "surface"` anchor |
| `createdAt` | no | file | epoch ms; the server stamps one on first projection if you omit it |

Everything else about a point — its **discussion thread** (`replies`), its **lifecycle
status** (open / discussing / waiting / resolved / dismissed), and the resolve/dismiss
timestamps — is **owned by the store, not the file**. You never write those; they are
preserved across your file rewrites (see "Merge by id" below).

```json
[
  {
    "id": "rollback-path",
    "author": "agent",
    "headline": "Which rollback path for the auth change?",
    "content": {
      "root": "root",
      "components": [
        { "id": "root", "component": "Column", "children": ["q", "opts"] },
        { "id": "q", "component": "Text", "variant": "body",
          "text": "The migration that adds the role column is not reversible. Two paths:" },
        { "id": "opts", "component": "List", "listStyle": "unordered", "children": ["o1", "o2"] },
        { "id": "o1", "component": "Text", "variant": "body", "text": "Revert the commit (~2 min)." },
        { "id": "o2", "component": "Text", "variant": "body", "text": "Roll forward with a hotfix (needs review)." }
      ]
    }
  }
]
```

### `content` is A2UI, not markdown or HTML

`content` is a **declarative component description** the host renders in its own theme —
the **same shared renderer** the Roundup uses, so the vocabulary is identical. It is a
JSON object with:

- `root` — the `id` of the component to render first.
- `components` — a **flat list**. Each has a `component` type, an `id`, and
  type-specific fields. Containers reference their children **by id** — never nested
  inline.

| `component` | fields | renders as |
|---|---|---|
| `Text` | `text`, `variant` (`h1`–`h5`, `body`, `caption`) | a heading or paragraph |
| `Column` | `children` (ids) | children stacked vertically |
| `Row` | `children` (ids) | children in a row |
| `List` | `children` (ids), `listStyle` (`ordered` \| `unordered`) | a numbered/bulleted list |
| `Card` | `child` (single id) | a bordered box around one child |
| `Divider` | — | a horizontal rule |
| `Link` | `text`, `url` | a themed link (a `javascript:`/`data:` URL degrades to plain text) |
| `Code` | `text` | a monospace block |
| `Mermaid` | `source`, `theme?` | a Mermaid definition string drawn as a themed diagram — e.g. `graph TD\n  A --> B\n  B -->\|yes\| C`. Use it for any flow/pipeline/state picture instead of ASCII art in a `Code` block. `theme` is `ink` (default, neutral monochrome — prefer it) or `hue` (semantic colors, for complex flows that need color to stay legible); anything else falls back to `ink`. The diagram is **scaled to fit** the narrow column and expands on click, so size is fine — but keep labels short, since they shrink too. Pick the look with `theme`, not with mermaid config: `%%{init: …}%%` directives and YAML front matter are stripped from `source`. A bad, empty, or over-long `source` degrades to a small inline notice. |
| `Stepper` | `steps` (`{ label, status, detail? }[]`) | a status-colored vertical phase track. `status` is `pending` \| `active` \| `done` \| `skipped` (anything else → `pending`): `done` is emerald with a ✓, `active` is the live cyan, `skipped` is dimmed and struck through. Use it for phases/checklists/pipeline progress instead of writing `[x]`/`[ ]` into a Text or List — it's the only way to color a step by state. Keep exactly one step `active`, keep labels short, and put running commentary in `detail` on that active step. Rows with no `label` are dropped; unusable `steps` degrade to a small inline notice. For a live tracker a skill rewrites per phase, see `docs/solutions/conventions/authoring-a-skill-progress-tracker-surface.md`. |
| `Choice` | `mode` (`single` \| `multi`), `options` (`{ id, label }[]`) | radios or checkboxes |
| `TextInput` | `label?`, `placeholder?` | a free-text box |
| `Submit` | `label?` | the submit button (a control surface needs one) |
| `Decision` | `options` (`{ id, label, gain, cost, wrongIf }[]`, **2+ required**), `risks?`, `reversal?`, `horizon?`, `comment?` | One open decision as a card. `risks` is `{ label, severity, likelihood, discoverability, note? }[]` where severity is `annoying`\|`costly`\|`severe`, likelihood is `unlikely`\|`possible`\|`likely`, discoverability is `obvious`\|`subtle`\|`silent` — **all three run fine → alarming**, so `silent` means nothing would alert you. `reversal` is `{ action, damage, note? }`: `action` (`trivial`\|`cheap`\|`costly`\|`one-way`) is how long to undo the **action**, `damage` (`minutes`\|`hours`\|`days`\|`weeks+`) is how long to undo the **damage** — frequently different numbers. `horizon` is `{ span, until }` where span is `until-next-commit`\|`until-this-ships`\|`while-the-code-lives`\|`permanent`; `until` completes "this matters until…" and is **required** whenever span is set. `comment` is `{ label?, placeholder? }` and customizes the comment box the card **always** renders at its foot — the label defaults to `"Anything else?"` when omitted; you may customize it, you may not remove it. Needs a `Submit` sibling. **Do not add a `TextInput`** — the card renders its own comment box and owns the surface's single text field. An unknown scale word renders verbatim and uncolored rather than being coerced. Fewer than two options degrades whole; a bad risks/reversal/horizon block degrades alone. |

Anything outside this set, or a malformed tree, **degrades** — the surface shows a
"couldn't render" fallback instead of the body, and it never hangs or blanks a sibling
surface (each surface has its own render budget and error boundary). Stick to the table.

**Authoring a Decision card.** Use `permanent` for horizon when something survives an
undo — rows already written, mail already sent, an API already published, a person who
already saw it. Reverting the commit does not retract any of those, which is why horizon
and reversal are separate axes: a decision can be one commit to undo and still matter
forever. The `until` string is where you say out loud what survives. Name a **concrete**
cost on each option — "adds complexity" is filler; say where the complexity lands. And do
not compute a risk score: the scales are ordinal, an FMEA-style RPN multiplies labels, and
the host deliberately renders no total.

An entry whose `content` fails validation is **dropped** (the file's other entries still
project); an entry with no `content` is a valid **bare headline point**.

### Asking several questions at once: the `group` workbench

**A surface has exactly ONE answer.** One free-text draft and one `Submit` are shared by
everything in its body, so two `TextInput`s in one entry write to the same box and two
`Submit`s send the same single answer. Never pack a questionnaire into one entry.

Write **one entry per question** and give every entry in the set the same `group`:

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

Two or more points sharing a `group` render as a **workbench**: a horizontal band inside
the open-points list, one question per column, each answered on its own. You get **one
note per answered question**, not one combined blob. A lone grouped point is just an
ordinary row. `group` is presentational and fully additive — omit it and nothing changes,
and dropping it from a later write dissolves the band back into rows without touching a
single thread or status.

## Write atomically, and rewrite to amend

The watcher can read your file at any instant, so a half-written file must never be seen
as truth. **Write atomically: write a temp file, then rename it over the target.**

```bash
SLATE_DIR=".tinstar/slate"
mkdir -p "$SLATE_DIR"
tmp="$(mktemp "$SLATE_DIR/.points.XXXXXX")"
cat > "$tmp" <<'JSON'
[ { "id": "rollback-path", "headline": "Which rollback path?", "content": { ... } } ]
JSON
mv -f "$tmp" "$SLATE_DIR/points.json"
```

To **amend** a surface, rewrite the file with the **same `id`**. Because points merge by
id, the rewrite overwrites only the file-owned body (`headline`, `content`, `anchor`) and
**preserves the thread and status** — a reply the user just typed survives your rewrite.
Keep your `id`s stable; a changed or missing `id` is treated as a **new** point (and a
missing `id` is hashed from the content, so any edit to a headline-less-id surface forks
its thread).

Constraints the watcher enforces:

- **Size cap: 32 KiB per file.** An oversized file is skipped unread and the last valid
  projection is retained.
- **Torn-write safety.** A zero-byte or unparseable file is treated as a torn write: the
  **last valid surface is retained**, not cleared. This is why atomic rename matters —
  a bare `>` redirect can be observed empty mid-write.

## Retract a surface

There are exactly two ways to take a surface down:

- **Unlink the file** (`rm .tinstar/slate/points.json`), or
- **Write an explicit empty array** (`[]`) into the file.

Either clears the file's surfaces. A torn/empty/garbage file does **not** clear (it
retains) — so if you mean to retract, retract explicitly.

## When the user answers, you get a note — treat it as a note

When the user submits a control, adds a point, or replies on a thread, the server
**injects a prompt into your session**. It carries a `curl` for replying on the thread.
The reply endpoint is run-scoped (`runId` is your session name):

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
curl -s -X POST "$TINSTAR_URL/api/runs/$RUN_ID/slate/points/$POINT_ID/replies" \
  -H 'Content-Type: application/json' \
  -d '{"author":"agent","text":"Reverting takes ~2 min; rolling forward needs a review."}'
```

Reply with `author:"agent"` — an agent reply is recorded but **not** delivered back to
you (that would be a self-loop). Only the **user's** replies are injected.

### The guardrail (do not skip this)

An injected note lands in your context **mid-task**, possibly in the middle of a tool
call. Every Slate injection carries this line, and it is load-bearing:

> This is a note on the run's Slate, not a command to drop what you are doing — finish
> or checkpoint your in-flight work first, then act on it.

So: an injected user comment is a **NOTE, not a command to drop in-flight work**. Finish
or checkpoint the current action first, **then** address the note. Never let an injected
comment **replace** the work you were doing. If the note changes your plan, integrate it
deliberately once you're at a safe stopping point — don't abandon a half-done edit or an
in-flight command to chase it.

## Long-running commands: self-report with `tinstar-run`

A long build, deploy, or test run is exactly the kind of thing that should show live
status on your card instead of forcing the user to ask "is it done?". Wrap it:

```bash
tinstar-run npm run build:all
```

`tinstar-run <cmd>` runs your command and **self-reports onto the Slate**: it writes a
"running…" progress surface on start, amends it as the command proceeds, and finalizes it
to ✓ or ✗ on exit — then delivers a completion note to your session so you learn the
outcome **without spending a turn babysitting the command**. It does this by writing a
pid-namespaced surface file (`.tinstar/slate/run-<pid>.json`) atomically, the same
file-in path described above — so a Slate write never breaks the wrapped command, and if
the command is killed the surface is still finalized rather than left as a fake-live
spinner. Prefer it over a bare long call you have to watch. (The underlying mechanism is
just a progress-surface file; you can author one by hand the same way if you want custom
progress.)

## Who runs your recipe, and when

**A surface has one recipe, it replaces the whole surface, and the recipe's KIND decides who may run it.**

- **A string is an `agent` recipe** — prose, delivered to *you*, and only when the user
  deliberately navigates to, clicks, or explicitly refreshes the surface. Nothing
  ambient runs it: not a commit, not a deadline, not the dashboard being left open.
- **An object naming a host check** — `{ "kind": "host", "handler": "http-status",
  "params": { "url": "…" } }` — is machine work the host runs by itself, cheaply and
  on its own schedule. `handler` must be one the host implements (`http-status`,
  `unit-landed`); a name it does not know is refused and quoted back at you.
- **Anything else** is kept as *unreadable* and reported, so a mistyped recipe says so
  rather than leaving a surface that quietly never updates.

Prose can never become machine work however you word it, and `"policy": "automatic"`
does not change who runs anything — policy says when a surface is marked **dirty**,
which is cheap; running the recipe is a separate question with a separate answer.

**What this means for how you write.** Your surface will sit dirty until the user
reaches for it, so write it to stay useful in the meantime: the card keeps showing what
it last knew, with an honest "known at / last checked" stamp beside it. Write the recipe
to pass the **vacuum test** — name its **source** (a PR, files, a query), its
**derivation** (what to do with the source), and its **output** (what to rewrite).
`"regenerate this surface"` fails: it assumes context you will not have when the user
finally opens the card a week later. A surface whose only source is *this session*
(e.g. "explain the session") is session-derived and needs no self-contained recipe.
Capture the recipe at create time so the surface is born handoff-able.

**Sweep after you ship rather than waiting to be refreshed.** Since nothing refreshes
your surfaces on a timer any more, a card you leave wrong stays wrong until somebody
opens it. Re-author what you know changed — that is your push; refresh is the user's
pull.

## Declare at least one claim

A `refresh` recipe says *how to rebuild this card*. A **claim** says *what would prove it wrong* — and the host can check a claim on its own, with no session and no prompt. Most checks find nothing moved, which is exactly why they are worth running often. A claim on a card with a **host** recipe may also fill in a claim-bound rail; on a card with an agent recipe it marks the card dirty and leaves your prose alone, so one card never says two things at two different ages.

```json
"claims": [
  { "id": "u2", "witness": "unit-landed", "locus": "repo",
    "params": { "plan": "docs/plans/2026-07-24-001-….md", "unit": "U2" } },
  { "id": "api", "witness": "http-status", "locus": "infra",
    "params": { "url": "http://127.0.0.1:5273/api/state" } }
]
```

Two witness kinds ship and no others: **`unit-landed`** (has this plan unit merged on the tracked remote ref?) and **`http-status`** (what code does this URL answer?). A claim naming anything else is refused and the card says so.

Three things worth knowing before you write one:

- **Declare at least one on every surface you author.** A card with none says `nothing to check` on its own face — honest, but nothing can ever doubt it. If you genuinely looked and there is nothing witnessable, write `"claims": []` and mean it; that is a different statement from leaving the key out.
- **Omission clears.** Rewriting the entry without `claims` deletes the declaration, exactly like `headline` and `content`.
- **A `Stepper` step can be bound to a claim** — `{ "label": "…", "claim": "u2", "done": "landed" }` — and the host fills its status in from what it observed. Do that instead of writing statuses you then have to keep current.

Full field reference, caps, refusal behaviour and worked examples: `docs/solutions/documentation-gaps/slate-surface-authoring-contract.md`.

## Canonical Surfaces: the API and CLI you can also use

Everything above is the **file-in** authoring path, and it still works exactly as
described. Alongside it there is now a **canonical Surface API** — the same work
artifact, addressed by a global id, with operations a human's UI and an agent both
go through. Use it when the file path cannot express what you want:

- you want to **organise**: fold several surfaces into one parent, move one, or take
  a group apart;
- you want to **delete something and be able to undo it**;
- you want to **read the tree** — a surface's ancestors, its children, who worked on
  it, and whether the host thinks it is still current;
- you are not in a worktree with a `.tinstar/slate/` directory at all.

**Where a canonical Surface actually shows up, today.** The run-scoped reservation
endpoint above is the supported visible creation path: it saves the canonical card and
assigns the Slate file that will fill it. A generic `POST /api/surfaces` create is real,
persisted, and survives restart, but is not automatically attached to a run's visible
Slate. Use generic canonical creation for organising, lifecycle, and tree work; use the
run reservation when the user must see a new foreground work object.

There is **no approval step**. You create, group, reparent and delete directly. What
makes that safe is that **delete is a move, not an erase**: the subtree goes into a
per-space recovery store and `restore` brings it back with its identity, thread, and
former home intact. `purge` is the only irreversible operation, and it refuses
anything that is not already deleted.

```bash
tinstar surfaces list --space "$SPACE"          # what exists, and what is recoverable
tinstar surfaces context <id>                   # ancestors, children, freshness, contributors
tinstar surfaces create --space "$SPACE" --home canvas --headline "PR #212 review" \
        --recipe "re-read the PR diff and rewrite this surface"
tinstar surfaces group sf-a,sf-b --headline "Reliability"
tinstar surfaces reparent sf-a --home sf-parent  # or --home canvas to promote
tinstar surfaces ungroup sf-parent               # children move up; the box is recoverable
tinstar surfaces delete sf-a                     # → recovery store
tinstar surfaces restore sf-a                    # ← back where it was
```

The same operations are HTTP (`/api/surfaces`, `/api/surfaces/:id/context`,
`/api/surfaces/group`, …); `tinstar help api` has the full spec. Four things are worth
knowing before you use either:

- **Writes are compare-and-swap.** A content update needs `--rev` (the revision you
  read); a topology change may state `expectedTopologyRev`. A stale revision changes
  nothing and hands you back the current record so you can re-read and retry.
- **Deleting a parent needs the exact descendant list you saw**, plus
  `--disposition reparent-children` or `--disposition delete-subtree`. That is on
  purpose: a confirmation built before a child arrived must not take that child too.
- **A file-authored surface belongs to its file.** Its content authority is the source
  binding, so a direct API edit is refused with instructions rather than silently
  overwritten — either rewrite the file, or take authority explicitly with
  `tinstar surfaces authority <id> --to canonical-direct --rev <n>`.
- **Retries are safe if you say so.** Pass `--idempotency-key <k>` (HTTP:
  `Idempotency-Key`) and a repeat after a lost response replays instead of applying
  twice. The output says `replayed` when that happens.

Host-owned fields — `id`, `rev`, `homeRev`, timestamps, freshness state, aliases, and
sibling order — are **rejected** if you try to supply them. That is not a formality:
they are what keeps identity stable while a surface moves.

## The discipline that makes this work

- **Context first; amend or reserve; then write.** Read the run-scoped context before
  creating anything. Amend the returned owner when one exists. For a distinct
  interactive work object, reserve one visible card with a stable key, then write its
  exact assigned target. Direct files remain valid for scripts and compatibility.
- **Keep `id`s stable.** Same id → an amend that preserves the thread. Changed/missing
  id → a duplicate with a fresh thread.
- **`objective` is a RESERVED id — never use it.** It carries the *user's* Objective,
  the standing statement of what the session is for, pinned at the top of the Slate.
  It is theirs to write and yours to honour. A file entry claiming that id is **dropped
  by the watcher** (your surface silently never appears, and a file whose only entry is
  that one leaves the previous projection frozen in place) and `POST /slate/points`
  refuses it outright. Pick any other id — `goal`, `session-goal`, `plan` — for a
  surface of your own about the same subject.
- **Write atomically, retract explicitly.** Temp + rename to write; unlink or `[]` to
  clear. Never a bare redirect over a live file.
- **Retract what's resolved.** A stale surface on the card costs the user trust, same as
  a stale Roundup notice. Take a surface down once it no longer needs to be there.
- **A note is a note.** Finish or checkpoint before you act on an injected comment; never
  let it derail in-flight work.

Your run's Slate is pruned automatically when the run is deleted — you don't clean up on
shutdown. While you're alive, keeping it honest is on you.
