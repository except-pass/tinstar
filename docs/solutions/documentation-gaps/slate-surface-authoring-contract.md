---
title: "Authoring a Slate surface: the file + A2UI contract"
module: slate
date: 2026-07-22
category: documentation-gaps
problem_type: documentation_gap
component: documentation
severity: medium
tags:
  - slate
  - a2ui
  - surface-authoring
  - json-contract
  - sse
  - agent-authoring
applies_when:
  - "Authoring or editing a Slate surface JSON file under a run workdir's .tinstar/slate/"
  - "Building A2UI content for a surface and needing the host component vocabulary"
  - "A surface silently fails to appear (invalid content dropped by parseA2uiContent)"
  - "Deciding surface kind (diagram vs open-point) via the anchor field"
  - "Validating authored surface files before shipping"
---

# Authoring a Slate surface: the file + A2UI contract

## Context

Authoring a single Slate surface — the small agent-authored panel that renders inside a run's workspace card — currently forces a reader through roughly six files before writing one line of JSON. To learn the on-disk file shape you have to read `slate-watcher.ts` (`toPointInput` and `toAnchor`). To learn what counts as a valid body you have to read `a2ui/schema.ts` (`parseA2uiContent`). To learn which components actually render you have to read `a2ui/catalog.tsx`. To learn how the surface's `kind` gets chosen you have to read `document-store.ts` (`projectRunToSlate`). And to reconcile the field names you cross-check `domain/types.ts` (`SlateSurface`, `Point`, `PointAnchor`). None of these files documents the whole contract; each owns one slice. Worse, every validation gate in that chain fails *silently* — a wrong shape produces no error, just a missing panel. This reference collapses those six reads into one authoritative page: the file schema, the A2UI vocabulary, and the `kind` rule, in one place.

## Guidance

### Where the files live

Write JSON files to `<run-workdir>/.tinstar/slate/*.json`. The dir is resolved as `join(workdir, '.tinstar', 'slate')` (`slate-watcher.ts`, `slateDir()`), one dir per live run. It is **gitignored** — `.gitignore` carries `/.tinstar/` with an explicit comment naming this as "The Slate's runtime authoring dir." These files are runtime authoring artifacts, never committed.

A file may hold **one object or an array of objects** — the watcher accepts either (`Array.isArray(parsed) ? parsed : [parsed]`). All `*.json` in the dir are read in sorted-filename order and flattened into one point list.

The watcher watches the dir (inotify plus a ~3s poll backstop), validates each entry through the same funnel notices use, and projects the result onto `run.slate`, which reaches the client over SSE. Latency from write to render is well under the poll cadence.

**Failure model (matters because it's silent):**
- A **file-level** fault (zero-byte, unreadable, unparseable JSON, or a JSON value that is neither array nor object) is treated as a *torn write*: the watcher **retains the last-valid projection** and logs once. It does not clear the surface.
- An **entry-level** fault (missing `headline`, or a `content` that fails A2UI validation) **drops that one entry** and keeps the rest.
- An empty dir or an explicit empty array **clears** the run's Slate (retract).
- Oversized files (>32 KiB by default) are skipped unread; symlinks are ignored (an `lstat` reports `isFile:false`), so a symlink can't smuggle a file in from outside the worktree.

### The file field table

Each entry is validated by `toPointInput` (`slate-watcher.ts`). Only `headline` is required; every other field is optional and dropped if malformed.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `headline` | string (non-empty) | **Yes** | The one-line title. A missing/empty headline drops the whole entry. |
| `id` | string (non-empty) | No | Stable identity for merge-by-id. Reuse the same `id` across writes to amend a surface without clobbering its store-owned thread/status. |
| `author` | `'agent' \| 'user' \| 'process'` | No | Any other value drops the entry. Use **`'agent'`** for agent-authored surfaces. (See "Why This Matters" — mislabeling has behavioral consequences around self-prompting and staleness.) |
| `anchor` | `{ kind, ref? }` | No | `kind` must be `'none' \| 'decision' \| 'surface'`; any other value drops the entry. Drives the `kind` projection (below). `ref` is an optional string. |
| `content` | A2UI content object | No | Validated by `parseA2uiContent`; **invalid content drops the entry** (not just the body). |
| `refresh` | string (non-empty) | No | The prompt the agent re-runs to regenerate this surface. Carried verbatim onto `run.slate`. A non-string/empty recipe is silently dropped (the surface still refreshes via a bare nudge). |
| `createdAt` | finite number (epoch millis) | No | Sort/ordering hint. |

### The A2UI content shape

`content` is a host envelope around A2UI's flat component list (`a2ui/schema.ts`, `A2uiContentSchema`):

```json
{ "root": "<component-id>", "components": [ { "id": "...", "component": "...", "...": "..." } ] }
```

- `root` is a component **id** naming the entry node.
- `components` is a **non-empty** flat array; children are referenced **by id**, not nested.
- The schema is `.strict()` on the envelope — misnaming `root`/`components` is rejected.
- `parseA2uiContent` returns `null` on any schema failure, and the watcher **drops** any entry whose content is `null`. Invalid A2UI never reaches the store.

### The component vocabulary

The host catalog (`a2ui/catalog.tsx`) is a bounded, read-only set. A `component` string the catalog doesn't know degrades gracefully (renderer's fallback) — never a throw, never a blank card.

