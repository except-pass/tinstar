---
name: the-slate
description: Author a run's Slate — the per-run region of its workspace card where you paint small interactive surfaces (an open-points list, a diagram, a form, a live progress card) by writing files into your worktree. Use when you want to show the user something richer than a line of transcript for THIS run — a decision to make, a picture to react to, the live state of a long command. You author by writing `.tinstar/slate/*.json`; the user answers back over HTTP and you receive their reply as an injected note.
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

## How authoring works: files in, HTTP out

The Slate is a **two-way** surface with a deliberate split:

- **You author by writing files** (file-in). You write a JSON file into
  `.tinstar/slate/` in your worktree. A server watcher validates it and projects it
  onto your run's card live. There is **no Tinstar URL to author a surface** — a plain
  file write is the whole authoring path.
- **The user answers over HTTP** (HTTP-out). When the user clicks a control, submits a
  form, replies on a thread, or adds their own point, their browser POSTs to a
  run-scoped endpoint. The server persists it, then **injects a note into your session**
  so you learn about it. You reply on the thread with a small `curl` (baked into the
  note you receive).

So: **surfaces are files you write; answers are notes you receive.** You almost never
POST to create a surface — you write a file.

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
| `content` | no | file | the surface body: an **A2UI component tree** (see below) |
| `author` | no | file | `agent` (default) \| `user` \| `process` |
| `anchor` | no | file | `{ kind: "none" \| "decision" \| "surface", ref? }` — attach the point to a decision or another surface by id |
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

Anything outside this set, or a malformed tree, **degrades** — the surface shows a
"couldn't render" fallback instead of the body, and it never hangs or blanks a sibling
surface (each surface has its own render budget and error boundary). Stick to the table.

An entry whose `content` fails validation is **dropped** (the file's other entries still
project); an entry with no `content` is a valid **bare headline point**.

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

## Make surfaces refreshable by a fresh author (the vacuum test)

A surface's `refresh` recipe is its **authoring contract**: when it's self-contained, refreshing the surface spawns a *fresh, context-free* author (a headless child in the run's workdir) that re-runs the recipe and rewrites the file — off your (the main agent's) critical path. So write every living surface's recipe to pass the **vacuum test**: name its **source** (a PR, files, a query), its **derivation** (what to do with the source), and its **output** (what to rewrite). `"regenerate this surface"` fails — it assumes context a fresh author won't have. A surface whose only source is *this session* (e.g. "explain the session") is session-derived: it stays with you and needs no self-contained recipe. Capture the recipe at create time so the surface is born handoff-able.

## The discipline that makes this work

- **Author with files; answer with HTTP.** Write a file to make a surface; reply with a
  `curl` when the user talks back. Don't POST to *create* surfaces — that path
  (`POST /slate/points`) is the **user's** add-a-point and always injects into your own
  session.
- **Keep `id`s stable.** Same id → an amend that preserves the thread. Changed/missing
  id → a duplicate with a fresh thread.
- **Write atomically, retract explicitly.** Temp + rename to write; unlink or `[]` to
  clear. Never a bare redirect over a live file.
- **Retract what's resolved.** A stale surface on the card costs the user trust, same as
  a stale Roundup notice. Take a surface down once it no longer needs to be there.
- **A note is a note.** Finish or checkpoint before you act on an injected comment; never
  let it derail in-flight work.

Your run's Slate is pruned automatically when the run is deleted — you don't clean up on
shutdown. While you're alive, keeping it honest is on you.
