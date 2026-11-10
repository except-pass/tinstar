# Shared workflow operations

Tin Star owns workflow recording; Notion remains authoritative. Overview’s
**Create work** and the Inspector’s **Update work** and **Start work** forms call
the same backend operations as the authenticated MCP. Work tools require no open
browser or `scene_id`. Explicit window selection and acknowledgment still govern
presentation focus/flash.

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
including membership changes. For truncated Initiative/Epic relations, an absent
inline match leaves membership unknown: existing membership is retained, while
queries without the card are invalidated for a fresh scoped read. Results are `saved`, `not-saved` or
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

## Slice 1 delivery history

At slice 1 delivery, remaining operations and pickup/update integration were
reserved for slice 2 (now described below). See that section for current retained
dependencies and the [watchdog reference](check-in-watchdog.md) for its scoped
eligibility census and current-card verification.

Catalog additions: `search_work`, `get_work`, `get_workflow_rules`, `start_work`.
No existing MCP signatures changed in slice 1. Deployment and one disposable-card
live UI/MCP/Notion/First Mate acceptance run remain Firstmate-owned; local tests
and screenshots use fixtures and do not establish live acceptance.

## Slice 2: remaining operations and First Mate integration

`create_work` and `update_work` extend `WorkflowOperations`, the existing
`start_work` policy, the authenticated MCP/tunnel, and compact Overview/Inspector
surfaces. The **Create work** action requires a name, owner and area; the
Inspector's **Update work** form collects each operation's coupled inputs. Neither
surface needs Notion open. Inspector details include bounded comments as well as
body prose. A card leaving the current filter remains in the Inspector with its
last confirmed readback so a partial save can still be seen and retried.

`create_work({operation_id,name,owner,area,status?,properties?,content?})` creates
one page in the configured data source. Initial status is Queued by default;
Firstmate assignment always records Queued. `content` has optional `brief` and
`acceptance_criteria`; ordinary properties preserve canonical Initiative/Epic
relation IDs. No owner, execution or substantive card facts are inferred.

`update_work({card_id,operation_id,kind,...,expected?})` accepts:

| kind | Inputs / changes |
| --- | --- |
| `edit` | Optional ordinary `properties`, `content` (brief/acceptance), `note`. No raw Owner, Status, worker link, checkpoint or Will action bypass. |
| `assign` | Declared `owner`, optional queued/planned `status`, optional handoff `note`. Firstmate is always Queued. |
| `checkpoint` | `checkpoint: {assessment,evidence,next_action,next_check_in,confirmation,request_id?,blocker?}`. Confirmation is `provisional` or `owner-confirmed`; it is caller-declared and recorded in history, never inferred from actor/owner names. |
| `wait` | `dependency`, `unblocks_when`, `follow_up_by`, optional `note`. Enters Waiting For and appends that wait while retaining other waits. |
| `request_decision` | Caller-chosen `request_id`, `question`, `requested_from`, optional action tag (default Decision). Records the request and merges its action tag. |
| `answer_decision` | That `request_id`, `answer`, declared `next: {owner,status,worker?,wait?,disposition?,evidence?}`, optional exact `resolve_wait`. Returning to In Progress requires the same current tracked worker evidence as start; Waiting For requires all wait inputs; Done/Archived requires disposition/evidence. |
| `complete` | Explicit `disposition` and `evidence`, records Done. No inference from merge/service/worker exit. |
| `park` | Explicit `disposition`, status Backlog (default) or Archived. |

Ordinary properties are Name, Area, Priority, Sub-area, Attention, Initiative,
Epic, Link, Due Date, Start Date and Next action. The server uses the actual
Notion property type; relation classifications accept canonical page ID arrays.
An unsupported/truncated property fails only the operation that replaces it.
Owner/Area are required on new assignments/starts/waits, while notes, ordinary
edits and corrective closure remain possible on imperfect legacy cards. No
existing unknown or stale worker state is silently repaired. External-worker
support reuses slice 1's Delegated To report and exact native First Mate links.

Answers preserve all other action tags and waits. Multiple tracked open asks
sharing one action tag keep that tag until the last resolved request; tags that
predated those requests remain unless the consumer explicitly resolves them.
An older ask can use its actual Notion paragraph/comment ID as `request_id`.
Optional `legacy_action` explicitly identifies the tag the caller judges resolved;
omitting it preserves every legacy tag. The caller remains responsible for
whether that legacy tag also represents another unresolved ask. `resolve_wait`
must uniquely match the exact current wait text; Tin Star removes just that text.
The original ask and answer remain in history. The UI offers source notes for
selection alongside request ID entry.

Brief and acceptance edits upsert two named paragraphs, preserving other body
content and history. Existing unmanaged prose remains available; older asks
retain their actual source IDs. Read/validate/recheck/write/confirm is one path
for every operation, with a common per-card lock across start and update.
`expected` compares only supplied property values. Replacement body paragraphs
also compare their read-before-write text. Set-valued properties and checkpoint
readback compare meaning, including timezone rendering, rather than ordering or
formatting. Direct Notion edits can still race a multi-request operation.

