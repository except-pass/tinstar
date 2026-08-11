---
title: "Caching a containment check is safe in one direction and dangerous in the other"
date: 2026-08-11
category: conventions
module: server-sessions
problem_type: convention
component: session_spawning
severity: high
applies_when:
  - Memoizing the result of a preflight check that gates a privileged or exposing action
  - Adding a version, capability, or permission probe that runs before spawning a process
  - Reviewing a cache whose entries have no invalidation path
tags:
  - caching
  - security
  - preflight
  - external-tools
  - staleness
---

# Never cache a containment check

## Context

Tinstar refuses to spawn a terminal on a ttyd below 1.7.4. The reason the floor
exists is specific: below it, the `-i` (bind address) and `-H` (auth header) flags
are **accepted and ignored**, so the terminal binds every interface and admits
anyone, with no error anywhere. The check is not asking "can this binary do what I
want?" — it is asking "will this binary contain what I am about to start?"

The probe shells out (`ttyd --version`), so memoizing it looked obviously correct:
one exec per process instead of one per spawn.

Two rounds of review pulled that apart. The first pass fixed only half of it —
stop caching *failed probes*, because one transient exec failure would otherwise
refuse every spawn for the life of the process, and the refusal's own remedy
("upgrade ttyd") cannot clear a cache that outlives the upgrade. The second pass
caught what remained: the dangerous direction was never the cached refusal.

## Guidance

**A cached PASS on a containment check is a staleness vulnerability.** The
memoized answer says "the binary I looked at was safe." What the caller needs is
"the binary I am about to execute is safe." Those diverge the moment anything
changes the binary underneath a long-running process — a package upgrade, a
downgrade, a rebuild, a `PATH` change, an operator swapping it by hand. The
process keeps spawning against a verdict reached at boot, which is precisely the
exposure the floor exists to prevent.

**A cached REFUSAL is merely useless; a cached PASS is unsafe.** They are not
symmetric, and treating them as one cache with one policy is what hides that. The
refusal direction fails closed — annoying, recoverable, and it announces itself.
The pass direction fails open and announces nothing.

**Price the check against what it protects, not against the code around it.** The
probe costs about 20ms and runs once per terminal spawn. Terminal spawns are
user-initiated and infrequent; nothing in that path is competing for 20ms. The
memoization was optimising a cost that did not exist, against a risk that did.

**Do not leave a function named for a cache it no longer has.** The function is
now `ttydVersionRefusalNow`, not `…Cached`. A name that lies about lifetime is
worse than either behaviour, because the next reader reasons from the name.

## Why This Matters

The general shape: **any check whose answer authorises a privileged or exposing
action must be evaluated against the world as it is at the moment of the action,
not as it was when the process started.** Memoization silently converts a
precondition into a historical claim.

What makes it hard to see in review is that the cache is *correct* for the
overwhelmingly common case. Nobody swaps a binary under a running server most
days. The cache is right until the one moment it matters, and that moment is
indistinguishable from every other until afterwards.

There is a related trap in how the refusal reads. The message tells the operator
to upgrade ttyd. With a process-lifetime cache, following that instruction changes
nothing — the operator does exactly what they were told, observes no change, and
reasonably concludes the diagnosis was wrong. A cache that invalidates the
remedy printed by its own error message is a special kind of unhelpful.

## When to Apply

- Any preflight that gates spawning a process, acquiring a privilege, opening a
  port, or contacting an external service. Ask what the cached answer authorises,
  then ask what changes underneath it.
- Reviewing a memoized probe of an external binary, file, or service. The
  question is not "is this cache correct?" but "what does a stale PASS permit?"
- Any cache with no invalidation path at all. If nothing can evict an entry, its
  lifetime is the process, and the check has become a boot-time assertion whether
  or not that was intended.
- Naming: if the lifetime changes, change the name in the same commit.

## Examples

The current form — no cache, and the docblock carries the reasoning so a future
reader does not re-add one as an optimisation
(`src/server/sessions/backends/tmux.ts`):

```ts
/**
 * Probed fresh on every spawn. Deliberately NOT memoized.
 *
 * The floor is a containment control, not a capability hint: below 1.7.4 the
 * `-i` and `-H` flags are accepted and ignored, so a terminal binds every
 * interface and admits anyone. A cached PASS is the dangerous direction — a
 * binary upgraded, downgraded, or repackaged under a long-running server would
 * keep spawning against a determination made at boot, which is exactly the
 * exposure the floor exists to stop. A cached REFUSAL is merely useless: it
 * outlives the upgrade its own message tells the operator to perform.
 *
 * The probe costs ~20ms and runs once per terminal spawn, so there is nothing
 * to buy back here.
 */
export function ttydVersionRefusalNow(
  readVersion: () => string | null = () => {
    try {
      return execSync('ttyd --version', { encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' })
    } catch {
      return null
    }
  },
): string | null {
  return ttydVersionRefusal(readVersion())
}
```

The test asserts the probe actually runs each time, rather than asserting the
absence of a cache — which is not observable from outside:

```ts
let probes = 0
const reads = ['ttyd version 1.7.4', 'ttyd version 1.6.3', null]
const read = () => { const v = reads[probes]; probes += 1; return v ?? null }

const verdicts = [ttydVersionRefusalNow(read), ttydVersionRefusalNow(read), ttydVersionRefusalNow(read)]
expect(probes).toBe(3)
```

The probe count is asserted **first**, deliberately. With a memoizing
implementation the second call returns the cached `null`, and a value assertion
would fail on a type error about the cached value rather than naming the caching.
Reintroduce a cache and this reports `expected 1 to be 3`, which is the actual
defect.

## Related

- `docs/solutions/conventions/verify-a-guard-by-breaking-it.md` — the probe-count
  assertion above was proven by reintroducing the cache and watching it go red.
  This doc adds a wrinkle that practice does not cover on its own: a guard can
  fail for the wrong stated reason, and a failure message that names the wrong
  thing is only half a guard.
- `docs/solutions/conventions/probing-a-header-gated-service.md` — the same `-H`
  flag from the other side, and why "the flags are silently ignored below the
  floor" is worth refusing over rather than warning about.
