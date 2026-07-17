---
name: roundup-notices
description: Post, amend, and pull Roundup notices — the standing brief your run keeps for the user. Use when you need a ruling before you can proceed (a `needs-you` notice), or you made a call the user would want to know about but that doesn't block you (an `fyi`). Most important: amend a notice the moment its situation changes, and pull it the moment it's resolved, so the board never goes stale.
---

# Roundup notices

The **Roundup** is one shared board where the user sees, at a glance, every agent's
standing brief: what each run needs from them, and what each run decided on its own.
The user runs many sessions at once, and re-entering one after time away is expensive.
Your notices are what make arriving a glance instead of a round trip — but only if you
keep them **current**. A board full of stale asks stops being trusted, which is worse
than no board at all.

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
SESSION="your-session-name"   # your run's session id (its tmux/session handle)
```

Every response is the standard envelope: `{ "ok": true, "data": … }` on success,
`{ "ok": false, "error": { "code", "message" } }` on failure. Pipe through `jq '.data'`.

## The two kinds

- **`needs-you`** — you've reached a decision you should not make alone, and you are
  **waiting**. You are idle by definition; this is exactly when the user needs to hear
  from you. The headline states the choice; the content gives them enough to decide
  without asking you anything.
- **`fyi`** — you made a call the user would want to know about but that does **not**
  block you. Silence is consent; you keep working. Use this for "I skipped the flaky
  e2e test on CI", "I chose Postgres over SQLite", "a hand is handling the migration".

If you are stuck, it's `needs-you`. If you're informing, it's `fyi`. Don't post an `fyi`
for something you actually need answered — it won't read as a question.

## The notice body is A2UI, not markdown

A notice's `headline` is a plain string. Its **body is `content`**: a small
**A2UI component description** — a declarative UI the widget renders in the host's own
theme. You describe *components* (a heading, a paragraph, a list, a link), and Tinstar
draws them with its own styling. You are not writing HTML or markdown; you are naming
components.

`content` is a JSON object with two fields:

- `root` — the `id` of the component to render first.
- `components` — a **flat list** of components. Each has a `component` type, an `id`
  (so other components can reference it), and type-specific fields. Containers list
  their children **by id** — children are never nested inline.

### The component types you can use

| `component` | Fields | Renders as |
|---|---|---|
| `Text` | `text` (string), `variant` (`h1`–`h5`, `body`, `caption`) | a heading (`h1`–`h5`) or paragraph (`body`/`caption`, the default) |
| `Column` | `children` (array of ids) | its children stacked vertically |
| `Row` | `children` (array of ids) | its children in a row |
| `List` | `children` (array of ids), `listStyle` (`ordered` \| `unordered`) | a numbered or bulleted list, one child per item |
| `Card` | `child` (single id) | a bordered box around one child (wrap several in a `Column`) |
| `Divider` | — | a horizontal rule |
| `Link` | `text` (label), `url` | a themed link out to a PR, dashboard, or file |
| `Code` | `text` | a monospace code block |

Anything outside this set (or a malformed `content`) **degrades**: the headline still
shows, plus a "couldn't render" signal — the user always reaches you, but a garbled
notice is a worse notice. Stick to the table.

## Make a `needs-you` notice answerable (choices + free text)

A `needs-you` notice can carry **interactive controls** so the user picks an option and
submits **from the widget** — no need to switch to your terminal. The controls are just
more component types you declare in `content`:

| `component` | Fields | Renders as |
|---|---|---|
| `Choice` | `mode` (`single` \| `multi`), `options` (array of `{ id, label }`) | radios (`single`) or checkboxes (`multi`) |
| `TextInput` | `label` (optional), `placeholder` (optional) | a free-text box, with or without a choice set |
| `Submit` | `label` (optional, default "Submit") | the submit button |

- Each option's `id` is what comes back to you; `label` is what the user reads.
- Include a `Submit` — without it the user can't send the answer.
- A `Choice` with no valid options degrades to an inline marker (still no crash), so
  give every option a non-empty `id` **and** `label`.

```json
{
  "root": "root",
  "components": [
    { "id": "root", "component": "Column", "children": ["q", "pick", "why", "go"] },
    { "id": "q", "component": "Text", "variant": "body", "text": "Which rollback path?" },
    { "id": "pick", "component": "Choice", "mode": "single", "options": [
      { "id": "revert", "label": "Revert the commit" },
      { "id": "forward", "label": "Roll forward with a hotfix" }
    ] },
    { "id": "why", "component": "TextInput", "label": "Anything I should know?" },
    { "id": "go", "component": "Submit", "label": "Send answer" }
  ]
}
```

### What you receive when the user submits

When the user submits, Tinstar **persists the answer on the notice** and **delivers a
prompt to your session** describing it — for example:

```
The user answered your Roundup notice "Which rollback path?" (notice notice-abc123).
They chose: Revert the commit
They added: check the staging logs first
Act on this answer, then keep the board honest: amend the notice
(PATCH /api/notices/notice-abc123) or pull it down (DELETE /api/notices/notice-abc123)
once it is resolved.
```

The answer is durable even if you were busy when it landed — it is saved on the notice
regardless, and the delivery is best-effort. Act on it, then **pull the notice** (or
amend it if there's a follow-up). Don't leave an answered notice standing.

## Let the user disagree with an `fyi` (dissent)

Every `fyi` shows the user a **Disagree** affordance — you don't add anything for it.
**Silence is consent:** if the user does nothing, you keep working. If they *do*
disagree, you get an interruption prompt like:

```
The user DISAGREED with your FYI notice "Skipped a flaky e2e test on CI" (notice notice-xyz).
Their objection: that test caught a real bug last week — don't skip it.
Act on this answer, then keep the board honest: amend the notice … or pull it down …
```

Treat a dissent as a real interruption: reconsider the call, then amend or pull the FYI.

## The depth bar for `content` (this is a requirement, not a style note)

The user arrives **cold**, having not seen your run in an hour. Write the content so
they can orient without a round trip:

- Plain words. Unpack jargon and project-internal terms the first time they appear:
  `term (plain-words meaning)`.
- One idea per sentence. Concrete nouns and verbs, not noun piles.
- Keep the precision — the real distinction, the edge case, the caveat. De-nerd means
  clearer, not vaguer.
- For a `needs-you`, lay out the options you're stuck between (a `List` works well) and
  the tradeoff of each, so the user can pick without asking you to explain.
- Link out with a `Link` component to PRs, dashboards, or files when the real work
  lives elsewhere.

## Post a notice

`POST /api/notices` with `{ sessionId, kind, headline, content? }`. `headline` is
required and non-empty (≤ 200 chars). `content` is optional (omit it for a
headline-only notice) and must be a valid A2UI description (≤ 32 KB serialized) — an
invalid one is **rejected** with `INVALID_PARAMS`, so post a shape from the table above.

```bash
curl -s -X POST "$TINSTAR_URL/api/notices" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg s "$SESSION" '{
    sessionId: $s,
    kind: "needs-you",
    headline: "Deploy to staging or wait for the migration review?",
    content: {
      root: "root",
      components: [
        { id: "root", component: "Column", children: ["h", "p", "opts", "link"] },
        { id: "h", component: "Text", variant: "h2", text: "The auth change is ready" },
        { id: "p", component: "Text", variant: "body",
          text: "Two paths, and the DB migration (the schema change that adds the role column) is not reversible." },
        { id: "opts", component: "List", listStyle: "unordered", children: ["opt1", "opt2"] },
        { id: "opt1", component: "Text", variant: "body",
          text: "Ship now — staging gets it in ~5 min, but the migration has not been reviewed." },
        { id: "opt2", component: "Text", variant: "body",
          text: "Wait — hold until a human reads the migration. Safer, costs ~1 day." },
        { id: "link", component: "Link", text: "the migration PR", url: "https://github.com/org/repo/pull/42" }
      ]
    }
  }')" | jq '.data'
