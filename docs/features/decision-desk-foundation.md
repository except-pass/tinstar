# Decision Desk foundation and review UI

P1 is the preparation-storage slice of the Decision Desk sequence. It advances the
backend portions of acceptance criteria **1 and 2**, and foundations for **3, 8,
12 and 14** on [the Decision Desk card](https://www.notion.so/41950ce6d42281068ca9dc6d065fc210).
P2 adds [registered review sessions and prepared claims](#p2-registered-review-sessions-and-prepared-claims).
P3 adds [durable source-bound submit and recovery](#p3-durable-source-bound-submit-and-recovery).
P4 adds [preparation jobs](#p4--preparation-jobs). P5 is the two-view UI below. P6 is later integrated acceptance.
Generic claims, source answers, receipts and `search_work` filters/coverage
retain their behavior. P5 adds a Decisions mode as described below.

P1 stores packets and policy. [P4](#p4--preparation-jobs) dispatches preparation.
Automatic replenishment is stored OFF until the owner turns it on from Preparation.
Ready depth 10 (1–30) and maximum preparers 3 (1–8) stay the other defaults.
These are persisted owner policy values. The visible replenishment control is the
only on/off switch. P4 does not track tokens or spend.

## Storage and readiness

`DecisionPackets` uses the **existing `CardLeases` database**,
`card-leases.sqlite`, through its internal read/transaction helpers. P2 uses this shared boundary for atomic
READY selection and canonical card reservation, as described below. No provider
I/O belongs inside packet transactions.

- `decision_packets` stores immutable packet bodies, schema, semantic hash,
  source-scoped version, publication operation identity, preparer and timestamps.
  Identical publication retries return the original packet; different meaning
  with the same actor/operation is a conflict. A deliberate new publication
  increments the version. Older bodies remain readable and superseded versions
  cannot become Ready.
- `decision_packet_dependencies` indexes exact dependency kind/key/revision.
  Kinds are request, card, answer, PR head, worker, release and evidence. Changes
  invalidate only dependent packets. No whole-snapshot digest or timestamp-only
  invalidation is used. Source closure/conflicting answer can withdraw a
  dependency without asserting a replacement revision.
- `decision_packet_events` and `decision_packet_validations` are append-only
  service records for publication, validation/freshness/coverage, invalidation
  causes and policy changes. They are operational records, never a source answer.
  Known dependency changes prevent an older cached revalidation from restoring
  readiness. A withdrawn/expired dependency needs a later observation before
  unchanged-source revalidation can restore eligibility.
- `decision_desk_policy` persists versioned effective settings per configured
  board. Authorized owners share that board's policy. Failed/stale saves are
  explicit and preserve the stored version.

The packet schema contains one **existing** exact source request, its canonical
card, source paragraph/comment ID, source tuple, question/generation/revision,
source-supported option IDs/labels, recommendation, background/rationale,
confidence/uncertainty/material unknowns, risk/likelihood/blast radius, reversibility/rollback/residual
exposure, consequences/affected parties/prerequisites, authorization/next owner
and status/gates, references, dependencies and the legacy review freshness hint. P1 does
not normalize sources, invent alternatives or add a multipart grouping schema.
Risk/confidence prose is preparer advice, not an independent verification or
authorization. See [P4 publication](#p4--preparation-jobs) for the bot's
job-scoped path into this store.

Semantic hashing normalizes object keys, set-like option/reference/dependency
ordering and line endings. Publication/observation timestamps are outside the
hashed packet meaning. A changed request, option, risk, recommendation or bound
dependency revision changes meaning. Evidence attestations can be appended to
the same immutable packet when source meaning is unchanged.

`validateDecisionPacket` is pure. It requires exact source/card/option/question
membership, complete fresh unexpired material evidence, and an unanswered source.
Declared material unknowns also block eligibility; ordinary advisory uncertainty
remains visible. Missing, partial, stale, ambiguous or mismatched evidence supplies reasons rather
than permission. `DecisionPackets.read(id, evidence)` additionally requires a
successful unexpired persisted validation, the latest packet version and **no active canonical review lease or source-write reservation**.
[P3 submission and recovery](#p3-durable-source-bound-submit-and-recovery) defines
additional answer/research exclusions. It evaluates leases and evidence expiry at read time; there is no permanent Ready flag. Reading without current
source evidence never asserts readiness. No counts of pending preparations or
leases are presented as Ready.

## Read-only preparer evidence

`ReconciliationSources.preparationEvidence(cardId)` projects already-observed
board/fleet metadata and cached card-body and comment history. It does **not**
refresh sources, call the mutating queue refresh, reconcile receipts, answer,
repair source links, or take a lease. On a cold cache it honestly reports missing
coverage. The Desk snapshot and automatic admission enqueue missing/expired
history and immediately project known evidence. A shared background queue reads
at most two cards at once through the existing paced Notion client, including
its shared Retry-After backoff. History HTTP responses release the pacing slot
once started, so a slow history response cannot monopolize property reads.
Each completed read, when automatic replenishment is enabled, schedules a coalesced
replenishment pass, so an eligible decision can be admitted before its history
expires. Prepare now waits only for the selected card, prioritizing it ahead of
queued background reads and reusing an in-flight read. Snapshots expose per-card
history loading/available/unavailable states; while the page is visible, the Desk
refreshes its snapshot every two seconds, including through history retry
deadlines and pending configuration lookup with automatic replenishment off.
History deadlines and coverage are defined in [loading history](#publishing-a-source-request-and-loading-history);
failures include a reason and retry time, with backoff from 30 seconds to five
minutes. Prepare now can explicitly retry one failed card. Secret lookup also refreshes in the background
for snapshots. Generic MCP claim reads and admission follow the
[session-scoped card lease contract](reconciliation-mcp.md#session-scoped-card-leases).
Expired history leaves coverage unknown. These reads retain
the 30-second evidence horizon, including cached failures.
Other source readers can also populate caches;
looking at this projection never renews their timestamps. Both history caches
must be resolved, complete and unexpired for readiness; the earlier cache expiry
bounds their combined freshness. Missing, partial or expired history blocks
readiness rather than establishing that a request is unanswered. Legacy paragraph
answers and conflicting body publications remain part of that history. Complete,
fresh history with no decision request reports that absence as a source failure.

The dependency map checks request meaning, card closure/authorization context,
answer history, and worker attempt/state. Linked PRs appear as unverified PR-head
dependencies until an authorized reader provides current evidence. PR/release
proof collection is an explicit omission, not assumed verification.
Cross-channel Ask publication coverage is also not supplied by this cache-only
projection: a typed proposal that needs that coverage is blocked with an explicit
reason. Cached workflow history still rejects superseded/conflicting formal
publications. Later evidence collection must supply complete publication coverage
before such a packet can become Ready; P1 does not weaken existing selection rules.
The schema/index also supports release/other evidence dependencies for future
preparers, without claiming those observations have already been collected.

This is bounded observation of upstream systems, not a distributed lock over
Notion/First Mate/GitHub. Submit-time source verification is described in
[P3 submission and recovery](#p3-durable-source-bound-submit-and-recovery). A recommendation never permits production/device writes.

## Owner-authenticated API

Routes use the existing trusted loopback Tailscale owner authorization check,
origin allowlist and `X-Tinstar-UI: 1` handshake. A caller-supplied owner name alone
is not authorization outside that existing loopback/proxy trust boundary. No
install or bridge token is returned by these routes. Review capabilities are
returned only by the [review operations below](#p2-registered-review-sessions-and-prepared-claims).

| Method and path under `/api/reconciliation/decision-desk` | Result |
|---|---|
| `GET /policy` | Persisted/default effective board policy and version |
| `PUT /policy` | Save `{expected_version, values:{target_ready,max_preparers,automatic_replenishment}}`; 409 on version conflict, 400 on invalid values, 503 on unconfirmed storage |
| `GET /evidence?card_id=...` | Pure cached source projection with exact bindings, dependencies, reasons and omissions |
| `GET /packets` | Bounded publication inventory (at most 50), explicitly **not** a Ready counter |
| `GET /packet?id=...` | Immutable body/metadata plus current evidence and lease/expiry eligibility |
| `GET /events?after=0` | At most 50 durable instrumentation events in sequence order |
| `POST /prepare` | Audited preparation of one decision `{card_id, request_id, reason}`; see [P4 admission](#p4--preparation-jobs) |

The packet publish path is MCP `publish_prepared_packet`, not this owner UI.
Review and source-write recovery routes are described below; answer submission is owned by the
[P3 API contract](#p3-durable-source-bound-submit-and-recovery). Unsupported methods return 405.
Public source-derived prose is redacted independently of exact internal validation
data; review capabilities and source answer identities remain intact. Existing `coverage.intentions` and
`search_work` scope fields are unchanged.

## Isolated proof and baseline screenshots

Build the client and run the explicit fixture-backed preview:

```sh
npx vite build --outDir dist/client
node --import tsx scripts/decision-desk-preview.ts /absolute/task-proof-dir
```

The script creates a fresh private config root beneath that directory and binds
an ephemeral loopback port. It enrolls no First Mate home, live credential,
provider source transport or job dispatcher. `preview.json` identifies the
instance and five synthetic source packets. API requests use the fixture owner
`preview-owner@example.test` and the UI handshake. Its SQLite/API code and current
client bundle are real; its business evidence is explicitly controlled test data.
Stop that script process after proof. Never aim this harness at a live config root.

Open the returned URL with `?view=decisions` in
`CHROME_DEVTOOLS_AXI_SESSION=tinstar-decision-desk-design`. Capture 390×844,
768×1024 and 1440×900, label them **P2 baseline — unchanged Decisions UI,
isolated fixtures**, and stop that AXI browser session afterward. P2 changes no
screen. These images are the baseline for P5, not a claim of prototype fidelity
or final Decision Desk acceptance.

The generic-lock contention measurement is reproducible without source access:

```sh
node --import tsx scripts/decision-desk-contention.ts /absolute/task-proof-dir
```

It records HEAD and raw samples: six rounds at each simulated source-write delay
(25ms and 1000ms), one writer plus five independent `CardLeases` instances,
30 claim samples and six write samples per scenario. It measures lock contention,
not HTTP/render latency or the future prepared path. Output is
`contention.json`; report actual p50/p95, sample counts and this scope in the
implementation review description. It measures the current per-card reservation implementation described below.

Focused tests cover semantic hashing, source/card/options changes, partial/stale
evidence, immutable retry/versioning, dependency invalidation/revalidation,
expiry/held-card exclusion, restart persistence, concurrent policy-save conflicts,
real owner-authenticated API calls and no source access/reconciliation from the
evidence path. Run existing lease/proposal/workflow regressions as well.

## P2: registered review sessions and prepared claims

P2 advances backend acceptance criteria **4 and 5**, the **claim side of 8**,
and parts of **1, 13 and 14**. Submission coordination is covered by
[P3 below](#p3-durable-source-bound-submit-and-recovery); preparation workers,
multipart normalization and desk screens remain later slices.
The existing Decisions screen, generic claims, source answers, receipt bridge,
`search_work` owner/status filters and `coverage.intentions` stay compatible.

A review session is a durable server-created resource, separate from browser
presentation scenes. Owner-authenticated web clients explicitly POST
`/api/reconciliation/decision-desk/sessions` with `operation_id`, a `label` and
`device` (`phone`, `desktop`, or `other`). Creation returns a public session
summary and an opaque `review_session_token`. Only its hash is stored. A
same-input operation retry reconstructs the same capability; changed input
conflicts. The resource expires after 24 hours, independently of the existing
60-minute renewable canonical card lease. Explicitly create a new context after
session expiry. GET on that path lists only the authenticated caller's actual,
nonrevoked, unexpired resources and nonsecret held-card metadata. Public IDs and
listing authorization never grant lease ownership.

The browser must retain the capability in its review context's memory or
session storage and send it in JSON bodies, never URLs, UI text, or DOM metadata.
A duplicated tab that copies session storage resumes the same registered context;
creating another independent context requires another explicit session-creation
operation. P5 will wire these resources into the screen; P2 creates no implicit
scene/tab/actor/last-seen identity and no cross-conversation navigation.

POST `/api/reconciliation/decision-desk/claim` requires `operation_id` and the
browser's `review_session_token`, with optional `card_id` for an exact claim.
The matching MCP facade tools are:

- `open_prepared_review_session` and `list_prepared_review_sessions`;
- `claim_next_prepared_decision` and `claim_prepared_decision`;
- `release_prepared_decision` for release/skip; the [P3 contract](#p3-durable-source-bound-submit-and-recovery)
  also defines research withdrawal and the optional reason.

MCP callers may explicitly open a context, or begin a claim without a capability
and continue using its returned `lease_token`. The same token resumes the same
held packet. There is no way to recognize an earlier conversation when a new
request omits **both** continuity capabilities. It starts an independent context;
only reuse of the same globally unique operation ID deliberately replays an
identical operation. Credential rotation does not inherit old capabilities.
Tokens belong only in tool arguments. No context token is returned by listing.

Claim evaluates the current cache-only source projection, latest immutable packet
version, durable invalidations, freshness, exact request/options and canonical
lease/reservation in **one short lease-database transaction**. The projection
never refreshes upstream, researches, reconciles receipts, writes a source, or
launches a worker. Missing or expired evidence blocks claim. This uses P1's bounded
observations, not a claim of instantaneous upstream change detection. Current
source order comes from the existing pure queue comparator. Multiple packets for
a card still share one canonical card fence. A repeated context claim returns its
held version; an invalidated held packet is returned blocked. A different exact
card request reports the existing hold rather than allocating another one.

A claim carries packet ID/version and lease generation in its durable binding.
Generic and prepared claims use the same canonical lease table and therefore
exclude each other. `no-decision-requests` means verified absence in the covered
scope; source/property coverage alone cannot prove that body/comment requests
are absent. `no-prepared-decisions`, `no-ready-packet` and `source-unavailable`
retain their different meanings. Unknown demand is not reported as zero.

POST `/release` uses the same continuity data, a new `operation_id`, `reason`,
and `action`. Release clears only the matching canonical hold. Skip performs the
release and next claim together, excluding the whole skipped card for that one
allocation; other contexts can immediately reclaim it in its original source
order. A lost-response skip retry replays the original next allocation, never a
later card. GET/read, release, skip, ordinary expiry and POST `/close-session`
(with capability and reason) do not change source owner/status or answer a request.

## Per-card source-write reservations and recovery

Previously a source HTTP write held the database-wide writer transaction,
blocking unrelated claims for its entire provider latency. P2 reserves only its
canonical card, current generation and unique write operation in a short
transaction, commits, performs provider I/O, then completes in another short
transaction. Other cards remain claimable. Existing stale-token fencing and
successful holder renewal remain in place. `lease_events` records claims,
validation failures, releases with reasons, reservation/recovery identities and
prepared-claim selection timings; capabilities and source prose never enter
these events. Owner-authenticated GET `/api/reconciliation/decision-desk/review-events?after=0` exposes the bounded audit stream; `operation_key` dedupes retry metrics. These are server-side timings, excluding HTTP/rendering, and are
not end-to-end claim-to-visible measurements.

A timeout, ambiguous response or failed readback retains the reservation across
restart and lease expiry. A new holder or operation cannot race the old write.
A definitive provider rejection or a pre-write validation failure releases it.
The original source operation can still inspect its existing recovery records.
An immutable unique note/contract marker that fully reads back can reconcile its
same-operation reservation automatically. Interrupted note writes also attempt
this readback in their final cleanup; a landed note completes its reservation
even when its response was lost. Mutable properties require the settlement
window below or owner reconciliation, because a matching value might predate an
older in-flight PATCH. Existing handoff partial
append/history recovery remains authoritative and never blindly repeats a POST.

At server startup and every minute, recovery revisits reservations at least five
minutes old, beyond the providers' 20-second request deadlines. It skips locally
running writes and uses the same complete source readback and audited
reconciliation as the owner route. `applied` and `different` clear the exact
reservation; `different` may include partial effects. Unknown or incomplete
readback retains it for the next pass. Recovery never resends a write, and an
unresolved reservation affects only its own card's claims and writes.

The authenticated owner also has an explicit supported recovery route:

1. GET `/api/reconciliation/decision-desk/source-writes` through the same owner
   authorization, `X-Tinstar-UI: 1` handshake and origin checks as the desk APIs.
2. Inspect the operation and establish that its earlier provider request has
   settled. A process crash or an elapsed timeout alone is insufficient evidence
   that a remote request stopped. Inspect full source history/markers and partial
   effects; source availability remains required.
3. POST `/api/reconciliation/decision-desk/reconcile-source-write` with
   `card_id`, the reservation's `operation` UUID,
   `earlier_request_settled: true`, and a concrete `reason` identifying that
   evidence. The server reads source markers/current desired fields itself,
   compares meaningful values, and audits actor/reason/generation/readback result
   before clearing exactly that reservation. `different` may include partial
   effects; it does not assert nothing was written. Unknown/incomplete source
   readback or a locally running callback retains the fence. Recovery sends no
   provider write. Re-read/retry the original source-bound workflow afterward.

This owner recovery is a deliberate audited supersession, not approval for
production/device effects or another answer. An unresolved write is never
released just because its age crossed a threshold. P3 submission recovery
uses the same source-bound answer markers and operation continuity.


## P3: durable source-bound submit and recovery

This is **P3 of six**, backend only. It advances criteria **8, 9**, the
**single-request part of 10**, the backend state portions of **11 and 13**, and
instrumentation for **14**. **P4–P6 follow**. It introduces no screen, runner,
research dispatch, spend, activation flag, multipart grouping/required-part
policy, or production rollout. Generic claims, `update_work`, `answer_decision`
and `search_work` keep their existing caller contracts.

Owner-authenticated POST `/api/reconciliation/decision-desk/submit` takes:

```json
{
  "operation_id": "a-unique-stable-attempt-id",
  "review_session_token": "opaque-context-capability",
  "lease_token": "opaque-held-card-capability",
  "packet_id": "published-packet-uuid",
  "packet_version": 1,
  "request_id": "exact-existing-source-request-id",
  "option_id": "exact-source-option-id",
  "next": { "owner": "Firstmate", "status": "Queued" }
}
```

The context capability is optional when the current lease identifies it. Keep
capabilities in request bodies/tool arguments only. The server derives the exact
answer label and source tuple from the held immutable packet; callers cannot
supply an alternate answer or infer subrequest IDs. `next` uses the existing
workflow vocabulary and must match the packet's bounded next owner/status.
Existing optional `resolve_wait` and `next.wait` semantics remain explicit.

The server durably retains selection/operation/context before source I/O. It
requires the matching active canonical generation before writing, forces exact
complete source-history reads and refreshes the source snapshot, compares request,
card and declared dependency meaning, then uses the existing workflow answer
writer. Source observations retain their actual freshness; this is bounded
observation, not atomic universal invalidation across providers. Material unknown
or changed PR/worker evidence blocks submit. P1's unsupported external evidence
stays unknown; P3 does not invent PR-head proof.

The desk persistence entry point returns independently of downstream worker
reconciliation. Desk property writes recheck current values inside the existing
per-card reservation so simultaneous same-ID retries do not repeat a PATCH;
intervening external property edits are preserved. This adds no writer registry. Legacy `update_work` still returns its existing pending-worker
result. Desk success requires an exact authoritative answer receipt readback,
never just an intent, delivered inbox note, property match or list of saved
fields. It returns `recorded-awaiting-worker-acknowledgment` and schedules the
existing receipt bridge asynchronously after local release/next commits, so
receipt writes cannot race that step. In one short local transaction, the
coordinator records release and binds the next Ready packet. Allocation failure
cannot roll back release of a source-confirmed answer. A crash between source
confirmation and release/next is reconciled by the same operation ID.

Results are explicit:

| Outcome | Recovery/meaning |
|---|---|
| `not-saved` | Selection and lease retained. Correct the source problem, retry the same ID; never advance. |
| `save-unconfirmed` | Same-ID receipt reconciliation only. Immutable note markers can settle automatically; ambiguous mutable properties use the existing audited source-write recovery API above. |
| `source-unavailable` | Current source coverage/history cannot verify the answer; selection/lease retained, no write. Refresh evidence before deciding. |
| `packet-invalidated` | Choice retained for reference; no write. Refresh/re-prepare and reclaim a valid packet. |
| `lease-lost` | Reclaim/revalidate before any write. An old capability never falls through to unleased access. |
| `answer-conflict` | A different source answer/intent exists. Inspect authoritative source effects; no selected answer is written. |
| `confirmation-required` | High risk/difficult rollback requires the returned selected option and explicit authorization scope, with adverse impact, reversibility and next action available for P5's modal. No write on cancellation. |
| `recorded` | Source answer confirmed; next packet held. Worker acknowledgment may remain pending. |
| `recorded-empty` | Source answer confirmed, previous lease released, and `next.outcome` explains empty/unavailable scope. Use a new claim for a later empty-buffer retry; a failed next allocation may retry the same submit ID. |
| `recorded-releasing` | Answer already confirmed; retry the same ID to finish local release/next, never submit a new answer. |

A confirmed historical submit replay never releases a newer holder. Selections
before any write can be superseded with a new operation; saving/unconfirmed
attempts require their original operation. Pending source intent is excluded
from Ready independently of packet age. No timer silently erases uncertain
source effects. Closing or idle expiry never changes Notion owner/status.

POST `/api/reconciliation/decision-desk/submission-state` with the real
`review_session_token` restores unresolved operation IDs, selections, next input,
per-operation state and recovery details only to the authenticated context.
An explicit replacement context may also supply `original_lease_token` to prove
access to an older retained selection. After reclaim, submit accepts a fresh
packet version only when its source binding/revision and authorization are
identical, preserving the source operation ID. Transfer to a different review
context also requires the capability for the latest server-bound context. Recovery
returns `binding_matches_original_lease` for each operation, identifying whether the
supplied capability matches that binding. After a lost transfer response or a
lease-lost result, reconcile the retained candidate capabilities through recovery
before another transfer; retain the exact operation and selection. A changed source
revision cannot be rescued by an old selection or operation.
MCP exposes `submit_prepared_decision` and `get_prepared_submission_state` with
these same semantics; no scene ID or invented conversation identity is used.

POST `/release` (or MCP `release_prepared_decision`) accepts `action: research`
and an optional concise `reason`. It permanently withdraws that packet for
re-preparation, audits the reason and releases/claims next in one transaction.
The next allocation excludes the current card once. Skip preserves canonical
order and does not withdraw the packet. Neither operation writes a source answer,
rejects a request, changes source owner/status, or launches research. An unresolved
answer must be reconciled before releasing it into another reviewer.

Each packet/submit still answers **one independent exact source request**. On a
card with several requests, confirmed progress is recorded by request identity,
and a later failure returns earlier confirmed progress with `card_progress:
partial`. This does not declare the card or a multipart bundle complete. Source
owners retain the existing next-state policy: if one independent answer queues
the card, a remaining ask may need source rerouting/current evidence and a new
packet before it is eligible. P3 does not invent an aggregate transition policy.

`decision_desk_confirmed_answers` dedupes confirmed source requests/revisions,
scoped to Decision Desk recording. GET `/metrics` returns `reviewed_today_utc`,
its configured-board scope and `recording_started_at`; it asserts no historical
all-work total. Packet `answer-confirmed` events record source-readback duration;
lease audit `prepared-submit-to-next` events record result, duration and readback
portion, with hashed operation identities and no lease capabilities. Retry/restart
never increments confirmed throughput twice. Worker receipt lag remains separate
from durable answer success.

For isolated API evidence at a committed head:

```bash
node --import tsx scripts/decision-desk-submit-preview.ts /absolute/task-proof-dir
```

This self-contained proof creates a fresh config root/database plus a disposable
Notion-compatible HTTP source with persistent JSON state and synthetic credentials.
It tests owner-authenticated HTTP and real MCP SDK submit, selection recovery,
five independent contexts, skip/research effects and 30 filled-buffer
submit/readback-to-next timings. It reports its head, actual samples, p50/p95,
source delay and the scope/limitations in `api-proof.json`, then closes both
servers. It uses no live root, tokens, board or bridge. These fixture measurements
are not production latency or P6 integrated acceptance. No P3 screen changed;
first-pass screenshots and mobile/desktop visual state proof belong to P5/P6.

## P4 — preparation jobs

The preparer is the Tinstar Decision Prep bot. Tin Star posts one job per eligible
decision to the bot's webhook and does not run a Codex preparer. Each JSON body
carries `request_id` (the Tin Star decision/request id), `card_url` (the Notion
card URL), and `publish.tool` / `publish.job_id` for `publish_prepared_packet`.
The sender key is sent only as `Authorization: Bearer`. It is never logged,
returned, or stored in the job row.

The webhook URL and sender key are the `url` and `key` fields of one Clavis
secret, `grok/tinstar-decision-prep`. When either field is absent, replenishment
and Prepare now do nothing and the Preparation view says the preparer webhook
is not configured. The rest of Decision Desk keeps working. A row that already
had replenishment on is set off once, with a policy audit, so deploying this
step does not start posting. A later save from Preparation is the switch-on.

Automatic admission requires ready unleased packets plus in-flight jobs to be
below the saved target depth and source coverage to be complete. Both automatic
admission and Prepare now require in-flight jobs below the preparer cap, fresh
eligible source evidence, an unanswered request, no review lease or source-write
reservation, a card outside Todo, and no job in flight or Ready packet for that
source revision. Prepare now bypasses the target depth. Each exact request/revision
has at most one active job. Failed or rejected attempts and explicitly withdrawn
packets can be prepared again, as can packets whose material dependency revisions
have changed even when the request revision is unchanged. Successful research
whose semantic dependencies still match is revalidated without dispatching it
again; freshness expiry alone does not permit recomputation. There is no token
limit or spend record.

`publish_prepared_packet` stores the packet through the P1 store. The packet is
Ready only when that validation passes. The tool does not answer, claim a lease,
or change card status. A mismatched card, request, or revision is rejected
before anything is stored.

The Desk also imports the bot's fallback card comments headed
`Prepared packet (Tinstar Decision Prep)`. The `Decision:` line must identify
one current, unanswered request on that same card. Complete, fresh history is
required. Labelled sections are mapped into a normal packet and run through the
same schema and evidence validation. The question always comes from the exact
request record; the bot's question is advisory background. Options use the
request's identities. Explicit undo/rollback wording supplies reversibility;
missing evidence still blocks the named field.
Missing substantive fields block readiness with the field name. Lettered
recommendations resolve to the filed source options; they never create options.

Comment imports are marked `card comment (default authorization)`. Their
**AFTER YOU APPROVE** explanation is explicit:

> Default for comment-imported packets: your answer is recorded on the card and routed to the owning mate (Owner Firstmate, Status Queued); nothing else changes until they act.

That route applies to every answer. Per-option next actions from the bot remain
advisory prose, not executable authorization. Importing does not claim a card,
answer it, change its status, or dispatch another job. The comment ID and card
identify a single durable import, with the job ID recorded when supplied. A
matching expired job may complete through this fallback. A newer comment
supersedes the request's older packet. Re-reading a comment can renew source
evidence automatically after restart or source recovery, but never rebinds it
to a changed request revision. Unchanged packet research has no age expiry:
`expires_at` is null on the wire, and `review_within_ms` is retained only as a
legacy input hint. Fresh source evidence is still required at review/submit. Existing
imports blocked by the former prose-question or undo-mapping defects receive
one audited corrected version, retaining their original binding/dependencies.
A correction cannot supersede newer preparation.

The isolated sample proof is reproducible after `npm run build:all`:

```bash
node --import tsx scripts/decision-desk-comment-preview.ts /absolute/task-proof-dir
```

It serves the unchanged Desk on an OS-assigned loopback port using stub Notion
history and a fresh config root. It opens no MCP listener or live source.

A validation-blocked or expired attempt can publish a correction using its
original job ID while it has no replacement. Admitting a replacement permanently
marks older attempts for that exact request/revision `superseded`; direct and
comment publication reject them, and revalidation and restart recovery preserve
their retirement. Publication and
job completion share one transaction, and a later webhook response preserves
the completed publication state.

Prepare now posts one audited job for one decision while replenishment is off,
using the eligibility rules above. Open attempts, including validation-blocked
attempts, are reported failed after ten minutes from dispatch (or admission if
not dispatched); a late valid publication can still complete an unreplaced job.
Automatic replenishment checks at startup and every five seconds. Each pass
records its current coverage, known/unknown demand, exact candidates, rejection
reasons/counts, Ready/in-flight depth, free slots and dispatch failures. Source
read failures are reported separately from webhook failures in `runner.refill_pass`.
The runner explanation includes the most recent pass, including exhausted sources.

Current packet cards and in-flight jobs take priority over queued board history
reads, bounded by the saved target plus maximum preparers. Their canonical card
properties and complete body/comment history are re-read when either has less
than fifteen seconds of evidence remaining. Other queued cards refresh expired
properties as well as history, including explicit retries outside the priority
set. Two readers remain the concurrency bound;
a slow or failed source can still expire and block review. Revalidation uses the
same stored packet and semantic dependencies, with the original thirty-second
source horizon measured from read start. Packet age itself is not an expiry
condition, and preparation never recomputes an unchanged revision merely to renew
source evidence. Changed sources still invalidate it.

Preparation jobs retain the first successful `published_at` and `published` outcome
across later leases, evidence expiry and restarts, unless the attempt is retired
as `superseded` by a replacement. Their current `readiness` and
blocked reasons are projected separately. Only attempts without a successful
publication can expire as failed. Legacy publication timestamps are recovered
from retained successful validation events. Saved target/parallelism values are
unchanged; target admission still counts Ready packets plus in-flight jobs.

### Publishing a source request and loading history

A mate publishes a structured decision through the existing MCP `update_work`
tool. Card-native decisions use the canonical card ID and a unique request ID
on that card. Omit `source_request` when the decision originates on the card.
For First Mate-bound decisions, use the exact configured source identities
returned by `get_work_views` / `get_work`, rather than inventing a home, task or hold ID:

```json
{
  "kind": "request_decision",
  "card_id": "<canonical card id>",
  "operation_id": "<unique stable publication operation id>",
  "request_id": "<unique decision id on this card>",
  "question": "Approve the bounded preview?",
  "requested_from": "Will",
  "action": "Decision",
  "options": [
    { "id": "approve", "label": "Approve the bounded preview" },
    { "id": "defer", "label": "Defer the preview" }
  ],
  "source_request": {
    "home": "<exact configured First Mate home>",
    "taskId": "<exact source task id>",
    "id": "<exact source decision or hold id>",
    "kind": "decision"
  }
}
```

If that conversation holds a card lease, also pass its `lease_token` in tool
arguments. A successful call adds the Will action tag and a page comment with
`Operation: request_decision`, the exact question, option identities, and the
`Tin Star request` record. The server binds the current source question and
worker generation. Check `outcome: saved`; retry an ambiguous result with the
same operation ID and input. A free-text comment or Will action tag alone does
not publish this record. Options and complete, fresh request history are required
for a prepared packet to become Ready.

For a card-native `Decision` requested from `Will`, the packet binding uses
`card_id`, `request_id`, the request paragraph/comment `source_id` and its semantic
`source_revision`. Its `request_key` is the canonical JSON encoding of
`["card-request", card_id, request_id]`; `source_request` and `source_spawn_gen`
are null, and `source_question` is the card request's question. The evidence API
returns this binding and the dependencies to copy into the packet. Changed
questions, options or request records invalidate the old packet; timestamps and
option ordering do not. First Mate-bound requests retain live source and worker
generation validation. Both kinds dispatch the same webhook job and save owner
selections through the existing `answer_decision` operation. Answered requests
are excluded from the pending list.

For prepared decisions, a later `owner-chatgpt` workflow receipt or an
`owner-chatgpt`-authored comment on the card suppresses every request whose own
source creation timestamp precedes it. This deliberately includes unrelated owner
edits/assignments/parks: it is a broad structural answer rule, with no guessing
from prose. Receipt identity comes from the terminal `Tin Star operation` tuple;
plain comment identity comes from source author metadata. Unknown ordering blocks
verification rather than asserting an answer. Canonical `Tin Star answer` records
continue to count as answers.

Decision history reads all pages of page comments and top-level paragraphs
(the legacy workflow record surface). Specification code, embeds, and nested
contract content are not workflow publication surfaces. These omissions do not
make the decision history partial. General `get_work` prose remains explicitly
bounded and does not claim to contain the full implementation contract.

The Desk queues at most two card-history reads and never makes snapshots or
claims wait for that queue. Reads retain shared Notion request pacing and
Retry-After backoff, retry transient 429s, and have a 120-second source deadline
instead of the conversational reader's 20 seconds. Missing permissions, failed
pages and invalid pagination still leave history unavailable with a visible
retry. Evidence keeps its original 30-second freshness; reading the cache never
extends it. A sweep can outlive that freshness. **Prepare now** prioritizes and
refreshes the selected card plus expired source observations, so it does not
require the whole sweep to be simultaneously fresh. It works with automatic
replenishment off and does not change that switch.

An isolated round-trip harness can publish through `update_work`, call the real
Desk Prepare now API, receive the job at a local stub webhook, then publish
through `publish_prepared_packet` and expose Ready on the snapshot:

```sh
PREVIEW_CARDS=46 PREVIEW_LARGE_CONTRACT=1 PREVIEW_PUBLISH_REQUEST=1 \
  node --import tsx scripts/decision-desk-history-preview.ts /absolute/task-proof-directory
```

It uses only loopback ports 5293–5296 and a fresh config with test credentials.
The test card has 1,205 root blocks across 13 pages, including code chunks and
nested contract toggles. Its preview controls are POST `/__preview/release`
(unblock source reads), `/__preview/request` (publish the source request), and
`/__preview/publish` (publish a packet for the dispatched job). Prepare now is
POST `/api/reconciliation/decision-desk/prepare` with `X-Tinstar-UI: 1` and JSON
`{card_id,request_id,reason}`; the preview supplies its synthetic owner identity.
The output directory records the exact request, publication, snapshot and
webhook evidence. These controls exist only in the preview script.

## P5 — Review and Preparation UI

The existing **Decisions** entry defaults to the source workbench, preserving its
request list, answering controls, receipts, evidence, and Discuss behavior. The
**Workbench / Decision Desk** mode control makes prepared review explicit. No
prepared session is created or packet claimed while only the workbench is open.
The mode is retained across in-app navigation so returning from Discuss keeps the
selected surface; it is not persisted as a new default. A page reload starts with
the workbench. The owner must explicitly enable the future Desk default (fork F);
packet availability never switches it automatically.

The selected Decision Desk mode uses the prepared-review APIs for one real,
server-registered review context. Session capabilities, exact selections and
submission operation IDs are retained in session storage and sent only as API
arguments. Duplicate browser contexts with cloned storage resume that same real
session; a distinct context must explicitly create a new session. The rail lists
actual server contexts and explains that other contexts must be resumed in their
original browser. Discuss remains available as an explicitly opened overlay in the Desk mode; the
workbench retains its existing responsive Discuss behavior.

Open **Source request & discussion** from the evidence inspector (or the inline
**Evidence, confidence & execution boundaries** disclosure on smaller screens)
to inspect card context, receipt history, an available exact source terminal link,
and the request-bound text/voice composer. **Open source conversation in Discuss**
resumes its existing thread. Returning from Discuss retains the exact request key;
if the card-only claim returns a different request, the desk releases a newly
allocated substitute without answering and reports that the requested decision is
not ready or is held. An existing held claim, including another request on the same
card, retains its lease and local selection with an explanation that this session
holds a different decision. It never presents that claim as the requested destination.
Each explicit Return to source or card/request selection creates a **one-shot**
claim target. Its first result consumes it, whether claimed, retained by this
session, held elsewhere, refused as a substitute, or not ready. Queue observations,
ordinary revisions, refreshes and mode changes do not re-arm it. Subsequent claims,
including Refresh and continuation after submit/skip/research, are untargeted
next-ready claims (the backend still resumes this session's unresolved held card).
A requested-target conflict/refusal/not-ready screen exposes **Claim next prepared
decision** as its primary action at every width and **Try this decision again** as
a quiet, explicitly targeted retry. Retained answers and pending release recovery
remain bound to their original source and operation; this does not discard them. Unlinked requests cannot
be reviewed without a verified canonical card and prepared packet.

**Submit decision & next →** records the selected source option before advancing.
**Skip** releases without answering. **Need more research** accepts an optional
reason, withdraws the packet and serves the next eligible decision; it does not
answer or post a preparation job by itself. An unconfirmed release retains its original operation and session/
lease capabilities for reconciliation before another claim or submission. A
definitive rejection clears the pending release; an expired or lost lease then
requires re-claim and revalidation. Unresolved answers and local selections remain
retained through this recovery.

Retained worker notes are under **Preparation → Source delivery
details**. MCP navigation still uses the operational queue, but visible delivery
uses the visible selected mode: the workbench retains its searchable request list,
while prepared Review requires its exact leased packet to be painted.

Review uses the approved three/two/one-column layout, source-bound radio choices,
scoped high-risk confirmation and readback-confirmed submit/next. Expired leases,
invalidated evidence and unavailable sources block submission. Definite and
unconfirmed saves retain the selection and operation; retries use the same ID.
Preparation saves the effective versioned queue policy and shows whether the
Tinstar Decision Prep webhook is configured, along with job failures and pending
rows. See [P4](#p4--preparation-jobs) for configuration and admission rules. Unknown source totals
are unavailable, not zero. The `/snapshot` projection supplies full latest-packet
inventory/counts and pending rows under the [read-only evidence contract](#read-only-preparer-evidence);
it is separate from the bounded publication inventory.

**Multipart boundary:** P5 reviews each independently identified source request
separately through P3. Same-card requests are not inferred to form a bundle.
The owner selected C1 with option buttons and free text always available,
including for multi-part asks, on 2026-11-16. That flow, combined A/B/C submission
and its partial-save screen remain later work. Recorded progress is per source
request, never a claim that an unspecified bundle is complete. Integrated
acceptance also follows separately.

The isolated running-UI harness is
`scripts/decision-desk-ui-preview.ts <task-proof-directory>`, after `npm run
build:all`. It creates a fresh config root and SQLite database, uses a disposable
Notion-compatible source adapter, and serves preview-only fault controls outside
production routes. No live home, token, board, bridge or preparer is enrolled.
Browser proof uses a named `chrome-devtools-axi` session which must be stopped
after capture. Browser Performance measures distinguish claim API/visible and
submit API/visible timings, with outcomes separating filled-buffer, empty and
unavailable cases; source prose and capability tokens are never measure names.

For the historical CI card `41a50ce6d42281998e2ee26fa2364c54`, the owner and
Grok used the same provider user, without an application-actor marker on the
owner's plain comments. Provider-author guessing is deliberately excluded.
Immediately after deployment, firstmate must record the existing answers for
`fleet-ci-deploy-plan-20261116` and `fleet-ci-route-tags-20261116` using
`answer_decision`, the selected option IDs and the owner's verbatim words. This
backfills canonical answer receipts and closes those two requests; it does not
ask the owner to decide again. This deployment prerequisite belongs in the PR
handoff, since unmarked historical comments are not automatically classified.
