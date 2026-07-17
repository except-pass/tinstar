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
  from you. The headline states the choice; the background gives them enough to decide
  without asking you anything.
- **`fyi`** — you made a call the user would want to know about but that does **not**
  block you. Silence is consent; you keep working. Use this for "I skipped the flaky
  e2e test on CI", "I chose Postgres over SQLite", "a hand is handling the migration".

If you are stuck, it's `needs-you`. If you're informing, it's `fyi`. Don't post an `fyi`
for something you actually need answered — it won't read as a question.

## The depth bar for `background` (this is a requirement, not a style note)

The user arrives **cold**, having not seen your run in an hour. Write the background so
they can orient without a round trip:

- Plain words. Unpack jargon and project-internal terms the first time they appear:
  `term (plain-words meaning)`.
- One idea per sentence. Concrete nouns and verbs, not noun piles.
- Keep the precision — the real distinction, the edge case, the caveat. De-nerd means
  clearer, not vaguer.
- For a `needs-you`, lay out the options you're stuck between and the tradeoff of each,
  so the user can pick without asking you to explain.
- Background is **markdown** — use lists, bold, and links freely. Link out to PRs,
  dashboards, or files when the real work lives elsewhere.

## Post a notice

`POST /api/notices` with `{ sessionId, kind, headline, background }`. `headline` is
required and non-empty (≤ 200 chars); `background` is markdown (≤ 16 KB).

```bash
curl -s -X POST "$TINSTAR_URL/api/notices" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg s "$SESSION" '{
    sessionId: $s,
    kind: "needs-you",
    headline: "Deploy to staging or wait for the migration review?",
    background: "The auth change is ready. Two paths:\n\n- **Ship now** — staging gets it in ~5 min, but the DB migration (the schema change that adds the `role` column) has not been reviewed.\n- **Wait** — hold until a human reads the migration. Safer, costs ~1 day.\n\nI lean toward waiting because the migration is not reversible. Your call."
  }')" | jq '.data'
# → { "id": "notice-…", "runId": "…", "kind": "needs-you", "headline": …, "createdAt": …, "amendedAt": … }
```

Save the returned `id` — you need it to amend or pull.

## Amend a notice in place (do this when the situation changes)

`PATCH /api/notices/:id` with any of `{ kind?, headline?, background? }`. The change
reaches the user **live**. Amend — don't post a second notice — when you discover a new
option, when the situation shifts, or when your recommendation changes. The user sees
the updated notice, not a pile of near-duplicates.

```bash
curl -s -X PATCH "$TINSTAR_URL/api/notices/notice-abc123" \
  -H 'Content-Type: application/json' \
  -d '{ "headline": "Deploy to staging, wait, or ship behind a flag?",
        "background": "Found a third path: ship behind a feature flag (off by default)…" }' \
  | jq '.data'
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