# → { "id": "notice-…", "runId": "…", "kind": "needs-you", "headline": …, "content": {…}, "createdAt": …, "amendedAt": … }
```

Save the returned `id` — you need it to amend or pull.

## Amend a notice in place (do this when the situation changes)

`PATCH /api/notices/:id` with any of `{ kind?, headline?, content? }`. The change
reaches the user **live**. Amend — don't post a second notice — when you discover a new
option, when the situation shifts, or when your recommendation changes. Send the full
new `content` (it replaces the old one); pass `content: null` to drop it to a
headline-only notice.

```bash
curl -s -X PATCH "$TINSTAR_URL/api/notices/notice-abc123" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n '{
    headline: "Deploy to staging, wait, or ship behind a flag?",
    content: {
      root: "root",
      components: [
        { id: "root", component: "Text", variant: "body",
          text: "Found a third path: ship behind a feature flag (off by default), so it deploys but stays dark until reviewed." }
      ]
    }
  }')" | jq '.data'
# amendedAt advances; createdAt is unchanged.
```

## Pull a notice down (do this the moment it's resolved)

`DELETE /api/notices/:id`. Pull it the instant the notice stops being true — the user
answered you, you found another route, a sibling handled it, or the branch died. A
question the user no longer needs to see is exactly the staleness that kills trust in
the board.

```bash
curl -s -X DELETE "$TINSTAR_URL/api/notices/notice-abc123" | jq '.ok'
```

## List what's posted

`GET /api/notices` returns every notice on the board (all runs).

```bash
curl -s "$TINSTAR_URL/api/notices" | jq '.data'
```

## The discipline that makes this work

- **Post when you block; pull when you unblock.** The moment you go idle waiting on the
  user is the moment to post. The moment you can proceed is the moment to pull.
- **Amend, don't accumulate.** One live notice per open question, kept current.
- **Never leave a resolved notice standing.** When in doubt, pull it — a missing notice
  costs the user nothing; a stale one costs them trust.

Your run's notices leave the board automatically when the run is deleted — you don't
have to clean up on shutdown. But while you're alive, keeping them honest is on you.
