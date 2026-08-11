---
title: "An empty CORS allowlist is a live wildcard, not a neutral default"
date: 2026-08-11
category: conventions
module: server-api
problem_type: convention
component: api_layer
severity: high
applies_when:
  - Adding or reviewing a CORS allowlist whose empty state has a fallback branch
  - Adding a state-changing route to a server that answers browsers
  - Wiring a second server entry point that shares route handlers with the first
tags:
  - cors
  - security
  - api
  - defaults
  - browser-origin
---

# An empty CORS allowlist is a live wildcard

## Context

`resolveCorsHeaders` answers an empty allowlist with a wildcard
(`src/server/api/cors.ts:26-28`):

```ts
if (allowlist.length === 0) {
  return { 'Access-Control-Allow-Origin': '*', ...methodsAndHeaders }
}
```

Read as configuration, that looks like the neutral state — nothing configured, so
no policy. Read as behaviour, it is the *most permissive possible* policy, served
to every caller, and it is the state a server occupies before anything seeds the
list.

The containment work made that state reachable and load-bearing at once. The
standalone server now seeds the allowlist explicitly, at two points, because one
was not enough: `src/server/standalone.ts:240` before the listeners accept, and
again at `:317` in the post-bind callback once the *actual* port is known (the
listener walks past a busy port, so the configured port can be the wrong one).
The first call is what closes the window between "accepting connections" and
"knowing which port we got".

## Guidance

**A permissive fallback is a policy, and it is the policy you ship by default.**
An allowlist with a wildcard-on-empty branch is not off — it is on and open. The
question to ask of any such branch is not "what is configured?" but "what does an
unconfigured process actually answer?"

**Every entry point that shares the handlers must reach the same state.** Route
handlers get shared long before their initialisation does. Here the standalone
server seeds and the Vite dev-server backend does not, so the same
`resolveCorsHeaders` call answers a wildcard on one and a real allowlist on the
other. Sharing a handler does not share whatever the other entry point remembered
to call at boot.

**Seed before you accept, not after.** A server that seeds in a post-listen
callback has a window — small, real, and exactly the kind of thing that never
reproduces locally — where it is accepting requests with an empty list.

**CORS protects the response, not the side effect.** This is the part that makes
the wildcard worse than it looks on a state-changing route. The browser sends the
request first and applies the policy to whether the *caller may read the reply*.
For `GET`, hiding the reply is the whole game. For a `POST` that changes what a
host is reachable from, the damage is done before CORS is consulted at all.

That is why a state-changing route needs a gate of its own rather than relying on
the allowlist to be non-empty. Requiring `Content-Type: application/json` is that
gate, and it is a security control rather than a formality: `application/json` is
not a CORS-safelisted content type, so a cross-origin request carrying it **must**
be preflighted. The preflight is where the allowlist gets to say no *before* the
request with the side effect is ever sent. Accepting `text/plain` on the same
route re-opens it, because `text/plain` is safelisted and rides through with no
preflight at all.

## Why This Matters

The failure mode is invisible in the direction people check. Nobody notices a
wildcard, because a wildcard breaks nothing — every request succeeds, every
browser is happy, and the only symptom is a permission you did not intend to
grant. An allowlist bug that *refuses* legitimate traffic reports itself
immediately; one that admits everything reports nothing, ever.

It is also the exact shape that survives a containment review. A change can
correctly narrow what the server binds, correctly gate the terminal upgrade, and
still answer `Access-Control-Allow-Origin: *` to anyone who asks, because the
allowlist was empty rather than wrong.

## When to Apply

- Reviewing any `if (list.length === 0)` branch that returns a permissive value.
  State plainly what an unconfigured process serves; if that sentence is
  uncomfortable, the default is wrong.
- Adding a second entry point (a dev server, a test harness, an embedded mode)
  that mounts existing handlers. Enumerate what the first entry point calls at
  boot that the new one does not.
- Adding any route that mutates state and is reachable from a browser. Require a
  non-safelisted content type so a preflight is forced, and check the Origin
  yourself — an absent Origin is fine (that is a CLI, not a browser), an
  unrecognised one is not.

## Examples

The seeded list, which is what makes the wildcard branch unreachable in the
standalone server (`src/server/api/originAllowlist.ts`):

```ts
export function seedOriginAllowlist(boundPort: number): void {
  seeded = [
    `http://localhost:${boundPort}`,
    `http://127.0.0.1:${boundPort}`,
    `http://[::1]:${boundPort}`,
    ...DESKTOP_APP_ORIGINS,
  ]
}
```

All three loopback spellings are present deliberately — a browser sends the origin
the user typed, and `localhost`, `127.0.0.1`, and `[::1]` are three different
strings for the same machine.

The gate on the state-changing route, in `src/server/api/routes.ts`, refusing
before the body is even parsed:

```ts
const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
if (contentType !== 'application/json') {
  fail(res, 'BAD_REQUEST', 'Content-Type must be application/json', { status: 415 })
  return true
}
const origin = req.headers.origin
if (!isUpgradeOriginAllowed(origin, currentOriginAllowlist())) {
  fail(res, 'FORBIDDEN', `origin ${origin ?? '(none)'} may not change reach`)
  return true
}
```

The order matters: the content-type check is what forces the preflight, and the
Origin check is what makes the preflight answer no. Either alone is half a gate.

## Related

- `docs/solutions/conventions/verify-a-guard-by-breaking-it.md` — a wildcard
  default is the archetype of a guard that is vacuously green. Nothing fails when
  it is wrong, so only a test that asserts the *absence* of the wildcard can catch
  it.
