# Coordinator-side worker-link writer design

Status: the narrow coordinator CLI is implemented as
`npm run worker-links:adapter`. Tin Star's server, browser and MCP remain
read-only. Live rollout and the real Notion-to-gutter acceptance proof belong to
First Mate after merge; automated tests use fake Notion responses only.

## Approved dispatch provenance

On 2026-11-05 at 17:52Z the coordinator authorized the dispatch-ledger pilot:
each home records the selected card in its task's backlog note at dispatch.
The published snapshot's `backlog.records[].body_lines` or
`tasks[].backlog.body_lines` carries exactly one line:

```text
card: 40f50ce6d42281b08375d793820e2e40
```

`card: none` explicitly means independent work. The case-sensitive key and
spacing are exact; standard dashed UUIDs normalize to 32 lowercase hex digits.
Multiple or malformed `card:` lines require investigation, including repeated
identical lines. Mirrored task/backlog copies must agree. No prose is retained.

This replaces the earlier proposal for a separate typed receipt store. No new
ledger transport, upstream fork or dispatch flag is needed. These notes and
snapshot publishers must be controlled by the responsible First Mate home:
the marker is a coordinator-authored dispatch decision, not a cryptographic
attestation. Never mint it by extracting an ID from a worker brief after dispatch,
copying a title/URL or accepting a model suggestion. Workers without this line
remain candidates; the adapter does not manufacture attestations for them.

The card line binds the page to the logical task (backlog item). The first write
anchors the generation observed at that moment. Later generation differences
remain conflicts requiring coordinator continuity evidence. Existing
Notion anchors and multiple observed attempts catch changed generation/ID reuse;
the note alone supplies no continuity authority. Relaunches and moves that
contradict an anchor require First Mate review, with no silent anchor replacement.

## One collection and classification

The shared fleet collector extracts identifiers and source field paths without
publishing backlog prose. The existing worker-link report owns the new eligible
tier and all prior candidate/conflict tiers. The adapter consumes its eligible
proposals; it has no second matcher. The scene still confirms edges only from
valid Notion declarations after ordinary source refresh.

Eligibility requires a fresh complete relevant home, an operational worker with
exact home/task/generation, a current complete configured Notion board, a present
operational card and readable declarations across the board. Declaration
eligibility and malformed-record recovery follow the
[coordinator adapter rules](notion-worker-links.md#coordinator-adapter). Existing
valid declarations on any other card, including historical cards, and any
contradictory reference stop that worker. Unrelated partial Notion relations
still allow prior positive read-only evidence but suppress this writer tier.

## Serialized reread–merge–write–readback

The coordinator runs one adapter invocation per board at a time and excludes
other credential holders from concurrent relationship edits during the pilot.
There is no Notion compare-and-swap or distributed lock. Per-card ordering cannot
protect against an external editor changing the property after its reread.

Default mode only collects and reports. `--apply` explicitly authorizes writes
under the [adapter repair rules](notion-worker-links.md#coordinator-adapter)
and requires both a token **file path** and `--max-cards 1..5`.
It processes one card at a time, adding at most ten worker references per run.
Filters and batch limits queue remaining decisions for another invocation.

For each eligible card, the adapter:

1. Checks that collected coverage has not expired, rereads the card and verifies
   its board, operational status and rich-text property type. Retrieves every
   property item through the paginated property endpoint, even for inline blanks.
2. Validates the entire v1 record or recovers identities under the
   [adapter repair rules](notion-worker-links.md#coordinator-adapter).
3. Merges into the latest validated or recovered record, preserving every sibling and its
   generation. An exact existing entry in a valid record is a no-op. A different generation stops
   the batch for investigation. A sibling appended since report collection is
   preserved by the full reread.
4. Validates the complete replacement against 200,000 characters, 100 items and
   2,000 characters per item. Unicode pairs are never split. Durably appends the
   planned audit entry before issuing a PATCH containing only `First Mate tasks`.
5. Reads the card and full property again. Validates and compares the complete
   semantic v1 record, including sibling order and generation anchors. Rich-text
   chunk boundaries may differ; the decoded record must be exactly equal.
6. Appends verified success, or stops the entire batch on any uncertain write or
   readback. There is no blind timeout/network retry. Only explicit HTTP 429
   responses retry, at most twice, honoring Retry-After up to 30 seconds per
   retry. All PATCH attempts are spaced by at least one second. Home and Notion
   freshness are rechecked after waits immediately before every PATCH attempt;
   expired coverage stops the batch.

Dispatch-time triggering and substantive scheduled check-in reruns belong to the
coordinator workflow, not this CLI.
Repeated reconciliation derives idempotency from current Notion content. Audit
history never grants assignment authority. After uncertainty, First Mate must
investigate and reread Notion before explicitly invoking the adapter again.
Rollback likewise requires a fresh coordinator-reviewed merge.

## Audit and investigation routing

The required audit path receives durable JSONL decisions, planned writes,
verified writes, no-ops and stops. Records contain timestamp, card ID, exact
worker identities and generation anchors, before/after SHA-256 record hashes,
result and, when needed, a stable investigation key. See
[adapter usage and audit format](notion-worker-links.md#coordinator-adapter).
No credential, remote error body, raw brief or transcript belongs in the audit.

Conflict/ambiguous/unavailable rows identify one investigation key per logical
home/task; card-wide malformed/readback problems use one card key. The report
contains candidate IDs, source field paths and freshness for the coordinator's
existing supervision workflow. Repeated evidence routes to that same item until
First Mate closes the episode after verified disposition/readback and refreshed
Tin Star evidence. Investigation handoff and deduplication also belong to that coordinator workflow,
not this CLI. The adapter emits routing records; it does not create cards,
change progress, send nudges or add a privileged MCP path.

The owner-only next step is First Mate's reviewed report-only run, followed by a
bounded apply using its credential and a recorded ordinary Tin Star refresh.
The pilot must prove one new exact-provenance edge, two preserved workers on one
card, an idempotent repeat and unchanged unrelated card properties. No live
credential was read or live write performed during implementation.
