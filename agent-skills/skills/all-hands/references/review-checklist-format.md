# Review Checklist — Format Guide

Your review checklist is the contract you commit to in Phase 1 and grade against in Phase 3. **Do not change it after briefing closes** — that's goalpost drift, and it's the failure mode this skill is engineered against.

## Format

Each item has:

- A **gradable assertion** — could a stranger confirm pass/fail by reading the diff?
- A **tier** — must-pass (block on failure) or should-pass (concerns on failure)

## Good examples

```
## Must-pass (any failure → block)

- [ ] No secrets, tokens, or credentials are added in plaintext to any committed file
- [ ] All new HTTP endpoints validate request body against a schema before any side effect
- [ ] Any new env var is documented in `.env.example` with a placeholder value

## Should-pass (any failure → concerns)

- [ ] No new outbound HTTP call lacks a timeout
- [ ] Logged errors include enough context to identify the user/request
```

Each item names a concrete file pattern or behavior the reviewer can verify.

## Bad examples (and why)

```
- [ ] Code is secure
```
Bad: not gradable. Pick a behavior, not a vibe.

```
- [ ] No bugs
```
Bad: nobody can grade "no bugs." Reviewers grade specific behaviors against specific evidence.

```
- [ ] Follows best practices
```
Bad: which practices? Cite a specific rule.

## Verdict format

When you post your verdict in the room, use exactly this shape:

````
<hand-name> review: <pass | concerns | block>

Findings:
- <file:line> — <what's wrong> — <suggested fix or open question>
- <file:line> — <what's wrong> — <suggested fix or open question>
````

If `pass`, the Findings section can be omitted or say `none`.

## Verdict semantics

- **pass** — every must-pass and should-pass item is satisfied. No notes.
- **concerns** — at least one should-pass failed. Implementer should know but not blocked.
- **block** — at least one must-pass failed. Implementer cannot ship without addressing or explicit user approval.

If you find yourself wanting to add a fourth tier ("blocking-but-soft"), don't. Pick concerns or block.
