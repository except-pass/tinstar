# PR Briefing Contract

Brief exactly one refreshed PR head. Keep every claim tied to evidence and make the decision possible without opening GitHub.

## Required briefing

1. **Identity and purpose** — PR number/title, author, base ← head, full head OID, draft state, and the problem or outcome the change claims to address.
2. **What is in it** — material behavior, files/components, tests, migrations/config/docs, and notable commits. Summarize the diff; do not merely repeat the PR description.
3. **Architecture** — entry points, control/data flow, boundaries touched, important dependencies, persistence or lifecycle changes, and how the change fits existing patterns.
4. **Confirmed working** — only observed evidence. Name the check or local command and result.
5. **Confirmed not working** — failing checks, reproduced failures, conflicts, broken behavior, or incomplete cleanup with the evidence that establishes each.
6. **Unverified** — claims that remain plausible but were not demonstrated. Do not turn green CI into proof of behavior it did not test.
7. **Surprising omissions** — what a reasonable reader might expect from the PR's claim but the diff does not include: tests, docs, migration/rollback, error paths, telemetry, permissions, compatibility, cleanup, or related interfaces. Say “none found” only after comparing claims with the actual diff and nearby code.
8. **Landing state and blockers** — mergeability, conflicts, required checks, reviews, dependency edges, queue requirements, permissions, and policy-compatible merge methods.
9. **Decision** — safe choices available now and the exact approval scope if landing is available.

## Evidence labels

Prefix behavioral statements with one of:

- **CI-confirmed** — a named host check ran on this exact head and its result is visible.
- **Locally reproduced** — a named command ran at this exact head; include pass/fail and the relevant observation.
- **PR-author-claimed** — PR-controlled prose asserts it, but execution evidence does not establish it.
- **Unverified** — evidence is absent, unavailable, stale, or does not test the claim.

Review approval, a green aggregate status, and absence of reported failures are not behavioral proof by themselves.

## Blocked PRs

Conflicts or failing CI change the landing options, not the briefing depth. Explain the full change first. Then name each blocker separately and ask whether to repair, watch, skip, defer, choose another PR, or stop. Never hide architecture or omissions behind “not mergeable.”

## Refresh rule

The briefing is valid for its displayed head. Refresh it after any repair or head change. Routine CI/review settlement on the same head updates the landing-state section without invalidating the operator's head-bound merge approval.
