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
| `Mermaid` | `source` (a Mermaid definition string) | a themed diagram — e.g. `graph TD\n  A --> B\n  B -->\|yes\| C`. Reach for it instead of drawing a flow as ASCII art in a `Code` block. A bad or empty `source` degrades to a small inline notice. |

Anything outside this set (or a malformed `content`) **degrades**: the headline still
shows, plus a "couldn't render" signal — the user always reaches you, but a garbled
notice is a worse notice. Stick to the table.

Three more component types exist for interaction rather than prose: `Choice`,
`TextInput`, and `Submit` (see "Make a `needs-you` notice answerable"), plus `FollowUp`
(see "Declare the follow-ups you expect").

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

## The user can ask you a follow-up before they answer

Answering is not always the user's first move. Often they need to ask something first —
"why this?", "what if I do nothing?", and most of all **"explain that more plainly"** —
before they can decide. Every notice therefore carries a small **ask panel**: a
collapsible thread beside the card where the user asks and you answer.

### How a follow-up arrives

When the user asks, Tinstar **appends the question to the notice's thread** and
**delivers a prompt to your session**:

```
The user asked a follow-up about your Roundup notice "Which rollback path?" (notice notice-abc123).

Their question: Can you explain that more plainly?

What they are asking for: Rewrite this notice's background in plainer language. …

Do BOTH of these — they are not alternatives:

1. REPLY on the thread …
2. AMEND the notice whenever the answer improves it …
```

Like an answer, the question is **durable whether or not you were reachable** — if you
were busy, you'll find it on the notice via `GET /api/notices`. `amendedAt` does *not*
move when someone asks: a question is not an amend, and the board's staleness signal
must keep telling the truth about when *you* last tended the notice.

### You must do BOTH: reply AND amend

This is the part that's easy to get wrong. Answering only on the thread is a **failure
mode**, not a shortcut:

1. **Reply on the thread** — so the user gets their answer where they asked:

   ```bash
   curl -s -X POST "$TINSTAR_URL/api/notices/notice-abc123/replies" \
     -H 'Content-Type: application/json' \
     -d '{"author":"agent","text":"Reverting takes ~2 minutes; rolling forward needs a review."}'
   ```

2. **Amend the notice** whenever the answer improves it — which is most of the time:

   ```bash
   curl -s -X PATCH "$TINSTAR_URL/api/notices/notice-abc123" \
     -H 'Content-Type: application/json' \
     -d '{"content": { "root": "root", "components": [ … revised … ] }}'
   ```

If your reply contains anything a *fresh* reader of the board would need, it belongs in
the notice body. A thread holding the real explanation while the card still says the old
thing means the next person has to read a conversation to learn what the notice should
have said in the first place. **The thread is the conversation; the notice is the record.**

Keep the reply concise — the depth goes into the amended notice.

### "Simplify your explanation" — what it actually requires

This is the preset the user reaches for most, and it does **not** mean "dumb it down".
It means rewrite the notice's background at **de-nerd depth**:

- **Plain words.** Swap needless jargon for ordinary language.
- **Jargon unpacked.** Define every project-internal, acronym-heavy, or
  framework-specific term the first time it appears — `term (plain-words meaning)`.
- **One idea per sentence.** Break long compound sentences apart.
- **Precision KEPT.** Every load-bearing detail, caveat, and edge case stays. Do not
  blur a real distinction just to sound plain, and do not drop the specifics the
  decision actually turns on.

The target reader is a **smart peer outside this particular niche** — not a beginner.
And **amend the notice** with the plainer version; don't just append a glossary to the
thread and leave the original wall of jargon standing.

### Declare the follow-ups you expect

Beyond the universal presets (`Simplify your explanation`, `Why this?`,
`What if I do nothing?`, `More background`, `Show me the code`), which appear on
**every** notice for free, you can declare questions specific to *this* notice:

| `component` | Fields | Renders as |
|---|---|---|
| `FollowUp` | `id`, `label` (the chip), `question` (what gets asked) | a chip in the notice's ask panel |

```json
{ "id": "rollback-cost", "component": "FollowUp",
  "label": "How long is the rollback?",
  "question": "How long would a rollback take, and is it reversible?" }
```

A `FollowUp` is a **declaration, not a body element** — it renders in the ask panel
beside the card, never inline in the prose, so the card stays glanceable. Put them
anywhere in `components`. Give each a non-empty `id`, `label`, and `question`, or the
declaration is dropped. You cannot reuse a universal preset's id (`simplify`, `why`,
`do-nothing`, `background`, `show-code`) — those mean the same thing on every notice.

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

## The user can dismiss a notice — that is not a signal to act

The user can mark any notice **dismissed**: "I've seen this, it's off my plate."
A dismissed notice dims, collapses, and sinks below the live ones on the board, but
it is **not** deleted and the user can undo it.

Two things follow, and both matter:

- **You are not told when it happens, and you should not act on it.** Dismissing is
  about the user's attention, not about your work. It is not an answer, not an
  approval, and not a rejection. There is no prompt, on purpose — a dismissal that
  cost you a turn would make the board expensive to post to.
- **It does not clean up after you.** A dismissed notice is still on the board and
  still yours. Pull a notice the moment you know it's resolved (`DELETE
  /api/notices/:id`), exactly as you would have. Do not assume a dismissal means the
  user already handled it, and do not treat "they'll just dismiss it" as a reason to
  leave a resolved notice standing.

The board also **de-emphasizes notices you haven't touched in a while** — an old,
untended card visibly recedes. Nothing happens to it and nobody is notified; it just
reads as stale. That is another reason to amend a notice when the situation moves.

## The discipline that makes this work

- **Post when you block; pull when you unblock.** The moment you go idle waiting on the
  user is the moment to post. The moment you can proceed is the moment to pull.
- **Amend, don't accumulate.** One live notice per open question, kept current.
- **Never leave a resolved notice standing.** When in doubt, pull it — a missing notice
  costs the user nothing; a stale one costs them trust.
- **Answer a follow-up on the thread AND in the notice.** A reply the card doesn't
  reflect is knowledge you left in a side conversation.
- **A follow-up is a signal your notice was unclear.** If someone had to ask, the next
  reader would have too — fix the notice, not just the thread.

Your run's notices leave the board automatically when the run is deleted — you don't
have to clean up on shutdown. But while you're alive, keeping them honest is on you.
