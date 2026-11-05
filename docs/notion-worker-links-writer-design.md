# Coordinator-side worker-link writer design

This is a design for a narrow First Mate adapter, not an implemented writer.
Tin Star's server, browser and MCP continue to read/report only. The adapter
would run under the responsible First Mate coordinator's existing Notion
credential, with access limited to its configured board/homes. The coordinator
owns rollout, serialized edits and investigations. There is no upstream First
Mate fork, spawn flag, new privileged Tin Star route or model-based authority.

## Evidence available today

The current normalized fleet snapshot exposes exact `fm_home`, task ID and
`spawn_gen`, plus legacy card references from task/backlog metadata. Notion
exposes the versioned declarations. The collected scene contract does **not**
expose a durable, authenticated coordinator dispatch receipt binding a primary
Notion page to a logical task. Therefore the current report's `eligible auto-write`
tier is always empty, with `dispatchProvenance.status: not-collected`.

Existing valid declarations with a fresh matching identity are already confirmed
and need no write. A structured legacy `work_item` or `notion_page_id`, a UUID or
URL in a brief/backlog/title, an equal title, a branch/PR, semantic ranking, or an
arbitrary field claiming to be dispatch provenance remains candidate evidence.
Adding more such fields or raising confidence never supplies write authority.
A changed generation without positive continuity evidence requires investigation.

## Exact provenance without changing upstream First Mate

The authorized coordinator's existing dispatch workflow can produce a separate
durable receipt when it actually selects the canonical Notion page and dispatches
the logical task. The receipt must record that **decision**, not extract a page
ID afterward from free text. A wrapper/workflow around the existing dispatch and
check-in commands can capture it without modifying First Mate's CLI or runtime.
The proposed receipt belongs in a coordinator-controlled durable audit store,
outside worker-supplied metadata. Its future reader is an adapter input, not a
new interpretation of `work_item` or Tin Star's current scene input.

An eligible receipt must bind these facts together:

- A unique coordinator dispatch decision ID, responsible coordinator/home and
  decision time, plus the single selected canonical Notion page ID.
- The exact logical `(fm_home, task_id)` and an independently observed initial
  `spawn_gen`/creation anchor from the durable task record and fresh fleet read.
- The dispatch operation's successful identity readback. A planned dispatch or
  failed spawn is not evidence that the worker exists.
- For a relaunch or move, the explicit coordinator continuity decision and its
  durable predecessor receipt/task-record reference. Same title/ID or a new
  generation alone is insufficient. Unproven moves do not inherit assignments.

Only the coordinator workflow may mint these receipts. An imported worker brief,
task field, Notion string or model suggestion cannot mint one. Before a future
adapter accepts receipts, First Mate must choose the actual durable store and
document its ownership, retention and read interface. This PR does not claim an
existing deployed receipt source or invent one from today's snapshot fields.

For preexisting workers without receipts, First Mate can investigate durable
records and explicitly attest a verified association through that same auditable
workflow. That is a new authorized decision, never automatic promotion of legacy
evidence. The current backfill merges are manual verification aids only.

## Dry-run tiers and bounded pilot

The report groups operational workers/cards per configured home into exactly
`already confirmed`, `eligible auto-write`, `ambiguous`, `independent`,
`conflicts`, and `unavailable`. Each row contains IDs and source field paths;
no raw task prose, transcript or credential is exported. Finished/absent workers
and Done/archived/trashed cards are outside the operational backfill. Historical
relationships remain visible in the separate deterministic detector report.

First Mate reviews the initial dry run and authorized receipt source before
enabling any pilot. Proposed initial adapter bounds: at most five operational
cards and ten worker references per invocation, one card write at a time, no
parallel invocation for the same board/coordinator. Limit writes to one request
per second and honor Notion rate limits. Reaching a batch limit leaves the rest
queued for the next explicit invocation; it never truncates a property's entries.
These are pilot limits in the design, not hidden feature gates in Tin Star.

No currently eligible rows is a useful outcome: use the deterministic report and
one First Mate investigation workflow while establishing exact provenance.

