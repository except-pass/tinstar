---
title: "A guard that goes red for the wrong stated reason is only half a guard"
date: 2026-08-11
category: conventions
module: testing
problem_type: convention
component: test_strategy
severity: medium
applies_when:
  - Verifying a guard by mutating the code it protects
  - Ordering assertions inside a test that will be read by whoever it fails on
  - A test fails under mutation with a type error rather than a value mismatch
tags:
  - test-strategy
  - guards
  - assertions
  - failure-messages
---

# A guard must fail for the reason it claims

## Context

This repo already documents the practice of proving a guard by breaking the thing
it protects and watching the specific test go red
(`docs/solutions/conventions/verify-a-guard-by-breaking-it.md`). Applying it to a
new test surfaced a gap the practice does not cover on its own.

The guard: a memoization was removed from a containment check, and a test asserts
the probe runs on every call rather than once. Written the obvious way:

```ts
expect(ttydVersionRefusalNow(read)).toBeNull()
expect(ttydVersionRefusalNow(read)).toContain('1.6.3')
expect(ttydVersionRefusalNow(read)).toContain(TTYD_MIN_VERSION)
expect(probes).toBe(3)
```

Reintroducing a cache did turn it red, so by the letter of the practice it
passed. But the failure read:

```
AssertionError: the given combination of arguments (null and string) is invalid
for this assertion. You can use an array, a map, an object, a set, a string, or
a weakset instead of a string
```

With a cache, the second call returns the memoized `null`, and `.toContain()` on
`null` throws a chai *type* error. Nothing in that message mentions caching,
probe counts, or the containment check. Someone hitting it a year from now
reasonably concludes the test is malformed and deletes or rewrites it — which is
the same outcome as not having the guard.

Reordering so the count is asserted first:

```ts
// Probe count first: a memoizing implementation fails HERE, naming the
// actual defect, instead of tripping a type error downstream on a cached
// null and reporting something unrelated.
const verdicts = [ttydVersionRefusalNow(read), ttydVersionRefusalNow(read), ttydVersionRefusalNow(read)]
expect(probes).toBe(3)

expect(verdicts[0]).toBeNull()
```

Same guard, same mutation, and the failure now reads `expected 1 to be 3` — which
is the defect, stated.

## Guidance

**Breaking a guard proves it can fail. It does not prove the failure will tell
you what broke.** These are two separate properties and the practice of
break-and-watch only establishes the first. Read the message the mutation
produces, not just the red.

**Assert the load-bearing property before anything that could throw on its
inputs.** The property a guard exists for should be checked first, while the
surrounding values are still whatever they are. Value assertions that consume the
results of the thing under test can fail for incidental reasons — wrong type,
null, undefined — and whichever assertion trips first is the one the reader sees.

**Separate collecting from asserting when the assertions are order-sensitive.**
Gathering results into a local first, then asserting the invariant, then asserting
the values, means no assertion is competing to be the one that reports. Inlining
calls into assertions couples the order you check to the order you invoke.

**The test's failure message is its primary interface.** A test is written once
and fails to someone else, usually under time pressure, usually with no context.
That message is the entire handoff. A guard whose message names the wrong thing
spends its one chance to be understood on a wrong answer.

## Why This Matters

The consequence is delayed and looks like ordinary maintenance. A test that fails
incomprehensibly does not get debugged — it gets marked flaky, skipped, rewritten
to pass, or deleted. The protection disappears through a normal-looking cleanup
commit, and nothing records that a guard was lost, because from the outside it
looked like a broken test being tidied up.

There is a specific trap in mutation-testing that produces this. When you mutate
the code and see red, the mutation is fresh in your mind, so *you* can read any
failure message as confirmation — you already know what you changed. The message
is being interpreted with context the future reader will not have. Confirming a
guard is exactly the moment you are least equipped to judge whether its message
stands alone.

## When to Apply

- Every time you verify a guard by mutation. Read the message, and ask whether it
  names the property or merely reports that something went wrong.
- When a test contains one structural assertion (a count, an ordering, a call
  happened) alongside value assertions on the same results. Put the structural one
  first.
- When a mutation produces a type error, a null-dereference, or a framework
  complaint rather than a value mismatch. That is the signal: the test is failing
  downstream of the thing it guards.
- Reviewing a test whose name states a property. Ask what the failure output would
  say, and whether it would say that property.

## Examples

**The tell.** Under mutation, compare the message to the test name:

| Test name | Message under mutation | Verdict |
|---|---|---|
| "does not memoize a failed probe" | `the given combination of arguments (null and string) is invalid for this assertion` | names nothing — reorder |
| "re-probes on every spawn rather than trusting a boot-time answer" | `expected 1 to be 3` | names the defect |

Both are the same guard over the same code, mutated the same way. Only the
assertion order differs.

**Good failures from elsewhere in this work**, each produced by deliberately
breaking the thing guarded:

```
expected [] to include 'https://fake.example/5273'   # origin not re-registered on reconcile
expected 'off' to be 'stranded'                      # a failed revoke reported as success
expected "spy" to not be called at all, but actually been called 1 times
                                                     # refusal moved after the inventories
expected false to be true                            # test wrote outside its own config root
```

Each names the property in its own test's terms. None requires knowing what was
mutated to interpret it.

## Related

- `docs/solutions/conventions/verify-a-guard-by-breaking-it.md` — the practice this
  refines. That doc establishes that a guard you have not watched fail is not
  evidence; this one adds that a guard you have watched fail *for the wrong stated
  reason* is evidence you will lose later, when someone tidies up a test that
  appears broken.
- `docs/solutions/conventions/never-cache-a-containment-check.md` — the guard whose
  message prompted this, and where the reordered assertion now lives.
