---
title: "A passing test is not a working guard — verify it by breaking the thing it guards"
date: 2026-07-20
category: conventions
module: testing
problem_type: best_practice
component: test_strategy
severity: medium
applies_when:
  - Writing a test whose job is to protect an invariant (ordering, a security check, a loop-breaker)
  - Adding a route, handler, or middleware whose correctness depends on position
  - Reviewing a guard that has never been observed failing
---

# Verify a guard by breaking it

A test that passes tells you the code works *today*. A **guard** has a harder job: it must fail the day someone removes the protection. Those are different properties, and the second one is not implied by the first.

## The false guard we shipped and caught

Adding `POST /api/notices/:id/replies` under prefix-matched handlers, we wrote the obvious behavioural guard: "a replies call doesn't delete the notice." It passed. It was also **worthless** — there is no generic `POST /api/notices/:id` handler to swallow the request, so the route works by accident even when placed in the wrong position. The behavioural test would have stayed green while the protection was gone, and the next person to add a `POST` prefix handler would have silently broken it.

The real guard asserts the **invariant itself** — source position:

```ts
const src = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8')
expect(src.indexOf(repliesRegex)).toBeLessThan(src.indexOf(genericPatchHandler))
```

Ugly, and correct. When the property is *ordering*, assert ordering.

## The practice: break it, watch it go red, restore

For any test whose purpose is protection, complete the loop:

1. Write the guard.
2. **Remove or invert the thing it guards.**
3. Confirm the test fails — the specific test, for the specific reason.
4. Restore, confirm green.

Three guards in this slice were verified that way, and one had to be redesigned because step 3 failed:

- **Route ordering** — moved the handler below the greedy ones; the behavioural test stayed green (false guard), the structural one went red. Kept both.
- **The anti-loop guard.** Replies deliver a prompt only when `author === 'user'`; an agent's own reply must never prompt its own session, or it prompts itself forever. Replacing the condition with `if (true)` had to fail a test — and initially didn't, because the harness never seeded a session, so `delivered` was `false` for every case and "not delivered because no session" was indistinguishable from "not delivered because agent." Stubbing the session/prompt layer made the guard real.
- **A time bound** on a "waiting for reply" shimmer — reverted the suppression, watched the timeout test go red.

## The tell

If you cannot describe **what edit would make this test fail**, you have written a description, not a guard. "Not delivered" passing for two different reasons is the classic shape: the assertion is satisfied by the bug and by the fix alike.

## Related

- `docs/solutions/conventions/sub-resource-routes-under-prefix-matched-handlers.md` — the routing trap this guard protects (where a mis-ordered `DELETE …/dismiss` would have deleted the notice outright).