## Serialized reread–validate–merge–write–readback

For each future eligible card, the coordinator-side adapter must:

1. Read fresh, complete authorized Notion card pagination and fresh complete
   relevant home snapshots. Validate the durable receipt and canonical worker
   identity. Read all card declarations to reject competing primary assignments.
   Restrict selection to operational workers/cards. Unknown coverage stops that
   candidate; it does not prove absence, retirement or independence.
2. Acquire the coordinator's serialized per-card queue entry, then reread the
   card and entire property immediately before merging. Validate the entire v1
   schema, identity keys, generation anchors, item/total size and completeness.
   Never overwrite invalid JSON, unknown schema, missing/unknown or truncated
   records. A genuinely blank/unlinked field is still unknown, not an empty
   record: initialization needs a fresh full card read and an explicit coordinator
   decision establishing the initial empty record. The automated merge loop only
   appends to validated records; it does not silently initialize unknown fields.
3. Compare the canonical home/task against all existing entries. An exact
   already-present binding is a no-op, with no duplicate write. Preserve every
   sibling worker. A different generation needs the verified continuity decision;
   never refresh an anchor merely to clear a mismatch. Competing cards, reused
   IDs and unproven home moves stop the candidate for investigation.
4. Construct the complete merged v1 record, enforce Notion's 100 × 2,000 item
   limits and 200,000-character ceiling, then write **only** `First Mate tasks`.
   Do not touch Status, Owner, Initiative, Epic, Next check-in, Will action,
   Parent/Sub-item, PR links or unrelated properties. Do not create progress or
   milestone events from routine link maintenance.
5. Read all rich-text items back immediately, validate and compare the complete
   semantic record, including preserved siblings. Record success only when the
   intended entry and every prior entry survived exactly. Notion offers no
   guaranteed compare-and-swap: the queue is single-writer ordering, not a claim
   of atomic protection against another credential holder editing concurrently.
6. If a pre-write reread reveals another append, merge against that new validated
   record, for at most two pre-write attempts. Honor explicit rate-limit retry
   delays within the invocation budget. After a timeout, interrupted write or
   uncertain/different readback, stop the card and the batch. Persist uncertainty
   and investigate before any retry. Do not blindly replay an uncertain write.

Dispatch is the normal trigger; substantive scheduled card check-ins provide a
backstop. Repeated invocation is idempotent by receipt/worker identity and verified
existing content, not by a local claim that a prior network call succeeded.

## Audit, recovery and one investigation item

Persist an audit entry before an attempted write and append its verified or
uncertain result afterward. Include invocation/dispatch decision IDs, coordinator,
home/task/generation, card ID, source observation times/coverage, provenance field
paths/receipt IDs, preserved/added identity sets, prior complete valid record,
intended record, bounded attempt number, and readback disposition. Keep this
private under First Mate's authority; retain no tokens or raw briefs/transcripts.
Link the verified readback to the next refreshed Tin Star explicit claim evidence.

The audit is a recovery aid, not a second assignment authority. After a crash,
reread Notion and the durable receipt before resuming. If the intended merge is
present with all siblings, record a no-op/verified completion. If it is uncertain
or changed, stop and investigate. Rollback is a coordinator-reviewed fresh merge,
never a blind replacement with an old property snapshot.

Route ambiguity, conflict and uncertain readback to **one** durable First Mate
investigation item per logical `(fm_home, task_id)` episode (or per card for a
card-wide malformed/readback problem). Include candidate card IDs, receipt/source
field paths, source freshness and the required next verification. Append new
evidence to that item instead of opening another alert. Episode closure requires
a verified disposition, Notion readback and fresh Tin Star evidence; event receipt
or a worker activity change does not close it. Dispatch uses the existing First
Mate supervision channel; local nudge delivery remains Slice C and is not added
by this report/design PR.

The responsible First Mate must supply the approved durable receipt interface,
pilot authorization and credential before implementation of the writer. The next
trigger is that explicit coordinator handoff. This design does not demonstrate
an automatic live write; that child-card acceptance proof remains future work.
