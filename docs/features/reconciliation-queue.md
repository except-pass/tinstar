# Reconciliation desk queue (S4)

`GET /api/reconciliation/queue` returns `{ok:true,data:{generatedAt,scope,readOnly,coverage,warnings,items,counts,needsWill,operationalExceptions,pullCoverage,reviews,reviewRecoveries,reviewExceptions,refreshing}}` through the [reconciliation source configuration](reconciliation-floor.md#run-and-configure). The [review contract](workflow.md#deployed-feature-review) and [deployment handoff contract](floor-deploy.md#tin-star-review-handoff) own the review fields and their reconciliation rules. It shares the existing source caches, local/tailnet origin policy, GET/OPTIONS restriction and `Cache-Control: no-store`. There are no new approval, dismissal, merge, reorder or presentation-defer endpoints. A read or moving to another item cannot choose a source answer. Bounded refresh can reconcile an already-recorded explicit answer through the [shared workflow](workflow.md#first-mate-decision-reconciliation); operational queue reads therefore report `readOnly: false`. The pure source projection remains read-only.

Each item has a semantic `id`, `title`, nullable concrete `action`, `kind` (`decision`, `blocked`, `merge`), `readiness`, explanatory `reasons`, canonical `cardIds`, `executionIds`, `homeIds`, `decisionKeys`, evidence URLs, checkpoint and per-source observation/expiry/coverage metadata. Every request source retains its own `request` tuple (`home`, `taskId`, `id`, `kind`). First Mate kinds are `hold` and `decision`; Notion uses `notion-card`, its exact card ID, and null home/task. Each request source has its own `readiness`, `action`, and `reasons`. A First Mate source may carry a `responseAnchor` for that exact tuple; aggregate ID arrays and the queue item ID are never response targets. GitHub observations and the Notion feed observation used to verify request context are supporting evidence rather than request identities. Their expiry still suspends actionable presentation. `oneTouch` is true only for a concrete ready-now request; it is presentation data, not permission or a domain action. Counts are scoped to returned deduplicated decisions, not all work or the whole farm. `emptyQueueMeansAllClear` is always false; read `coverage`, including failed homes and last-known sources.

Decisions shows the existing canonical requests, with verification and conditional states kept visible. See [Decisions navigation](#decisions-tab) for the visible-list controls and their distinction from MCP navigation. Discuss contains conversations only; raw holds and queue candidates never enter its tabs. The [Ask reference](ask.md) owns the inbox layout. A worker's keyed question alone does not establish Will as next actor: an owner-actionable hold whose ID exactly equals the decision key is required. If multiple tasks share that key, the hold must explicitly name the matching origin task. Task IDs, legacy aliases, matching text and card ownership never supply this routing.

Each First Mate source shows its own sanitized question beside its Answer/Dismiss controls. Controls appear only while both the item and that source are ready and current. Each source retains its existing worker terminal link. The link is emitted only when the existing resolver returns that exact full home/task identity. Unavailable or ambiguous targets offer no terminal link. Notion sources open their own card and never acquire First Mate response controls.

Answer uses the existing `/api/fleet/messages` inbox/receipt path, with a source anchor resolved against the current explicit request inventory. Dismiss uses the existing `/api/fleet/dismiss` route, resolving either one worker decision key or one captain hold. Neither uses the legacy attention title/key fallback. A failed fleet read removes response routes while retaining last-known display data. Outbox records retain the exact source anchor, and both initial submission and retry include it in the First Mate inbox note, preserving home, task, request ID and source kind even when a decision and hold share an ID and summary. Receipts track that request rather than another request sharing a key; pending/saved responses remain visible on returning to the source. Reading and Next never choose a response; delivery of recorded answers follows the [decision reconciliation contract](workflow.md#first-mate-decision-reconciliation).

Expand **Evidence and delivery details** in the decision detail to inspect the retained response receipt. Failed saves and confirmed wake failures offer **Retry delivery** with the existing request ID; a successfully delivered response awaiting an answer does not.

Items are ordered by readiness, then checkpoint, then stable ID. A checkpoint affects ordering only; overdue is not proof of an actionable decision and an upcoming checkpoint does not hide a ready one.

| Readiness | Required interpretation |
| --- | --- |
| `ready-now` | A current published Will next action or explicitly owner-routed First Mate decision/captain-actionable hold, with no observed dependency, stale/conflicting context or unresolved readiness check. A merge also needs one exact PR link and fresh open, nondraft, mergeable, passing-check evidence for its head. |
| `needs-readiness-verification` | A candidate whose concrete owner action, context, linking, PR state or prerequisites cannot be established. Tags, a title mentioning Will, an open PR, unknown checks and an unclassified block/hold do not prove readiness. A title mention alone does not even create a candidate. |
| `future-or-conditional` | Planned/backlog/queued work, a future Start Date/hold, Waiting For/dependency, explicit conditional action text, or a draft/blocked/failing/pending-check PR. Retain the card, named wait, checkpoint and evidence in context; do not put it among immediate decisions. |

Completed/answered/resolved/archived Notion candidates and completed source calls/holds are excluded. A completed or archived linked Notion card does not suppress an open First Mate request; source-bound answers follow the [decision reconciliation contract](workflow.md#first-mate-decision-reconciliation). Resolving a PR suppresses only its merge ask; other outstanding asks on the card survive. The [workflow view contract](workflow.md#slice-3-shared-operational-views-and-normal-use) owns current-ask history, scope-aware open-inventory coverage, authorization placeholders and accepted cleanup limitations. There is no separate persistent answered list: First Mate's current open keys/holds and Notion's current properties and decision history are authoritative. Stale closed/merged evidence cannot establish a new completion; retained candidates are labeled for verification. Partial or failed reads never imply all-clear.

Deduplication uses connected explicit identities only: exact scoped request identity, a decision's unambiguously matched hold ID, exact Notion card ID, or a canonical PR URL published by the request itself (Notion Link/Evidence, a hold's PR field, or a URL in the question). Transitive matches preserve every source once. Bare decision keys on different tasks/homes, normalized actions, identical wording, and task-level PR/card membership do not merge items. Task-level links remain context/evidence. Item IDs prefer a canonical PR identity when present and otherwise use the first sorted explicit identity; action text does not affect them. The UI retains a selected item across source-membership changes only when exactly one current item shares a retained explicit identity. Ambiguous or removed selections stay unavailable rather than switching to another request. A tag-only Notion candidate may be corroborated by an explicit current First Mate request, but its source-local readiness is retained; it cannot promote another source into an answerable request. Published dependencies and stale/conflicting context still prevent the item entering default ready navigation.

## Progressive display and refresh

The HTTP queue returns known source rows promptly while the shared operational
queue refreshes in the background. `refreshing: true` means enrichment is still
pending, not that the returned list is complete. Previously enriched requests and
proposals remain visible during refresh or failure; choices are disabled with
`oneTouch: false` and `proposalHistoryComplete: false`. Conditional requests retain
their category; other retained requests require readiness verification. Warnings
distinguish pending evidence from a failed refresh. `refreshing: false` alone does
not establish healthy coverage. Owner-authorized PR evidence and anonymous display
results use separate caches. Selection still uses fresh request-scoped validation.

The display cache lasts 20 seconds after completion; concurrent reads share its
pending refresh. `?refresh=1` invalidates that display cache, scheduling a subsequent
refresh if one is already pending. It does not bypass underlying source caches.
The UI polls one second after a response with `refreshing: true`, otherwise 20
seconds after each read, with a 60-second request deadline. A confirmed or partial
local workflow save triggers an immediate `?refresh=1` read and supersedes any
pending UI read; superseded responses cannot replace the current result. Read
failure retains labeled last-known candidates and downgrades displayed readiness.

A selected request absent from partial results remains selected and shows
**Refreshing request**, rather than falling back to another request on the same
card. Its conversation remains available in Discuss. Explicitly changing shared
card selection can replace the pending selection. MCP queue reads and action validation
continue to use the operational queue rather than this progressive HTTP display.

## Source limits and prerequisites

The queue retains only the snapshot's published open-decision keys/summaries, hold kind/completion and task-origin ID. It does not return raw backlog bodies, briefs, pane transcripts or operator command suggestions. Existing worker/message/terminal controls and receipt delivery remain unchanged; Decisions binds to them per source.

Notion's existing property reader additionally retains optional `Next action` / `Next Action` and `Evidence` properties **if already present**. It creates no properties or planning hierarchy. In the observed board these properties are absent: actions/evidence written only in page bodies remain uncollected by S4. Owner/Will-action/Waiting-For candidates therefore need verification unless corroborated by a current explicit First Mate request. That is an observed interface gap, not permission to infer readiness from a Merge tag. The response always discloses `cardBodies: not-collected`; on-demand card prose is available separately through [S5 card context](reconciliation-mcp.md#tools-and-authority) and does not feed queue readiness. PM Bot/human-owned card context cannot establish a ready First Mate request automatically.

PR inventory and readiness use the [existing owner authorization boundary](workflow.md#slice-3-shared-operational-views-and-normal-use); other callers retain card asks with authorization placeholders. PR checks use an optional authenticated `gh-axi` CLI on the backend host (`gh-axi api GET` only). Missing CLI, credentials or repository permissions produce unknown PR readiness without preventing the queue from loading. No public endpoint or new credential is created. Reads are demand-driven with a 60-second cache (including failures), concurrent coalescing, a maximum of four PR refreshes / 12 GET requests per queue read, four concurrent PR refreshes, 5-second command deadlines, 64 KiB projected responses and a 64-entry memory cache. Check runs are bounded to 100; truncation and zero observed checks remain unknown. Checks/statuses are read against the observed PR head; a conflicting published execution head requires verification. Fresh merged/closed responses need only one GET. There are no retries or background pollers; unqueried candidates explicitly lack verification. Published source waits and one-touch prerequisites still apply even when a PR is green. Passing CI/mergeability is not proof of delivered behavior.

Eligible PR refreshes rotate across the current candidate list using one cursor, so a stable list larger than the cache still receives reads across successive requests. Cache eviction does not reset the rotation; concurrent reads share pending requests. Candidates without a cached or pending read remain unverified.

## Run and verify on Hulk

Use the existing server setup and operator-provided Notion read token, then:

```sh
curl -s http://127.0.0.1:5281/api/reconciliation/queue
npx vitest run src/server/reconciliation/queue.test.ts src/server/reconciliation/__tests__ src/server/fleet/attention.test.ts --exclude='e2e/**'
npm run typecheck
npm run build:all
```

The controlled tests cover source deduplication, independent decisions, real source keys, resolved/answered/completed filtering, idempotent repeated reads, future/conditional/multistep actions, release dependencies, missing/unknown/stale sources, PR closure/draft/check failures/truncation/head conflicts, read bounds/cache/coalescing, and the origin/method/envelope boundary. Test data is explicit fixture data; it creates no production incidents.

The live discovery proof is saved outside the repository at `/home/farm/fm-home/data/tinstar-recon-s4/live-proof.json`, with its rerunnable `live-proof.ts`. It reads this Hulk home through the documented snapshot interface and authenticates Notion GET/schema plus POST/query via the authorized discovery helper, which keeps its credential. It records the exact tested git head, source coverage, current queue and relevant real card/task observations. Production Notion credentials, other homes' publication routes, floor UI and conversational MCP are separate integration prerequisites/slices; this server/API proof does not claim their delivery.

## Decisions tab

`?view=decisions` lists the shared `needsWill` projection across all three
readiness categories, including future/conditional requests. Operational coordination
bundles appear only under diagnostics rather than as one answerable decision. See the
[workflow view contract](workflow.md#slice-3-shared-operational-views-and-normal-use)
for ask inclusion, PR evidence, request age and advisory execution warnings.
Legacy encoded text is decoded before readiness checks, so “After the next prod
release” remains conditional. Source warnings and retained worker notes remain
available on demand near the footer.
Search by title, question, card ID or readiness. Selecting a compact row opens
its action workbench beside the queue on desktop; mobile shows the queue or detail
one pane at a time, with **All decisions** returning to the list. The persistent
**Previous** and **Next decision** footer traverses the visible filtered list,
including verification and conditional requests, and shows the current position.
This differs from the ready-only MCP queue navigation.

The detail shows one recommended action, its rationale and up to two alternatives;
**More options** appears only for additional published actions. The
[typed proposal contract](workflow.md#decisions-workbench-proposals) owns publication,
currentness and selection checks. Stale or unknown evidence keeps the last-known
recommendation visible with disabled choices. With no typed proposal, it shows
**Recommendation not yet published** and **Ask for a recommendation**, which seeds
an editable Ask turn. Legacy published workflow options retain their existing
controls; freeform prose never becomes executable suggestions.

**Something wrong?** opens **Already resolved**, **Not my decision** and **Need
more information**. Each seeds a verification question for the exact request;
it does not dismiss the request or mutate source status.

**Discussion** previews the latest relevant First Mate answer and embeds the
existing Ask text/voice composer. Context and return navigation retain the exact
request key even without a linked card. **Full conversation** opens the same
persistent Discuss thread. **Return to source** restores Decisions and its search,
closing the mobile Discuss sheet. An expanded visible Discuss conversation replaces
the inline composer so only one complete composer is shown. Switching selected
requests collapses an unrelated expanded conversation; a conversation opened in
Discuss afterwards stays open.

Small source links and owner/status remain visible. **Evidence and delivery
details** holds source-specific response controls, terminal links, card context,
receipts and technical data. Selecting an action retains the request until actual
source reconciliation; delivery and observed outcomes follow the
[Ask selection contract](ask.md#discuss-and-decisions-presentation).
Opening a row retains its canonical request identity and shares linked-card focus,
visible through `get_scene`; persistence follows the [presentation preference rules](overview.md).
Unlinked requests expose their details and evidence without offering card focus.

The [MCP delivery contract](reconciliation-mcp.md#delivery-and-acknowledgment)
governs tab selection, surface handoff and visual acknowledgment.
Within Decisions, flash temporarily reveals all requested queue rows outside
the local search without changing its text, then restores the list scroll
unless the user interacts. Assistant reveal includes both its primary target
and additional targets, including during foreground replay. Editing the local
query dismisses the transient reveal. Steady selection and a brief flash use
distinct styles; failed source reads report unavailable coverage.
