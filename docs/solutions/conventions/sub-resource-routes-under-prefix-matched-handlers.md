---
title: "Adding a sub-resource route under a prefix-matched handler (and it deletes your data)"
date: 2026-07-20
category: conventions
module: server-api
problem_type: architecture
component: http_routing
severity: high
applies_when:
  - Adding /api/<thing>/:id/<action> when /api/<thing>/:id already exists
  - Adding any route beneath an existing handler matched with startsWith
  - Reviewing a route that mutates or deletes by id
---

# Sub-resource routes under a prefix-matched handler

The server's routes are a manual if-chain in `src/server/api/routes.ts`, and many handlers match with `url.startsWith('/api/thing/')` — **greedy prefix matching, first match wins.** That makes adding a sub-resource route a data-loss hazard, not just a routing detail.

## The trap

`DELETE /api/notices/:id` (pull a notice) matches `url.startsWith('/api/notices/')`. Adding `DELETE /api/notices/:id/dismiss` (undo a dismissal) **after** it means the pull route wins: the request falls through and **deletes the notice outright**. The user clicks "undo dismiss" and their card is destroyed. Nothing errors; it looks like it worked.

The same shape bites any `/:id/<action>` added under an existing `/:id` handler — approve, archive, retry, cancel.

## The rule

1. **Match sub-resources with an anchored regex, not `startsWith`** — e.g. `/^\/api\/notices\/[^/]+\/dismiss$/`, tested against the path with the query string stripped (`url.split('?')[0]`).
2. **Place the sub-resource handler BEFORE the generic `/:id` handler.** Order is the safety property; the regex alone doesn't help if the greedy route runs first.
3. **Write a test that fails if the ordering is reverted.** Assert the destructive outcome does *not* happen — e.g. "DELETE …/dismiss clears the flag and the notice still exists". A test that only asserts the happy path passes even when the greedy route ate the request, because deleting also returns 200.

Ordering is invisible in review — the diff shows a new handler, not where it sits relative to its neighbour — so the test is the only durable guard.

**Known gap, deliberately not fixed:** the generic pull route slices the id without stripping the query string, so `DELETE /api/notices/abc?x=1` targets an id of `abc?x=1` and silently misses. Pre-existing; noted rather than widened into an unrelated fix.

## Two smaller lessons from the same slice

- **Don't clear optimistic UI by watching a value that may not change.** Clearing an optimistic override in a `useEffect` keyed on the server field is stuck-prone: if a reload races an SSE delta and returns the pre-write snapshot, the field never moves and the card stays optimistic forever. Clear it in the success path instead (`await onChanged(); clear()`). The tradeoff — a brief bounce-back to server truth when the reload is stale — beats a permanent lie.
- **A "recedes on its own" claim needs something to tick.** Pure time helpers that take `now` as a parameter are correct and testable, but if nothing re-renders, a card left open never crosses its own staleness threshold and the age label freezes. Keep the helpers pure; put a low-frequency interval in the caller. Tests that pin `now` will not catch this — the gap is invisible to the suite.

## Related

- `docs/solutions/conventions/widget-to-agent-answer-back.md` — the answer path (which *does* prompt the agent); dismissal deliberately does not.
- `docs/solutions/conventions/adding-a-docstore-entity-and-plugin-widget.md` — the docstore mutator equality contract that any new field (like `dismissedAt`) must be added to, or the update fails silently.
