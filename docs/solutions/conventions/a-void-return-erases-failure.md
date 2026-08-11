---
title: "Promise<void> on a fallible operation erases failure, and every caller then reports success"
date: 2026-08-11
category: conventions
module: server-reach
problem_type: convention
component: api_layer
severity: high
applies_when:
  - Writing a function that performs a fallible side effect and returns nothing
  - A caller reports success for an operation whose failure is only logged
  - Distinguishing "nothing to do" from "something to do that I did not do"
tags:
  - error-handling
  - api-design
  - return-types
  - reach
---

# A void return erases failure

## Context

Taking down a reach mapping is fallible: the provider daemon may be stopped, the
command may time out, the network may be gone. The function that did it was
declared `Promise<void>`, caught its own error, logged a warning, and returned.

That is a defensible-looking shape — the failure is recoverable, the record is
deliberately left behind for the next reconcile to repair, and the log line says
so. What it cannot do is tell the caller which of those two things happened.

So `disable()` did the only thing it could with no information: it returned
`{ state: 'off' }` unconditionally. The HTTP layer returned 200. The CLI read the
200 as confirmation and **deleted the privilege grant** — removing the only means
of ever completing the teardown. The end state was a host still published on the
tailnet, an operator told it was off, a stored preference saying off so no future
start would reconcile it, and no privilege left to fix it with.

Every layer behaved correctly given what it was told. The defect was in the type.

## Guidance

**If an operation can fail in a way a caller would act on differently, the return
type must be able to say so.** Logging is for humans reading afterwards; a return
value is for the code deciding what to do next. A `void` return forces every
caller to assume success, because assuming success is the only thing available.

**Distinguish "nothing to do" from "something to do that I did not do."** These
produce identical non-action and opposite consequences. The union that replaced
`void`:

```ts
/** What `revokeOurMapping` observed — not what it intended. */
type RevokeOutcome =
  | { kind: 'nothing' }                                    // nothing recorded
  | { kind: 'revoked' }                                    // taken down, confirmed
  | { kind: 'failed'; url: string; detail: string }        // tried, did not go
  | { kind: 'foreign'; url: string }                       // recorded, not ours
```

`nothing` and `foreign` both mean "this call revoked no mapping". Only `foreign`
means something is still published. Collapsing them is what let an instance with
no authority answer a confident "off" and spend a host-global privilege it did not
own.

**Name the type for what it observed, not what it attempted.** The docblock reads
"What `revokeOurMapping` observed — not what it intended." That framing is the
whole correction: the old code reported an intention.

**Carry the detail the caller needs to act, not just a boolean.** `failed` carries
the `url` and the provider's own message, because the operator has to be told
which URL may still be live and why it did not come down. A bare `false` would
have fixed the correctness bug and left the diagnosis impossible.

## Why This Matters

The failure compounds through layers that are each individually correct. Nobody
wrote a bug: the revoke function handled its error, `disable()` returned the only
value it had, the route mapped that to a status, and the CLI acted on the status.
Reviewing any one layer in isolation finds nothing wrong. The defect only exists
in the *composition*, which is why it survived until a reviewer traced the chain
end to end.

It is also self-concealing in the worst way. The operator receives an explicit
confirmation — "reach is off" — that is more convincing than silence would have
been. A command that failed loudly would have prompted a retry; a command that
falsely succeeded ends the interaction.

The deeper point is about what a success value asserts. `off` had been meaning "I
did not observe a problem." What every caller read it as, and what it now means,
is "I checked, and nothing of ours is published." An instance that checked nothing
must not say it.

## When to Apply

- Any `Promise<void>` / `void` function that performs a side effect through a
  network call, a subprocess, a filesystem write, or an external daemon. Ask what
  a caller would do differently on failure; if the answer is anything, the type is
  wrong.
- Any `catch` block whose entire body is a log statement followed by an implicit
  return. That is the exact shape.
- Any early return meaning "there was nothing to do." Check whether a second,
  materially different situation also reaches it.
- Reviewing a cleanup or teardown path where a later step releases a resource
  needed to retry the earlier one. Ordering makes an unreported failure permanent.

## Examples

**Before** — the failure is logged and then discarded:

```ts
private async revokeOurMapping(): Promise<void> {
  const recorded = readReachMapping(this.configRoot)
  if (!mappingIsOurs(recorded, this.instanceId) || !recorded) return
  try {
    await this.provider.revoke({ port: recorded.port, url: recorded.url })
  } catch (err) {
    log.warn('reach', `revoke failed, leaving the record for reconcile: ${err.message}`)
    return                       // <- indistinguishable from success
  }
  unregisterReachOrigin(recorded.url)
  clearReachMapping(this.configRoot)
}
```

Note the guard on the first line: `!mappingIsOurs(...) || !recorded` folds
"nothing recorded" and "recorded but someone else's" into one silent return.

**After** — the same control flow, reporting what it observed
(`src/server/reach/coordinator.ts`):

```ts
private async revokeOurMapping(): Promise<RevokeOutcome> {
  const recorded = readReachMapping(this.configRoot)
  if (!recorded) return { kind: 'nothing' }
  if (!mappingIsOurs(recorded, this.instanceId)) return { kind: 'foreign', url: recorded.url }
  try {
    await this.provider.revoke({ port: recorded.port, url: recorded.url })
  } catch (err) {
    const detail = (err as Error).message
    log.warn('reach', `revoke failed, leaving the record for reconcile: ${detail}`)
    // The record stays: it is how `tinstar doctor` finds the stranded mapping
    // and how a retry knows which URL to take down.
    return { kind: 'failed', url: recorded.url, detail }
  }
  unregisterReachOrigin(recorded.url)
  clearReachMapping(this.configRoot)
  return { kind: 'revoked' }
}
```

The caller can now be honest, and the states it reports are the states that exist:

```ts
const outcome = await this.revokeOurMapping()
if (outcome.kind === 'failed') return this.stranded(outcome.url, outcome.detail)
if (outcome.kind === 'foreign') return { state: 'refused', detail: /* … */ }
return { state: 'off' }
```

## Related

- `CONCEPTS.md` — **Stranded** is the state this return type made expressible: the
  operator asked for off and the provider may still be publishing. It could not be
  reported while the function returned `void`, because nothing knew it had
  happened.
- `docs/solutions/conventions/verify-a-guard-by-breaking-it.md` — the tests for
  the new outcomes were each proven by mutation, since "reports refused" and
  "reports off" are both green-looking states and only the mutation distinguishes
  a real check from a fixture that never reached it.