| `component` | Children | Notable props | Renders as |
|-------------|----------|---------------|------------|
| `Text` | — (leaf) | `text`, `variant` (`h1`–`h5`, `caption`, `body`/default) | Heading or paragraph, scaled by variant |
| `Column` | `children[]` | — | Vertical flex stack |
| `Row` | `children[]` | — | Horizontal wrapped flex row |
| `List` | `children[]` | `listStyle: 'ordered'` (else bulleted) | `<ol>`/`<ul>`, one `<li>` per child |
| `Card` | **`child`** (single) | — | Bordered container around `children[0]` |
| `Divider` | — | — | Horizontal rule |
| `Link` | — | `url`, `text` | Anchor **only** for `http(s)` or same-origin (`/`- or `#`-leading) urls; anything else (e.g. `javascript:`, `data:`) renders as a plain non-link span. See `safeHref`. |
| `Code` | — | `text` | Preformatted code block |
| `Mermaid` | — | `source`, `theme?` | A Mermaid definition string rendered to a host-themed SVG diagram (client-only, lazily imported). `theme`: `'ink'` (default) is neutral monochrome; `'hue'` uses the semantic `hue.*` palette for complex flows. Unknown values fall back to `'ink'`. Neither theme may use the cyan reserved for the live edge. Rendered **scaled to fit** the column (never a horizontal scrollbar — the #126 guard); clicking opens an expanded view portaled to `document.body`. A bad, empty, or non-string `source` degrades to a small inline amber notice; it never throws. |
| `Stepper` | — (leaf) | `steps: [{ label, status, detail? }]` | A status-colored vertical stepper. `status` is `'pending' \| 'active' \| 'done' \| 'skipped'`; anything else coerces to `'pending'`. `done` is emerald (`hue.resolved`) with a `✓`, `active` is the live cyan + glow (the one legitimate cyan use — P4), `pending` is the faint rail, `skipped` is dimmed + struck through. Rows with no `label` are dropped; a missing/non-array/unusable `steps` degrades to a small inline amber marker and never throws. At most 60 rows are drawn per stepper and at most 1200 array entries are examined; whichever cap bites is named on the surface (`+N more entries not shown` vs `+N entries not scanned`). A stepper's rows are also charged against the renderer's whole-surface node budget, so neither one runaway array nor a pile of steppers can expand into an unbounded DOM. See [authoring a skill progress tracker](../conventions/authoring-a-skill-progress-tracker-surface.md). |
| `Choice` | — | control props | Host-themed choice control (interactive) |
| `TextInput` | — | control props | Host-themed text input (interactive) |
| `Submit` | — | control props | Host-themed submit control (interactive) |
| `FollowUp` | — | — | **Renders nothing inline** — it's a declaration surfaced in the notice ask panel, not a body element. The catalog *knows* the type (no "unsupported" marker). |

**Children-by-id rule** (`childIdsOf`): layout/list types (`Column`, `Row`, `List`) carry a `children` array of ids; `Card` carries a single `child` id. Everything else is a leaf. The renderer resolves ids against the flat `components` list and recurses.

**The `Link` safeHref rule is a security gate, not a nicety.** A2UI's component schema is `.passthrough()`, so `url` is never scheme-validated upstream. A `javascript:` or `data:` href would execute in Tinstar's origin. `safeHref` allows only `http:`/`https:` protocols and same-origin relative paths (leading `/` or `#`); everything else falls back to a text span.

### The kind-from-anchor rule

The file **does not** author `kind` directly. `projectRunToSlate` (`document-store.ts`) derives it from the anchor:

```
kind = (anchor?.kind === 'surface') ? 'diagram' : 'open-point'
```

- `anchor.kind === 'surface'` → **`diagram`**: a standalone card with its own thread.
- No anchor, or `anchor.kind` of `'none'`/`'decision'` → **`open-point`**: grouped into the run's open-points list.

To author a standalone diagram surface, set `anchor: { kind: 'surface' }`. To author an open point, omit `anchor` (or use `none`/`decision`).

> **Drift note:** `SlateSurface.kind`'s JSDoc in `src/domain/types.ts` lists example strings `'open-points' | 'diagram' | 'progress'`, but `projectRunToSlate` actually emits `'open-point'` (singular) and `'diagram'`. Trust the runtime values documented here, not that comment.

## Why This Matters

Every gate in the pipeline fails **silently** — no throw, no error surfaced to the author:

- A wrong file shape (bad JSON, neither array-nor-object, an oversized file) is treated as a *torn write* and the watcher keeps showing the **old** projection. Your new surface simply never appears, and the run looks unchanged.
- A missing `headline` or invalid A2UI `content` **drops that entry** while keeping its siblings — so a file can partially render, hiding which entry failed.
- An unknown `component` string degrades to a fallback rather than erroring.
- An unsafe `Link` url quietly downgrades to plain text.

Because nothing tells you *why* a surface didn't render, authoring blind costs a full write-watch-inspect round-trip per mistake — and the failure mode (a stale or absent panel) looks identical to "the watcher hasn't picked it up yet." Getting the file shape, the A2UI envelope, and the `kind` rule right on the *first* write is the difference between one iteration and several.

The `author` field also carries behavioral weight: it's threaded through to staleness handling (a `process`-authored surface whose writer goes silent gets marked stalled by a server sweep) and provenance. Using `'agent'` for agent-authored panels keeps a surface from being treated as a live-process spinner or from feeding back into the run's own prompting loop.

## When to Apply

Reach for this reference any time you:
- Author or edit a `.tinstar/slate/*.json` file for a run.
- Build an "Explain"-style or composed surface that an agent emits into the Slate.
- Add a surface template to a catalog of reusable Slate surfaces.
- Debug a surface that isn't appearing (walk the silent-failure list above).

## Examples

**(a) A diagram surface** — `anchor: { kind: 'surface' }` yields `kind: 'diagram'`; small Column/List/Text body plus a refresh recipe. Write as `.tinstar/slate/plan-overview.json`:

```json
{
  "id": "plan-overview",
  "headline": "Rollout plan",
  "author": "agent",
  "anchor": { "kind": "surface" },
  "refresh": "Regenerate the rollout plan surface from the current migration status.",
  "content": {
    "root": "root",
    "components": [
      { "id": "root", "component": "Column", "children": ["title", "steps"] },
      { "id": "title", "component": "Text", "variant": "h3", "text": "Rollout plan" },
      { "id": "steps", "component": "List", "listStyle": "ordered", "children": ["s1", "s2"] },
      { "id": "s1", "component": "Text", "text": "Migrate the read path behind a flag." },
      { "id": "s2", "component": "Text", "text": "Cut over writes after a 24h soak." }
    ]
  }
}
```

**(b) An open-points array file** — no `anchor`, so each entry projects to `kind: 'open-point'`. One file, multiple points. Write as `.tinstar/slate/questions.json`:

```json
[
  {
    "id": "q-auth-scope",
    "headline": "Should the token cover refresh, or access only?",
    "author": "agent"
  },
  {
    "id": "q-schema-owner",
    "headline": "Who owns the migration for the new column?",
    "author": "agent",
    "content": {
      "root": "root",
      "components": [
        { "id": "root", "component": "Text", "text": "Blocking the write path until decided." }
      ]
    }
  }
]
```

**Pre-ship validation one-liner** — parse the file, run the exact `parseA2uiContent` gate on any `content`, and assert `root` names a real component id, before you drop the file into the watched dir:

```js
import { parseA2uiContent } from './src/a2ui/schema'
const entries = [].concat(JSON.parse(fileText)) // array-or-object → array
for (const e of entries) {
  if (typeof e.headline !== 'string' || !e.headline) throw new Error('missing headline (entry dropped)')
  if (e.content !== undefined) {
    const c = parseA2uiContent(e.content)
    if (c === null) throw new Error('invalid A2UI content (entry dropped)')
    if (!c.components.some(k => k.id === c.root)) throw new Error('root does not name a component id')
  }
}
```

## Keeping a surface fresh (a reply is not an update)

A surface asserts something durable — the state of the world as of when it was authored. A **reply on its thread is a comment ABOUT the surface; it does not change what the surface asserts.** The blind spot this repeatedly causes: you take an action that makes a surface false (merge a PR, clear a blocker), you *reply* "that's cleared now," and you leave the surface itself asserting the old truth. The glanceable panel goes stale while the thread looks tended.

Two disciplines close it:

- **If your action changed what a surface says, rewrite the file — don't just reply.** Re-author the `.tinstar/slate/*.json` so the panel's body reflects the new reality. The reply is optional colour; the file is the truth.
- **Sweep after you ship.** After merging, clearing a blocker, or any state change, re-read your run's surfaces and re-author any that are now false. Don't wait to be refreshed — refresh is the *user's* pull; keeping the file current is *your* push.

The client surfaces the age of each panel ("updated 3m ago", ambering when untended) precisely so an author and a reader can both *see* staleness instead of trusting a stale assertion silently.

## The vacuum test: source-derived vs session-derived

Under multi-agent authoring the `refresh` recipe stops being a convenience and becomes the **authoring contract a fresh, context-free author executes.** When a surface carries a self-contained recipe, refreshing it spawns a one-shot author (a headless child in the run's workdir) that runs the recipe and rewrites the file — the run's main agent is never involved.

So apply the **vacuum test** to every living surface: *could this recipe produce a sensible refresh in a vacuum, with no session context?*

- **Passes** — the recipe names an external **source** (a PR, files, a query), the **derivation** (describe it blind, compare A to B), and the **output** (rewrite these columns). This is a **source-derived** surface; a fresh author can refresh it. Write recipes this way.
- **Fails** — the only "source" is the main agent's own session (e.g. "summarize the session so far"). This is **session-derived**; it stays with the main agent. Don't give it a self-contained recipe it can't honor.

A self-contained recipe is exactly what lets a surface refresh off the main agent's critical path. `"regenerate this surface"` fails the vacuum test — it assumes context the author won't have.

## Related

This doc is the **author** corner of a four-way partition of the Slate/A2UI surface lifecycle:

- `docs/solutions/tooling-decisions/adopting-a2ui-for-agent-authored-ui.md` — the **render/validation** contract you author against; the `.passthrough()` URL allowlist and total-node-count bound apply to what you write here.
- `docs/solutions/conventions/agent-prompt-delivery-and-surface-refresh.md` — the **downstream delivery/refresh** end of the same `.tinstar/slate/*.json` → watcher → projection → SSE pipeline. Its guardrail on file-authored injection applies directly to the files this doc teaches you to write.
- `docs/solutions/conventions/widget-to-agent-answer-back.md` — the **answer-back** direction; the A2UI controls (`Choice`/`TextInput`/`Submit`) you author submit back through that path.
