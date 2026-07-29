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
| `refreshPolicy` | object | No | **When the host rebuilds this surface.** `{ policy, triggers, intervalMs, sources, signals }` — see "Declare what your surface derives from" below. Unknown trigger names and out-of-vocabulary policies are dropped at parse time; the surface still projects. |
| `claims` | array | No | What would prove this surface wrong (see [Claims](#claims-what-would-prove-this-surface-wrong) below). **Three-state**: absent, `[]`, and a non-empty list are three different answers. |
| `proposal` | `{ state, detail? }` | No | **What you claim about the work** — `working`, `blocked`, `resolved`, or `superseded`, plus one short line. A hint the card renders beside the status; it never *becomes* the status. See "Say what you know about the work" below. |
| `group` | string (non-empty) | No | **Workbench set id.** Give two or more question entries the *same* `group` and they render side-by-side, one per column, instead of as stacked rows (below). A non-string/empty value is silently dropped (the point renders as an ordinary row) — it never drops the entry. |
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
| `Mermaid` | — | `source`, `theme?` | A Mermaid definition string rendered to a host-themed SVG diagram (client-only, lazily imported). `theme`: `'ink'` (default) is neutral monochrome; `'hue'` uses the semantic `hue.*` palette for complex flows. Unknown values fall back to `'ink'`. Neither theme may use the cyan reserved for the live edge. The host owns theming and sizing, so mermaid's two author-config channels — `%%{init: …}%%` directives and YAML front matter — are **stripped from `source`** before it reaches mermaid. Rendered **scaled to fit** the column (never a horizontal scrollbar — the #126 guard); clicking opens an expanded view portaled to `document.body`. A bad, empty, over-long (>50k chars), or non-string `source` degrades to a small inline amber notice; it never throws. |
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

### Asking a SERIES of questions: the `group` workbench

When you need several answers at once, do **not** pack them into one surface. A surface has
exactly **one** answer form: one free-text draft and one `Submit` shared by everything in its
body (`NoticeFormState` is surface-scoped). Two `TextInput`s in one entry write to the same
draft, and two `Submit`s both send the same single answer.

Write **one file entry per question** and give every entry in the set the same `group`
string. Two or more points sharing a `group` render as a **workbench**: a horizontal band
inside the open-points list, one question per column, each with its own controls, its own
`POST …/points/<id>/answer`, its own "✓ Answered" lock, and its own thread. The band shows an
"M of N answered" count. A *lone* grouped point falls back to an ordinary row — a one-column
band is just a row with less affordance, and the same fallback is why a *hidden* point never
joins a band (a column carries no unhide button).

A column shows the question only. The thread, the soft resolve, the reorder grip and the
hide ✕ live on the vertical row — so an agent reply to a workbenched question is read on
the row the point returns to, not inside the column.

```json
[
  { "id": "q-token-scope", "headline": "Refresh token, or access only?", "author": "agent",
    "group": "auth-decisions",
    "content": { "root": "root", "components": [
      { "id": "root", "component": "Column", "children": ["c", "s"] },
      { "id": "c", "component": "Choice", "mode": "single",
        "options": [ { "id": "both", "label": "Both" }, { "id": "access", "label": "Access only" } ] },
      { "id": "s", "component": "Submit", "label": "Answer" } ] } },
  { "id": "q-migration-owner", "headline": "Who owns the migration?", "author": "agent",
    "group": "auth-decisions",
    "content": { "root": "root", "components": [
      { "id": "root", "component": "Column", "children": ["t", "s"] },
      { "id": "t", "component": "TextInput", "label": "Name" },
      { "id": "s", "component": "Submit", "label": "Answer" } ] } }
]
```

The `group` is presentational and fully additive: omitting it is today's behavior exactly,
and dropping it from a later write dissolves the workbench back into rows **without touching
any thread or status** (it is a file-owned field, merged by id like `headline`/`content`).
The agent receives one delivered prompt per answered question, not one combined blob.

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

## Declare what your surface derives from (`refreshPolicy.sources`)

The recipe says *how* to rebuild a surface. `refreshPolicy` says *when*: `triggers` picks which host observations reach it, and `sources` says which upstream things a `source-content` observation must name before it counts.

```jsonc
{
  "id": "decision-6",
  "headline": "DECISION 6 — File a prevention ticket for the reassignment leftovers?",
  "refresh": "Run scripts/integrity/detect-site-reassignment-leftovers.sh against prod, check whether CMT-510 is still open in Jira, and rewrite this surface with the current leftover count and ticket state.",
  "refreshPolicy": {
    "policy": "automatic",
    "triggers": ["git-revision", "periodic"],
    "intervalMs": 86400000,
    "sources": [
      "scripts/integrity/detect-site-reassignment-leftovers.sh",
      "external:prod-mysql/ra-physical",
      "external:jira/CMT-510"
    ]
  }
}
```

**What `sources` does — and what it deliberately does not.** It is the match list for the `source-content` trigger: when the host observes that some upstream thing changed, this surface is made possibly-stale if the observed identifier is in your list. It is **not** a filter on commits. A `git-revision` observation reaches every surface that declared the `git-revision` trigger, whether or not you wrote `sources` and whether or not the commit touched anything you named. Narrowing which triggers may reach a claim is the job of the claim's declared **locus** (where its truth lives), not of this list — one mechanism, so there is never a question of which one wins.

So `sources` earns its place two ways: it drives `source-content` matching, and it documents, for the next fresh author (yours or someone else's), where the answer actually comes from. It does not quieten a noisy surface — for that, drop the trigger you don't want, or set `policy` to `mark-stale`.

**Two shapes in one list**, told apart by a `scheme:` prefix:

| You write | Shape | Matched by `source-content` |
|---|---|---|
| `external:prod-mysql/ra-physical`, `jira:CMT-510`, `mysql://prod/detector` | External id — opaque; the host never resolves it | Exact equality against the observed identifier |
| `src/api/**`, `docs/decisions/CostCeiling*.md`, `bin/serena` | Repo-relative path shape | As a glob, so an adapter that reports a path is matched without you listing every file |

**Glob syntax** is deliberately tiny: `**` crosses directories, `*` doesn't, `?` is one character. A glob with no wildcard is a **prefix** — `src/server` matches everything beneath it. Prefer a glob over a literal list when files will be added later: `docs/decisions/CostCeiling*.md` picks up the fourth file without you re-editing the recipe.

Writing `"sources": []` is a real statement — "I checked; nothing upstream feeds this" — and the host keeps it verbatim rather than treating it as if you'd left the field off. Nothing branches on the difference today; it is there so the record says what you meant.

**`intervalMs` and the periodic trigger.** `periodic` is the time-safety net for answers that change without anything in the repo moving. It defaults to six hours, which is a floor, not a recommendation — set it to what your answer's real cadence is. A number that drifts weekly wants `86400000` (a day), not the default. A surface whose inputs are *all* in the repo usually needs no `periodic` trigger at all: `git-revision` already fires whenever the worktree moves.

**`policy`** is `automatic` (rebuild it without asking — the default when you carry a recipe), `mark-stale` (badge it and wait for a human), or `manual` (nothing moves it but an explicit ⟳).

## Claims: what would prove this surface wrong

A `refresh` recipe answers *how do I rebuild this card*. A **claim** answers the cheaper question that comes first: *is it still true?* A claim is a falsifiable statement the entry makes about the world, which the host can check on its own — no agent session, no prompt, no worker. Most checks find nothing moved, and a check that finds nothing moved costs one subprocess or one HTTP request.

```json
"claims": [
  { "id": "u2", "witness": "unit-landed", "locus": "repo",
    "params": { "plan": "docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md", "unit": "U2" } },
  { "id": "api", "witness": "http-status", "locus": "infra",
    "params": { "url": "http://127.0.0.1:5273/api/state" } }
]
```

| Key | Meaning |
|-----|---------|
| `id` | Surface-local and author-chosen. Body components reference a claim by this. A repeated id is refused (first wins). |
| `witness` | Which host-owned check can settle it. Closed set — see below. |
| `locus` | `'repo'` (the bound worktree and its repository) or `'infra'` (deployed infrastructure over the network). |
| `params` | **Flat scalars only** — strings, numbers, booleans. No nested objects or arrays. Each kind has its own schema. |

Caps: at most **32 claims** per entry, **16 params** per claim, **1024 characters** per param value. An oversized claims list is **refused whole rather than truncated** — a silently shortened declaration is a surface that says it is witnessed by fewer things than its author wrote.

### The tri-state, and why `[]` is not the same as leaving it out

| `claims` | Means | Card says |
|----------|-------|-----------|
| absent | The author never said. The one-claim convention still owes this surface something. | `nothing to check` |
| `[]` | The author looked and found nothing witnessable here. | `nothing to check` |
| non-empty | These are the statements the host may check without waking anybody. | `not yet checked`, then `checked 3m ago` |

The two empty states are identical in scheduling and rendering. They are kept apart anyway because the **egress adapter writes this field back into your own file** when a surface's content is edited over the API — collapsing `[]` to absent would have the host quietly delete a declaration you wrote.

**Omission clears, exactly like `headline` and `content`.** A later write of the same entry without a `claims` key clears the declaration; it does not merge with what was there before. The same is true through the API's content-patch path. If you rewrite an entry and want its claims, write them again.

### The two witness kinds

The registry is **closed**. These two, and nothing else.

| `witness` | `locus` | `params` | Returns |
|-----------|---------|----------|---------|
| `unit-landed` | `repo` | `plan` (a `docs/plans/<file>.md` path), `unit` (`U3`, `U1e`), optional `ref` (default `origin/main`, must be `<remote>/<branch>`) | `"landed"` or `"pending"` |
| `http-status` | `infra` | `url` (absolute, `http` or `https` only) | the status code as a number, e.g. `200` |

`unit-landed` **fetches the named remote ref before reading it**, because feature PRs squash-merge remotely and a worktree sitting on a feature branch must never make a unit read as landed. It links a unit to a commit through a `Plan: docs/plans/<file>#U<n>` trailer (see `docs/contributing.md`), falling back to a small backfill map for units that merged before that convention existed. When it can link the unit to neither, it reports **unresolved** — never "pending". A wrong witness is worse than no witness, because it fails without doubt.

`http-status` does **not** follow redirects: a 301 *is* the status code being claimed. Point a recurring unattended witness at something local and stable; a card on somebody's canvas should not become a periodic request against a service that never agreed to it.

**Three outcomes, not two.** A witness returns a value, or reports itself *unresolved* (nobody could look — an unreachable host, an expired credential, a ref that does not exist), or *failed* (the claim itself is broken, or the check ran out of time). Only a value can match what was stored. This is why a witness that has been broken for a week cannot keep agreeing with its own stored absence and keep stamping the card verified.

### A witnessed card takes two runs

The first check on a new claim has nothing to compare against — a value the host invented a moment ago has agreed with nothing — so it records the value and stamps nothing. The **second** check is the first one that can confirm. Between them the card reads `not yet checked`, which is honest rather than broken.

That age is the **witness** age, not the file's. Saving your file does not reset it, and a surface saved thirty seconds ago that nobody has checked still shows no age at all.

### What a refusal looks like

A claim naming a witness kind this host does not implement, or supplying parameters that kind will not accept, is **refused — and refusing costs that claim, never the surface**. The entry still renders, with its *new* content, minus the bad claim, plus a visible line on the card naming the kind:

> ⚠ claim not accepted — `claim "u2" (witness unit-lands): no such witness kind — this host implements unit-landed, http-status`

The refused claim stays in **your** file (the host will not silently edit your declaration out from under you) and the refusal clears the moment the entry parses cleanly. If a card you expected to be checked says `nothing to check`, read the refusal line — a mistyped witness kind is otherwise indistinguishable from a healthy surface.

### Deriving a rail from claim values

A `Stepper` step may name a claim instead of stating its own status:

```json
{ "label": "U2 · per-source reconciliation", "claim": "u2", "done": "landed" }
```

`claim` names a claim on the same entry; `done` names the observed value that means finished. The host fills `status` in on the way to the browser: `done` when a completed lookup returned exactly that value, `pending` for everything else. **Any status you write on a claim-bound step is overridden** — that is the point. Nothing about the rail depends on an agent keeping it current, and nothing about it can drift.

There are only four step statuses and none of them means "unknown", so a claim nobody could resolve reads `pending` on the rail and says so separately in the card's "claim not checked" line. A `claim` naming an id that does not exist, or a step with no `done`, is permanently `pending` rather than permanently green — an authoring mistake should look wrong, not finished.

### Locus decides what reaches the card

A claim's locus is what narrows work. A commit on the bound worktree reaches surfaces whose claims are about the `repo` and leaves an `infra`-only card entirely alone — no stale mark, no job. Time reaches both. Declaring claims also *earns* a surface a verification deadline it would otherwise never get: before this, a surface with no rebuild recipe listened for nothing, so nothing could ever doubt it and it stayed `current` forever.

### The convention: declare at least one

Every newly authored surface should declare at least one claim. It is a convention rather than an enforced boundary — nothing refuses a claimless entry — but a claimless card cannot be checked by anything, and it says so on its own face. If you genuinely looked and there is nothing witnessable, write `"claims": []` and mean it.

### Two worked examples

**(a) A roadmap card whose rail is the host's own reading of the repository.** One claim per unit, one step per claim, and not a single status written by hand.

```json
{
  "id": "recursive-surfaces-roadmap",
  "headline": "Recursive collaborative surfaces — what has actually landed",
  "author": "agent",
  "claims": [
    { "id": "u1", "witness": "unit-landed", "locus": "repo",
      "params": { "plan": "docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md", "unit": "U1" } },
    { "id": "u4", "witness": "unit-landed", "locus": "repo",
      "params": { "plan": "docs/plans/2026-07-24-001-feat-recursive-collaborative-surfaces-plan.md", "unit": "U4" } }
  ],
  "content": {
    "root": "root",
    "components": [
      { "id": "root", "component": "Column", "children": ["title", "rail"] },
      { "id": "title", "component": "Text", "variant": "h4", "text": "Recursive collaborative surfaces" },
      { "id": "rail", "component": "Stepper", "steps": [
        { "label": "U1 · canonical Surface model", "claim": "u1", "done": "landed" },
        { "label": "U4 · recursive Canvas workspace", "claim": "u4", "done": "landed" }
      ] }
    ]
  }
}
```

Note there is **no `refresh` recipe**. A landing does not make this card false — the rail re-derives itself from the new value — so there is nothing for a rebuild to do. A moved value on a recipe-less surface records the delta and marks it for a human glance, and queues no agent. Give a claim-bearing card a recipe only when a moved value genuinely requires *prose* to be rewritten.

**(b) An infra card with a single claim.**

```json
{
  "id": "standalone-api-reachable",
  "headline": "The standalone backend answers its own API",
  "author": "agent",
  "claims": [
    { "id": "api", "witness": "http-status", "locus": "infra",
      "params": { "url": "http://127.0.0.1:5273/api/state" } }
  ],
  "content": {
    "root": "root",
    "components": [
      { "id": "root", "component": "Text",
        "text": "A GET of /api/state answers 200. A different status code is a moved value, not an outage report." }
    ]
  }
}
```

A commit never touches this card. Its own interval does.

## Say what you know about the work (`proposal`)

A point's **status** is derived from who spoke last: no replies → `open`, you replied last → `discussing`, the user replied last → `waiting`. That derivation is deliberate and load-bearing — it is what stops the Slate ever resolving a question the user never ruled on.

But it leaves the card unable to tell two very different situations apart. You answered and are waiting on a ruling: `discussing`. You answered, did the work, and shipped it: also `discussing`. The card looks identical. The observed workaround was rewriting the headline to shout `RESOLVED` — which renders, and is theatre, because nothing downstream knows anything changed.

`proposal` is how you say it properly:

```jsonc
{ "proposal": { "state": "working", "detail": "not started, half a day, one open judgement call on the alarm window" } }
```

| `state` | What the card shows | What it does |
|---|---|---|
| `working` | `WORKING — <your line>` | Nothing. Someone is on it, and the line says where it stands. |
| `blocked` | `BLOCKED — <your line>` | Nothing. You cannot proceed, and the line says why. |
| `resolved` | `AGENT SAYS: DONE ✓` (a button) | Offers the user a one-click resolve. |
| `superseded` | `AGENT SAYS: MOOT ✓` (a button) | Offers the user a one-click supersede. |

**You propose; the user disposes.** A `resolved` or `superseded` proposal is an *offer*, not a status change. The status only moves when the user clicks. Nothing you can write in a file moves a status — that is the invariant, and this field is designed around it, not through it.

**`superseded` is not `dismissed`.** Dismissal is the user's verdict: *I'm not doing this.* Superseded means the question stopped being the right question — the premise dissolved, the prevention ticket turned out to be already filed and closed. That is a discovery *you* made, and filing it under the user's verdict would misattribute it. Propose `superseded` when the answer is neither yes nor no because the question no longer applies.

**`detail` is one short line and deliberately not an ETA.** Write what you actually know — how far along, what the open judgement call is, what you are waiting on. Do not invent a completion time; you will be wrong, and a wrong ETA on a card is worse than no ETA. Keep it under ~200 characters; the card truncates, and the thread is where prose belongs.

**Restate it whenever you rewrite the file.** `proposal` is file-owned like `refresh` and `group`: a projection that omits it clears it. That is the right default — an agent who rewrites a card and says nothing about progress is no longer claiming progress — but it means a body update that forgets the field silently drops your "shipped" claim.

## Related

This doc is the **author** corner of a four-way partition of the Slate/A2UI surface lifecycle:

- `docs/solutions/tooling-decisions/adopting-a2ui-for-agent-authored-ui.md` — the **render/validation** contract you author against; the `.passthrough()` URL allowlist and total-node-count bound apply to what you write here.
- `docs/solutions/conventions/agent-prompt-delivery-and-surface-refresh.md` — the **downstream delivery/refresh** end of the same `.tinstar/slate/*.json` → watcher → projection → SSE pipeline. Its guardrail on file-authored injection applies directly to the files this doc teaches you to write.
- `docs/solutions/conventions/widget-to-agent-answer-back.md` — the **answer-back** direction; the A2UI controls (`Choice`/`TextInput`/`Submit`) you author submit back through that path.
