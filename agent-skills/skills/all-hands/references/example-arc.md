# Example Arc — Adding OAuth Token Refresh

A worked example of a complete all-hands run. Names and timestamps illustrative.

## Goal

Add OAuth refresh-token rotation to the portal API. Tokens currently expire after 1 hour with no refresh path; we need silent refresh.

## Roster (picked by implementer, approved by user)

- **security-scanner** — token storage and rotation are the highest-risk surface
- **tester** — silent refresh is exactly the kind of thing that breaks unobserved
- **skeptic** — race conditions in refresh logic are notorious
- **rubberduck** — naming the new state machine clearly will save us a year of debugging

(4 hands. No `perf` because this isn't on a hot path. No `docs` because it's an internal API.)

## Phase 1 — Briefing (~25 min wall clock)

Each hand writes its `hands/<name>/` wiki in parallel. Excerpts:

**`hands/security-scanner/standing-watch.md`:**
```
1. **Token storage change** — wake on: any commit touching `auth/token-store.ts` or adding env vars matching `*_TOKEN_*`
2. **New auth path** — wake on: any commit adding/modifying middleware in `auth/middleware/`
```

**`hands/security-scanner/review-checklist.md`:**
```
Must-pass:
- [ ] Refresh tokens are stored encrypted at rest, not in plaintext
- [ ] Refresh request requires the refresh token AND a valid client signature
- [ ] On refresh failure, the old refresh token is invalidated server-side

Should-pass:
- [ ] Refresh response sets a new refresh token (rotation, not reuse)
- [ ] Refresh endpoint is rate-limited
```

**`hands/skeptic/standing-watch.md`:**
```
1. **Concurrent refresh** — wake on: any commit subject containing `refresh`, `lock`, `mutex`, `single-flight`
```

After ~25 min, all four hands post `briefing-ready`. Implementer posts `briefing-closed`.

## Phase 2 — Implementation (~2 hours)

Excerpts from the room:

```
[implementer] committed: auth/token-store.ts, auth/refresh.ts — add refresh endpoint skeleton
[security-scanner] @implementer: token-store.ts:42 stores refresh tokens with no encryption. The DB column is plaintext. Was that intentional?
[implementer] @security-scanner: not intentional. Adding application-level encryption with the existing KMS key. Will commit.
[implementer] committed: auth/token-store.ts — encrypt refresh tokens at rest with KMS
[security-scanner] @implementer: confirmed, token-store.ts:50 now uses kms.encrypt. Acceptable.
[implementer] committed: auth/refresh.ts — handle concurrent refresh with single-flight cache
[skeptic] @implementer: single-flight key is the user_id. Two devices refreshing for the same user concurrently will share a result. Is that the contract you want?
[implementer] @skeptic: good catch. Switching key to (user_id, refresh_token_id) so each device flow is independent.
[implementer] committed: auth/refresh.ts — single-flight scoped per refresh-token-id
[implementer] ready-for-review
```

## Phase 3 — Review (~30 min)

Each hand posts a verdict:

```
[security-scanner] review: pass
Findings: none

[tester] review: concerns
Findings:
- auth/refresh.ts:90 — concurrent-refresh test only covers two callers; should also test cancellation under load
- auth/token-store.ts:42 — KMS encrypt failures are not tested

[skeptic] review: concerns
Findings:
- auth/refresh.ts:120 — what happens if KMS is down? The current code surfaces a 500 to the user, which means everyone gets logged out during a KMS outage. Is that the contract?

[rubberduck] review: pass
Findings: none
```

No `block` verdicts. Implementer addresses tester's coverage concern (adds two tests, commits, re-pings tester who confirms `pass`). Defers skeptic's KMS-outage concern as a follow-up ticket — writes the rationale into `decisions.md`. Posts `all-hands-complete`.

## Durable artifacts

- `entrypoint.md` — router
- `hands/security-scanner/`, `hands/tester/`, `hands/skeptic/`, `hands/rubberduck/`
- `decisions.md` — three findings addressed with commit refs, one deferred with reasoning
- `room-transcript.md` — full NATS message log

Hands tear down. The implementer ships.

## What this example illustrates

- Hands lurked: `tester` and `rubberduck` said almost nothing in Phase 2 — that's correct.
- Standing watch worked: `security-scanner` woke twice on actual relevant commits, not noise.
- Skeptic's catch about single-flight scope was the kind of thing the implementer would have shipped without an all-hands.
- Disagreement was visible: skeptic and tester both flagged concerns in review; their public posts let the implementer triage in one shot.
