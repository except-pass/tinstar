# Shared work reads and start work

Tin Star owns workflow recording; Notion remains authoritative. The Inspector’s
**Start work** form and the authenticated MCP’s `start_work` tool call the same
backend operation. Work tools require no open browser or `scene_id`. Explicit
window selection and acknowledgment still govern presentation focus/flash.

This slice also delivers the work-read part of MCP Slice B. `search_work` wraps
the existing Notion reader, scene/link projection and Smart Search predicates.
`get_work` reads an exact card from the configured board, including history outside
the operational result. IDs are the UI’s card/execution/claim IDs; links retain
current, last-known, historical, conflicting and unverified distinctions. Unknown
coverage never means no worker. Stalled/Blocked use the UI’s `workHealth` rules,
including unavailable evidence. Body/comments are on-demand; comments include
published author ID and creation time. Existing associated PR URLs are evidence;
PR checks and releases get their own later read tools (`list_prs`, `get_pr`,
`get_release_status`). No duplicate GitHub reader is introduced here.

## Read contracts

`search_work` accepts `owner`, `statuses`, `initiative`, `epic`,
`checkpoint_before` (ISO timestamp), `query`, `patterns`, `history`, `offset`,
`limit` (1–100, default 50) and `refresh`. Owner/status/classification/checkpoint
filters run at Notion. Relation classifications use the canonical related page ID.
Absent explicit statuses, operational queries exclude Done and Archived;
`history: true` allows an explicit historical scope. The response names its scope,
coverage, warnings, card/worker totals and `next_offset`. The same offset/limit pages the records and worker evidence. Unlinked workers remain discoverable through an unfiltered or text query; owner/status/classification filters return only workers related to cards in that scope, with link verification disclosed. Total is within the observed
bounded result, not a claim about an incomplete board. Missing source evidence is
visible in coverage and per-record health. No browser filters are inherited. The UI’s explicit All/custom status choices request history through the same reader; the default operational view does not scan history.

`get_work({card_id, details?, refresh?})` verifies configured-board membership.
It returns current properties, worker links/evidence, external reports and
optionally bounded prose/comments. Source failures expose unavailable or visibly
stale last-known properties, never a successful empty card. External source changes
appear after refresh/cache expiry. Property reads coalesce for about 60 seconds;
schema caches for ten minutes; details for 30 seconds. Active scans omit hierarchy
expansion and body/comment reads. The existing search index’s bounded background
prose collection remains independent of these property-only scans.

All application Notion requests share pacing (350 ms between requests) and
honor Retry-After before another request. A 429 degrades source coverage; writes
are never automatically retried. Counts by method/resource/query, cache hits,
429 responses and cumulative request/queue latency appear in the existing sources
and work-read diagnostics. There is no persistent mirror or offline write queue.

## Start contract and enforced rules

`start_work({card_id, operation_id, worker, expected?})` requires an existing
Owner and Area. `expected`, when supplied, contains `owner`, `status` and
`worker_links` from the prior read. Relevant fields are checked again before PATCH;
unrelated concurrent property changes do not cause conflicts or get overwritten.
A per-card lock serializes Tin Star’s own starts. Notion offers no cross-request
transaction or complete protection against a simultaneous direct Notion edit.

For First Mate, `worker` contains `kind: "firstmate"`, `fm_home`, `task_id`, and
`first_observed_spawn_gen`. The configured source must currently track this exact
worker/generation and publish fresh pane/run-step or Codex turn execution evidence.
Owner names, old status-log messages, bare endpoint existence and historical links
do not authorize a new start. Stale, partial or missing source evidence stays
unknown; no existing card is silently flipped or repaired. Exact native identity
strings remain unchanged in `tinstar.fm-links.v1`; other linked workers survive.
A conflicting generation or unreadable existing worker property needs correction
before its provenance can be safely merged. This prevents losing existing history.

An external `worker` contains `kind: "external"`, `system`, `run_id`, HTTP(S)
`reference`, this `card_id`, `observed_at`, `state: "running"` and substantive
`evidence`. Its current observation must be within five minutes (30 seconds of
clock skew allowed). The authenticated reporter supplies the judgment and remains
responsible for its truth. Tin Star validates recording inputs and labels this
**consumer-reported**, not independently verified. The smallest durable record,
`tinstar.external-worker.v1`, is appended as a JSON line to the existing Delegated To
rich-text field. Other Delegated To content remains. External runs never become fake
First Mate tasks. Reads/UI preserve their own references, reporter and observation;
a report that ages out displays execution unknown without changing card status.

One Notion PATCH couples worker provenance, Status = In Progress and Last touched
by. Caller attribution comes from the existing authenticated interface: the local
UI authority is `Tin Star UI`, direct install-token MCP is `Tin Star MCP`, and the
existing facade supplies its authenticated configured caller ID. Tool arguments
cannot choose their actor. The facade’s network/credential boundary and explicit
presentation permission remain; all authenticated consumers get the same workflow
tools. No shell, dispatch, merge, deployment or production permission is granted.

Readback confirms each saved property and updates exact-card/scoped-query caches,
including membership changes. Results are `saved`, `not-saved` or
`partially-saved`, with a code, explanation, confirmed `saved_fields` and available
card readback. An ambiguous network failure after submitting PATCH is partially
saved with no fields confirmed. Refresh/retry the same `operation_id` and input;
retries merge current provenance, patch only missing fields and add no notes.
Identical successful retries share a ten-minute in-memory receipt. Beyond that
window/restart, exact current properties still prevent duplicate link/report
content. A changed input needs a new operation ID. No general event ledger exists.

Start preserves Next check-in, Due Date, asks, waits, classification and unrelated
properties. Ordinary activity never advances appointments. Existing timezone,
9 AM date-only, DST, ceiling, provisional/confirmed and watchdog idempotency rules
remain with their existing helpers. `get_workflow_rules` exposes the enforced
rules and identifies pending operations without needing separate Notion rules-page
access.

## Retained dependencies and delivery

Create/edit/assign/checkpoint/wait/decision/complete/park, pickup/update delivery,
computed decision views and watchdog writer migration are later slices. Existing
writers, the Mac Notion poller and PM Bot monitors/listeners remain until their
replacements work. This slice retires none of them and restarts no paused routine.
The watchdog keeps its independent Firstmate active eligibility census and current
card checks; it no longer needs a historical board scan through the shared scene.

Catalog additions: `search_work`, `get_work`, `get_workflow_rules`, `start_work`.
No existing MCP signature changes. After deploy, Firstmate must tell the owner to
refresh the ChatGPT connector’s tool catalog. Deployment and one disposable-card
live UI/MCP/Notion/First Mate acceptance run remain Firstmate-owned; local tests
and screenshots use fixtures and do not establish live acceptance.
