---
title: Reuse the shared readBody helper for new server routes — don't hand-roll body reading
date: 2026-06-30
category: docs/solutions/conventions
module: server-api
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Adding a new server route under src/server/api/ that reads a request body"
  - "Tempted to write `let data = ''; req.on('data', c => data += c)` inline"
  - "Parsing a JSON POST/PUT body in a route handler"
tags: [server-api, request-body, readbody, http, dry, shared-helpers, conventions, tinstar]
---

# Reuse the shared readBody helper for new server routes — don't hand-roll body reading

## Context

A new route (`filePushRoute.ts`) needed to parse a small JSON POST body. The first
draft hand-rolled the reader:

```ts
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) reject(new Error('body too large'))
    })
    req.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
```

This reintroduced a duplicate of `src/server/api/readBody.ts` — which had been
extracted *one commit earlier* (5be73b70, "extract shared utilities for duplicated
code patterns") to be the single place HTTP bodies get read, and is used at 40+
call sites in `routes.ts`/`pluginsConfigRoute.ts`. The hand-rolled version also
regressed behavior three ways. A code-review pass (maintainability + reliability,
independent consensus) flagged it P1.

## Guidance

**Read request bodies through the canonical helper, never inline.** The pattern at
every existing call site:

```ts
import { readBody } from './readBody'

let body: unknown
try {
  const raw = await readBody(req)
  body = raw ? JSON.parse(raw) : {}
} catch {
  fail(res, 'BAD_REQUEST', 'Invalid or oversized JSON body')
  return true
}
```

`readBody` (`src/server/api/readBody.ts`) gives you, for free:

- A **5s read timeout** (`READ_TIMEOUT_MS`) that `req.destroy()`s a stalled/slow-
  trickle connection — a hand-rolled reader with no timer hangs forever.
- A **real 1MB byte cap** (`MAX_BODY_BYTES`) measured on `chunk.length` that
  `req.destroy()`s on overflow — so the cap actually stops buffering.
- **Decode-once** via `Buffer.concat(chunks).toString('utf8')` at end, instead of
  `data += chunk` per chunk.

## Why This Matters

The inline version's three regressions versus the shared helper:

1. **No read timeout.** `data += chunk` with no timer leaves the promise pending
   and the socket open indefinitely if a client never sends `end` or trickles
   bytes slowly.
2. **Multibyte UTF-8 corruption.** `data += chunk` coerces each `Buffer` to a
   string independently. A non-ASCII character (e.g. a unicode filename in the
   path) whose bytes straddle two stream chunks decodes to U+FFFD on each side of
   the boundary — the parsed value no longer matches the real file, producing a
   spurious `NOT_FOUND` or a wrong target. `Buffer.concat` then decode-once avoids
   it entirely.
3. **Cap that bounds nothing.** After `reject()` fires once, the `data` listener
   stays attached and keeps appending; with no `req.destroy()` the whole body
   still buffers into memory. `.length` also counts UTF-16 code units, not bytes,
   so the "64KB" cap was not even a byte cap. The shared helper destroys the
   request on overflow.

Beyond the bug surface: any future security/correctness fix to body reading (a
tighter timeout, an encoding fix) lands in one place and every route inherits it —
a hand-rolled duplicate silently misses it. This is exactly why 5be73b70 extracted
the helper; reintroducing a copy one commit later defeats that.

## When to Apply

- Any new or modified route under `src/server/api/` that consumes a request body.
- Before writing `req.on('data', ...)` by hand — grep for `readBody` first; it
  almost certainly already does what you need.

## Examples

**Before (rejected) — hand-rolled, no timeout, multibyte-unsafe, cap bounds nothing:**

```ts
const MAX_BODY_BYTES = 64 * 1024
function readJsonBody(req) { /* let data=''; req.on('data', c => data += c) ... */ }
// ...
const body = await readJsonBody(req)
```

**After (shipped) — the canonical helper:**

```ts
import { readBody } from './readBody'
// ...
let body: unknown
try {
  const raw = await readBody(req)
  body = raw ? JSON.parse(raw) : {}
} catch {
  fail(res, 'BAD_REQUEST', 'Invalid or oversized JSON body')
  return true
}
```

## Related

- `src/server/api/readBody.ts` — the canonical body reader (5s timeout, 1MB cap, decode-once)
- `src/server/api/routes.ts`, `src/server/api/pluginsConfigRoute.ts` — the 40+ existing `JSON.parse(await readBody(req))` call sites to mirror
- Commit `5be73b70` — "extract shared utilities for duplicated code patterns" (why the helper exists)
- [[no-bespoke-per-plugin-server-routes]] — sibling convention: prefer the shared/generic primitive over a one-off
