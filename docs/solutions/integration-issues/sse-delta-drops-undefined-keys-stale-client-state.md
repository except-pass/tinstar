---
title: SSE run-delta drops undefined keys, so client spread-merge inherits stale state forever
date: 2026-07-06
category: integration-issues
module: src/hooks/useServerEvents.ts (client) + src/server/api/sse.ts / document-store.ts (server)
problem_type: integration_issue
component: service_object
symptoms:
  - "A run field that was cleared server-side (e.g. attention set back to undefined) never clears on the client — the old value persists across every subsequent delta."
  - "A background session's breakthrough card and inbox row never returned to invisibility after its attention was cleared."
  - "All unit tests pass; only a real-browser e2e against a live standalone reproduces it."
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [sse, state-sync, serialization, react, undefined, delta-merge, document-store]
---

# SSE run-delta drops undefined keys, so client spread-merge inherits stale state forever

## Problem

When the server clears a nullable field on a `Run` (storing it as `undefined`), `JSON.stringify` omits that key from the SSE delta payload entirely. The client's `mergeRun` then spread-merges `{ ...prevRun, ...next }`, and because the key is *absent* from `next`, the stale value from `prevRun` survives — permanently, across every future delta.

## Symptoms

- A field cleared server-side never clears on the client (observed with `attention`: a background session's breakthrough card/inbox row never returned to invisibility after attention was cleared).
- The full run object is emitted on every change, so the bug looks impossible from reading either side in isolation.
- Unit tests on the server derivation and on `applyDelta` in isolation all pass; the wiring bug only surfaces end-to-end (real browser + live standalone SSE stream).

## What Didn't Work

- Verifying the server *sets* `attention` to `undefined` correctly — it does; the value is correct at the source.
- Trusting the piece-wise unit tests. The server-side derivation was tested, the client `applyDelta` was tested, but nothing exercised a set→clear round-trip over a real serialized SSE payload, which is exactly where `JSON.stringify`'s undefined-dropping bites.

## Solution

In the client run-merge, take each clearable field **explicitly** from the incoming delta instead of relying on the spread to overwrite it. Run deltas always carry the full run, so an absent key means "cleared", not "unchanged":

```ts
// src/hooks/useServerEvents.ts — mergeRun
// Before: a cleared field survives because JSON.stringify dropped its key
//   return { ...prevRun, ...next }
// After: clearable fields are read explicitly (absent in `next` => cleared)
return { ...prevRun, ...next, attention: next.attention }
```

A regression test covers the set→clear round-trip at the `applyDelta` layer.

## Why This Works

The spread `{ ...prevRun, ...next }` only overwrites keys that are *present* in `next`. `JSON.stringify({ attention: undefined })` produces `{}` — the key is gone from the wire payload — so the spread has nothing to overwrite `prevRun.attention` with. Naming `attention: next.attention` forces the value to `undefined` regardless of whether the key rode the wire, which is correct precisely because run deltas are always full snapshots (the contract that makes "absent = cleared" safe).

## Prevention

- **Any nullable/clearable field on the `Run` (or any other full-snapshot delta entity) must be read explicitly in the merge, not left to the spread.** When adding such a field, add the explicit line in `mergeRun` and a set→clear regression test.
- **Test the serialized round-trip, not just the pieces.** The set→clear path only fails after `JSON.stringify`; a unit test that hands `applyDelta` a hand-built object with the key still present will pass while production breaks. Assert on state after a real cleared-field delta (key omitted), or cover it in an e2e that drives a live SSE stream.
- Alternative server-side guard (not chosen here): emit `null` instead of `undefined` for cleared fields so the key survives serialization. The client-side explicit-read is preferred because it is local to the consumer and does not depend on every emitter remembering to use `null`.

## Related Issues

- Surfaced while building background sessions (PR #104); the cleared field was `attention`, which drives the breakthrough card/inbox-row visibility of hidden sessions.
- Related follow-ups: except-pass/tinstar#101, except-pass/tinstar#102 (both about untested cross-layer wiring — the same class of gap that hid this bug).