Updates confirm properties and managed sections before writing the history note.
If only the note fails, the same process can repair it once, provided the card's
last-edited time and properties remain unchanged. A changed card returns the
confirmed partial result without another write; review current state and re-issue
with a new operation ID. Definite results that require a fresh attempt set
`requires_new_operation_id`; the UI offers refresh and explicit re-issue solely
from that flag, including on cached results. Uncertain saves retain their identity.
Other partial failures also require reconciliation by
the caller. There is no property replay, note-first plan receipt or automatic
restart recovery. A completed operation's note marker prevents duplicate notes.

A receipt in the initial creation body recovers lost create responses, with a tiny durable local
creation latch in `workflow-create-receipts.json` preventing an uncertain POST
from being repeated if the card was renamed or its query receipt is not visible.
That latch is not an offline queue or authoritative card. Reconcile an uncertain
creation through current reads before intentionally creating with a new ID.

Checkpoint prose normalizes line breaks to spaces in history, then validates the
serialized report against the existing [watchdog report requirements](check-in-watchdog.md#notion-closure-and-repair)
before any write. This applies to assessment, evidence, blocker and next action;
invalid reports return `invalid-checkpoint` without saving. Checkpoint timestamps
use the existing America/New_York, 9 AM date-only, DST and board ceiling helpers.
In Progress appointments must be in the future and
under the existing ceiling; Due Date remains a separate delivery deadline. Only
an explicit checkpoint moves Next check-in. Provisional/owner-confirmed status
is recorded in the checkpoint comment; neither ordinary edits nor a webhook
upgrade it. Worker and request history survives completion/parking.

`FirstmateUpdates` joins the existing source-refresh callback, shared targeted
Notion reader, and **existing Ask bearer bridge**. It does not invoke First Mate
source/scripts, dispatch workers, add a scheduler, or create another inbox.
Authenticated operation actors drive self-edit suppression for confirmed writes.
The observer excludes only confirmed property, section and note effects; other
unobserved changes are delivered with unknown attribution before advancing its
baseline. Matching edit times and property readbacks deduplicate scan notices. Direct
Notion edits carry unknown attribution. Last touched by never suppresses them. A Firstmate-owned Queued card
gets one pickup per observed outstanding assignment. Leaving that assignment
clears its latch, so a later requeue is actionable. Active In Progress/Waiting For
changes become contextual updates. Nearby changes by one actor coalesce for ten
seconds in batches of up to twenty cards; an offered notice freezes its original
inbox request ID/body, and failed wakes retry that same note.

The safety scan queries only Owner Firstmate and Queued/In Progress/Waiting For,
roughly once per minute on the existing callback. It does not require historical
coverage or body reads. Changed active cards fetch bounded shared details on
demand for available comments/authors and body section changes. Property/body
diff baselines stay in memory; persisted state contains assignment latches,
edit times, minimal deduplication and pending inbox notices, not a board mirror.
Delivered notice payloads are discarded. After restart, unavailable prior diffs
are disclosed with current context; no perfect historical replay is promised.
Comment-only edits are checked without body reads on a rotating batch of four
active Firstmate cards per minute, covering a stable set of N cards within
ceil(N/4) sweeps. Explicit refresh checks comments immediately for the requested
active cards; a forced feed sweep checks all active cards. These reads share the
comment cache and API limiter. New comment IDs, including author, enter the
existing coalesced update and retry path even when page revisions are unchanged. Failed or
partial source reads retain prior assignment state and never imply deletion.
New pickup delivery rechecks the exact card; source failure retains it for retry.
Preview delivery follows the watchdog's existing disabled-by-default settings.

The watchdog's census, exact verification and context use the same reader/cache
and limiter. Its inbox request now directs consumer writes to `update_work` kind
checkpoint, including its original request ID. Its mechanical appointments,
bounded request/follow-up behavior and unknown-source semantics remain unchanged;
the meaning-based readback fix from https://github.com/except-pass/tinstar/pull/354
is retained. The watchdog itself still makes no autonomous Notion judgments or
writes and does not treat an ordinary reply/status change as a checkpoint.

Slice 2 catalog: added `create_work`, `update_work`; changed
`get_workflow_rules` to expose enforced remaining-operation rules. Existing
`start_work`, `search_work` and `get_work` signatures remain compatible; Inspector
card context now includes comments. Both new tools traverse the existing
single authenticated tunnel with the same network/credential boundary. After
deploy, Firstmate must tell the owner to refresh the ChatGPT connector catalog.

Retained for slice 3: the Mac Notion poller and PM Bot monitors/listeners,
consumer reporting/judgment, shared computed decision/Needs Will PR view and
staged writer/poller retirement. No paused routine is restarted. The new feed's
live deployment and poller cutover must be coordinated by Firstmate to avoid
duplicate pickup during the staged transition. This slice does not grant merge,
deploy, shell, worker-lifecycle or production authority.
