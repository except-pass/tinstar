# Reconciliation desk queue (S4)

`GET /api/reconciliation/queue` returns `{ok:true,data:{generatedAt,scope,readOnly,coverage,warnings,items,counts}}` through the [reconciliation source configuration](reconciliation-floor.md#run-and-configure). It shares the existing source caches, local/tailnet origin policy, GET/OPTIONS restriction and `Cache-Control: no-store`. There are no mutation, approval, dismissal, merge, reorder or presentation-defer endpoints. A read or moving to another item cannot answer the source decision.

Each item has a semantic `id`, `title`, nullable concrete `action`, `kind` (`decision`, `blocked`, `merge`), `readiness`, explanatory `reasons`, canonical `cardIds`, `executionIds`, `homeIds`, `decisionKeys`, evidence URLs, checkpoint and per-source observation/expiry/coverage metadata. `oneTouch` is true only for a concrete ready-now request; it is presentation data, not permission or a domain action. Counts are scoped to returned deduplicated decisions, not all work or the whole farm. `emptyQueueMeansAllClear` is always false; read `coverage`, including failed homes and last-known sources.

Items are ordered by readiness, then checkpoint, then stable ID. A checkpoint affects ordering only; overdue is not proof of an actionable decision and an upcoming checkpoint does not hide a ready one.

| Readiness | Required interpretation |
| --- | --- |
| `ready-now` | A current published Will next action or explicit First Mate keyed owner decision/captain-actionable hold, with no observed dependency, stale/conflicting context or unresolved readiness check. A merge also needs one exact PR link and fresh open, nondraft, mergeable, passing-check evidence for its head. |
| `needs-readiness-verification` | A candidate whose concrete owner action, context, linking, PR state or prerequisites cannot be established. Tags, a title mentioning Will, an open PR, unknown checks and an unclassified block/hold do not prove readiness. A title mention alone does not even create a candidate. |
| `future-or-conditional` | Planned/backlog/queued work, a future Start Date/hold, Waiting For/dependency, explicit conditional action text, or a draft/blocked/failing/pending-check PR. Retain the card, named wait, checkpoint and evidence in context; do not put it among immediate decisions. |

Completed/answered/resolved/archived cards and calls, completed source holds, and freshly closed/merged merge requests are excluded. There is no persistent answered list: First Mate's current open keys/holds and Notion's current properties are authoritative. Stale closed/merged evidence cannot establish a new completion; retained candidates are labeled for verification. Partial or failed reads never imply all-clear.

Deduplication reuses the cockpit's exact decision-key/captain-hold matching. Across sources it uses explicit card identity plus the same normalized action, or the exact canonical PR URL for a merge decision. Distinct non-merge decisions on one card/PR remain separate. A tag-only candidate can be corroborated by an explicit current First Mate request; published dependencies or conflicting/stale context still prevent ready-now. Titles and textual card references cannot establish confirmed relationships. Source metadata and all contributing IDs/evidence remain available on the combined item.

## Source limits and prerequisites

The queue retains only the snapshot's published open-decision keys/summaries, hold kind/completion and task-origin ID. It does not return raw backlog bodies, briefs, pane transcripts or operator command suggestions. Existing worker/message/terminal controls are unchanged.

Notion's existing property reader additionally retains optional `Next action` / `Next Action` and `Evidence` properties **if already present**. It creates no properties or planning hierarchy. In the observed board these properties are absent: actions/evidence written only in page bodies remain uncollected by S4. Owner/Will-action/Waiting-For candidates therefore need verification unless corroborated by a current explicit First Mate request. That is an observed interface gap, not permission to infer readiness from a Merge tag. The response always discloses `cardBodies: not-collected`; full card context remains a later integration requirement. PM Bot/human-owned card context cannot establish a ready First Mate request automatically.

PR checks use an optional authenticated `gh-axi` CLI on the backend host (`gh-axi api GET` only). Missing CLI, credentials or repository permissions produce unknown PR readiness without preventing the queue from loading. No public endpoint or new credential is created. Reads are demand-driven with a 60-second cache (including failures), concurrent coalescing, a maximum of four PR refreshes / 12 GET requests per queue read, four concurrent PR refreshes, 5-second command deadlines, 64 KiB projected responses and a 64-entry memory cache. Check runs are bounded to 100; truncation and zero observed checks remain unknown. Checks/statuses are read against the observed PR head; a conflicting published execution head requires verification. Fresh merged/closed responses need only one GET. There are no retries or background pollers; unqueried candidates explicitly lack verification. Published source waits and one-touch prerequisites still apply even when a PR is green. Passing CI/mergeability is not proof of delivered behavior.

Eligible PR refreshes rotate across the current candidate list using one cursor, so a stable list larger than the cache still receives reads across successive requests. Cache eviction does not reset the rotation; concurrent reads share pending requests. Candidates without a cached or pending read remain unverified.

## Run and verify on Hulk

Use the existing server setup and operator-provided Notion read token, then:

```sh
curl -s http://127.0.0.1:5281/api/reconciliation/queue
npx vitest run src/server/reconciliation/queue.test.ts src/server/reconciliation/__tests__ src/server/fleet/attention.test.ts --exclude='e2e/**'
npm run typecheck
npm run build:all
```

The controlled tests cover source deduplication, independent decisions, real source keys, resolved/answered/completed filtering, no-op repeated reads, future/conditional/multistep actions, release dependencies, missing/unknown/stale sources, PR closure/draft/check failures/truncation/head conflicts, read bounds/cache/coalescing, and the read-only origin/method/envelope boundary. Test data is explicit fixture data; it creates no production incidents.

The live discovery proof is saved outside the repository at `/home/farm/fm-home/data/tinstar-recon-s4/live-proof.json`, with its rerunnable `live-proof.ts`. It reads this Hulk home through the documented snapshot interface and authenticates Notion GET/schema plus POST/query via the authorized discovery helper, which keeps its credential. It records the exact tested git head, source coverage, current queue and relevant real card/task observations. Production Notion credentials, other homes' publication routes, floor UI and conversational MCP are separate integration prerequisites/slices; this server/API proof does not claim their delivery.
