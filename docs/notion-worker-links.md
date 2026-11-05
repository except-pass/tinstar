# Notion-owned worker links

Notion declares the primary task association. First Mate owns worker identity,
execution state and location. Tin Star reads both sources, compares identities,
and displays the relationship and evidence; it never writes assignments or
executes a path/command from a Notion field. No First Mate patch or spawn CLI
flag is required. A worker may have one primary card; a card may have many
workers. Independent/ad hoc workers may have no card.

## Property format

The board property is named exactly **First Mate tasks**, with type
**rich text**. The responsible First Mate coordinator is the only routine writer.
The page ID is implicit in the owning card. This illustrative record is not a
real assignment:

```json
{"schema":"tinstar.fm-links.v1","tasks":[{"fm_home":"/example/fm-home","task_id":"example-worker","first_observed_spawn_gen":"example-generation"}]}
```

Use exact identities from the authorized fleet snapshot's top-level `fm_home`
and `tasks[].id` / `tasks[].spawn_gen`. The association key is `(fm_home, task_id)`;
`first_observed_spawn_gen` anchors the observed attempt to detect recycled IDs.
Never infer identity from a title, alias, display label or filesystem search.
Configured homes must be unique: the current fleet configuration cannot distinguish
identical home paths on different hosts. Give those sources distinct canonical
home identities before using them together.

Notion's write limits are **2,000 characters per rich-text item**, **up to 100
items per property**. Split a long JSON string into consecutive text items and
read it back by concatenating *all* items in order. Tin Star enforces those
limits and a 200,000-character parsing ceiling, without truncating. The reader
accepts Notion `plain_text` or the write/read `text.content` representation.
Unit tests exercise exact boundaries and split records; these tests are not a
claim of a live Notion write or concurrent-write proof.

`{"schema":"tinstar.fm-links.v1","tasks":[]}` explicitly declares no links. A
missing/wrong-type/unreadable/truncated property is **unknown**, not an empty
association. A readable rich-text property with no items, or whose concatenated
text is empty or whitespace-only, is the same unknown/unlinked state: not
malformed JSON and not a verified assertion of zero links. It emits no finding
and suppresses absence coverage the same way a missing property does. Writers
who mean "no links" still use the explicit empty record.

## Parser rules

`src/server/reconciliation/workerLinks.ts` validates the record atomically. An
invalid entry invalidates the record; no subset becomes authoritative.

- Accept only `schema` and `tasks` at the root, and the exact v1 schema above.
- Require a tasks array whose entries contain only `fm_home`, `task_id`, and
  `first_observed_spawn_gen`. No status, manager, machine, activity, Initiative,
  Epic, page ID or other worker attributes belong here.
- Require nonempty string identities, no surrounding whitespace or control
  characters. Require an absolute canonical home string, with no repeated slash,
  dot/dot-dot segment or trailing slash (except `/`). Tin Star compares strings
  exactly; it does not normalize, resolve symlinks, build paths or run them.
- Reject malformed JSON, repeated JSON object keys (including escaped aliases),
  unknown schema, missing/ambiguous fields, extra fields, duplicate `(fm_home,
  task_id)` entries (even with different generations), oversized items/records,
  or more than 100 items. These checks prevent silent identity replacement,
  ambiguous joins and unbounded parsing, rather than restricting configured homes.
- A truncated or unreadable rich-text item is unknown. Never discard it and parse
  the remaining items as a complete record.

## Classification

All configured source cards participate before any display filter. Only a fresh,
complete home snapshot establishes a currently observed match. Notion reads must
be current with complete card pagination; an unrelated truncated Parent/Sub-item
relation can suppress absence checks without invalidating a fully read positive
worker declaration. All findings remain scoped to configured sources. Positive contradictions (such
as two primary declarations or multiple freshly observed attempts) still surface
for investigation when absence coverage is incomplete; missing generation evidence
alone stays unknown.

| Observation | Tin Star result |
| --- | --- |
| Valid declaration + exact observed home/task/spawn | Confirmed explicit claim; normal connection in the existing gutter. No worker-side link metadata required. |
| Valid declaration + unavailable, stale, partial or unconfigured home | Last-known claim and unknown/unavailable diagnostic; no broken-link or absence conclusion, no deletion or invented worker. |
| Observed executing worker without a declaration + positive Notion-origin evidence | Investigation candidate (`untracked-worker`) only with complete fresh sources and readable declarations; never automatically assigned. |
| Independent/ad hoc worker without a declaration | Legitimately unlinked; no orphan finding. |
| Declared task absent from a complete fresh home | Unverified declared relationship with an investigation diagnostic; never switch to a similarly named worker. |
| Same worker on two primary cards, multiple observed attempts with the same ID, or different spawn evidence | Conflicting claims; request First Mate investigation. Hidden/Done cards still participate in duplicate detection. |
| Done/archived card or changed Owner with a declared relationship | Historical claim retained. Card status/ownership alone is not an identity conflict. Operational expectations are evaluated separately. |
| Notion missing, inaccessible, stale, expired or incomplete card pagination | Unknown/last-known; no confirmation or absence-based mismatch claims. Declaration availability follows the [property format rules](#property-format). |
| Legacy `work_item`, `notion_page_id`, URL, or equal-title hint | Candidate/corroboration only; cannot create a confirmed assignment. |

A changed generation is not automatically a new task, but the available snapshot
contract does not publish positive continuity evidence. Tin Star therefore
surfaces differing spawn evidence for investigation. The responsible First Mate
must verify a relaunch or handoff from durable evidence before maintaining or
correcting the Notion entry. Merely seeing the same task ID, title, or changed
metadata is not continuity proof. Backfill remains a read-only proposal; no automatic repair runs here.

## Display and operation

Confirmed current claims feed the existing Overview gutter. Relationship details,
source field paths, timestamps, last-known/historical states, invalid records and
conflicts appear in the existing Inspector's **Evidence & diagnostics**. Source
health stays in the existing diagnostics surface. Task cards carry no relationship
debug text. Filters cannot remove source declarations or manufacture orphans.
Worker classifications are presentation derived from linked cards, not copied
worker attributes.

The bounded in-memory claim history is presentation history, not an assignment
database: older relationships expire after 24 hours/2,000 prior claims and reset
on server restart. Notion declarations survive restart, including unavailable
workers. Tin Star cannot certify whole-farm absence from configured sources.

## First Mate workflow

Only the responsible First Mate coordinator writes the field, serializing edits
per card. Second mates report changes through their supervision channel to that
coordinator. PM Bot may nudge for accountability but does not own worker linkage.

1. **Pickup:** Read the canonical Notion page, verify current Owner/Status and
   identify the responsible First Mate home. Plan the primary card association
   for Notion-originated work before dispatch; confirm the property and snapshot
   identity contract.
2. **Dispatch:** As soon as the real worker exists, obtain its exact home, task ID
   and generation from the authorized snapshot. Immediately merge its identity
   into the versioned First Mate tasks record and read back to confirm all entries.
   Do not wait for scheduled check-in or use the PR/Jira Link field. Each worker
   has at most one primary card; a card may contain several workers.
3. **Relaunch/handoff:** Verify continuity from First Mate durable evidence before
   maintaining or correcting the association. Preserve same-logical-task links;
   change home/task references only for proven moves. Missing snapshots do not
   mean retirement. Investigate reused IDs, competing cards and different spawn
   evidence; never refresh an anchor just to clear a diagnostic. Preserve the
   verified disposition in durable records and the Notion audit trail.
4. **Scheduled check-in:** During the existing substantive card check-in, compare
   declarations with actual assignments as a backstop. Repair only proven
   divergence and record ambiguities. Keep progress/outcome assessment separate.
   Retain the four-working-hour / next-business-morning ceiling and meaningful
   evidence rules. Link maintenance never advances Next check-in, clears overdue
   commitments or erases missed checkpoints.
5. **Completion:** Record outcome/status under existing board rules and retain
   historical links, even when finished workers leave the active floor. Change or
   remove declarations only for verified reassignment or duplicate error, with a
   meaningful audit explanation. Done/archived status or Owner changes alone do
not invalidate identity.
6. **Ad hoc work:** Intentionally independent work may have no primary card.
   Escalate an omitted association only with positive evidence of Notion origin.

Use fresh read–merge–write–readback, validating the complete property and merging
by exact `(fm_home, task_id)`. Preserve every unrelated worker entry and Notion
property. Missing/unreadable/truncated text is unknown; never replace it as empty.
If readback differs, reconcile the competing writer before a bounded retry, then
surface unresolved conflicts. Never let multiple homes race to rewrite a card.
This sequence does not provide atomic compare-and-swap guarantees. Link creation,
reconciliation, nudge delivery, worker activity and routine edits are not milestone
completion and must not create Will-action tags.

## Live integration evidence

Slice A shipped in https://github.com/except-pass/tinstar/pull/286. The coordinating
First Mate subsequently wrote real declarations on three cards (four worker links) and confirmed them
in Tin Star. Tin Star performs neither property creation nor link writes.
Slice B adds report-only backfill; the responsible First Mate must perform and
record live verification/writes. Automated tests do not substitute for that proof.
The local nudge bridge and optional decision model remain later slices.

## Slice B: backfill and deterministic mismatch report

`GET /api/reconciliation/worker-links/report` returns the usual `{ok, data}`
envelope. It requires the same private peer, allowed origin (when supplied) and
`Authorization: Bearer <mcp-token>` as the MCP endpoint. The token lives in the
server's config home. The authenticated MCP read tool `get_worker_link_report`
returns the same report directly, without needing an open UI window. Both read
the configured sources and never write Notion or First Mate state.

Print JSON from a running server, using its config home for authentication:

```sh
npm run --silent worker-links:report -- --server http://127.0.0.1:5292 --config-home /path/to/config-home
```

Or collect once using a local configuration (default: `getConfigRoot()`, including
`TINSTAR_CONFIG_HOME`), without starting a server:

```sh
npm run --silent worker-links:report -- --config-home /path/to/config-home
```

The server form also accepts `--token-file /path/to/mcp-token`. It reads an
existing token; it does not create one. Keep tokens and report artifacts private.
An unavailable source is a successful report containing unknown coverage; a CLI
transport/authentication/configuration argument failure exits nonzero.

The report schema is `tinstar.worker-link-report.v1`, with `mode: report-only`:

| Field | Meaning |
| --- | --- |
| `evaluatedAt` | Input snapshot's `generatedAt`; expiry is evaluated at this timestamp. |
| `coverage` | Notion and each configured home's observation metadata, pagination completeness, card declaration readability/mergeability, and Slice A absence coverage. No whole-farm certification. |
| `homes[].tiers` / `counts` | Exactly six tiers per home: `already confirmed`, `eligible auto-write`, `ambiguous`, `independent`, `conflicts`, `unavailable`. Counts are report rows, not an assertion of total worker coverage. |
| `homes[].tiers.ambiguous[].proposals[]` | Manual verification candidates: exact `cardId`, `fm_home`, `task_id`, `spawn_gen`, supporting `sources`, and categorical `strength`. No raw brief/backlog text. |
| `dispatchProvenance` | `not-collected`: current scene inputs expose no exact durable dispatch binding. `eligible auto-write` remains empty. |
| `merges[]` | One card-wide merge across all homes. `ready-for-verification` includes the complete v1 `record`, exact compact `json`, and the `properties` payload with consecutive rich-text chunks. `size-limit` includes a reason and emits no replacement. |
| `findings[]` | Stable detector rows with Slice A `classification`, sorted card/execution/home identities and the classifier's reason. |

`legacy-metadata` strength means an existing `work_item` or `notion_page_id`
reference. `textual-reference` means an actual Notion URL or explicit `card <id>`
reference found by the existing reconciler in task metadata or matching backlog
text. Sources retain exact field paths, such as `task.work_item`,
`task.backlog.title` or `backlog.raw`. Neither strength is a verified assignment or auto-write authority. A confidence
score, branch/PR or field name claiming dispatch provenance cannot promote either
tier. See [the coordinator writer design](notion-worker-links-writer-design.md)
for the missing exact-provenance input and future authority boundary.
Title equality alone produces no proposal. Competing references, missing identity
or generation, multiple observed attempts, inactive workers, secondmate manager rows, stale/partial
homes, unreadable declarations and Done/archived/trashed cards produce no proposal.
An existing declaration on any card suppresses proposals for that home/task.
Current, paginated Notion reads are required; an unrelated partial relation does
not invalidate a fully read positive reference or declaration.

The dry-run tiers cover currently operational workers/cards. Finished workers
and Done/archived/trashed cards are excluded from backfill; declarations naming
absent workers remain investigation or coverage rows, and historical links still
appear in the detector report. An unavailable home with no cached
inventory emits one `kind: home` coverage row with null task/generation, rather
than inventing workers or a zero-worker assertion. Other rows identify an
observed worker or a declared-but-unobserved task. Positive contradictions retain
the conflicts tier even when unrelated coverage is unavailable. Existing exact
fresh declarations enter `already confirmed`; legacy/textual/title candidates
enter `ambiguous`; no operational Notion provenance enters `independent` only
with current sources. The report does not mint durable dispatch receipts.

Merges are manual verification aids for ambiguous candidates, never auto-write
instructions. They preserve all existing declarations and add all proposed workers for that
card, sorted by home/task. Missing, wrong-type, truncated, unreadable and invalid
properties cannot be replaced as empty. Explicit `tasks: []` is mergeable. A fully
read rich-text property is mergeable when the wire reader classified it blank:
unknown, with reason "Blank property is unlinked", and the property is not
truncated. The report uses that classification. It does not re-parse the display
text, because `parseWorkerLinks` still rejects blank text as malformed JSON.
The property classification remains as described in [Property format](#property-format).
The whole merge must fit 200,000 characters and 100 items of at most 2,000
characters each; there is no truncation or partial replacement.

Detector codes are `duplicate-primary`, `spawn-evidence` (different generations
or multiple attempts requiring continuity/ID-reuse investigation, including
freshly observed generations without any Notion declaration or card reference),
`declared-absent`, `historical-link`, `invalid-record`, `duplicate-execution`,
and `unknown-coverage`. Other rows retain their Slice A finding kind as the
detector, including confirmed links, legacy candidates (`unverified-conflicting`),
untracked workers and execution gaps. The report labels existing findings; it does
not implement another classifier. Positive contradictions remain visible with
partial coverage. Absence requires a complete fresh accountable home and current
Notion pagination. Offline/stale/unconfigured homes, stale Notion and unreadable
declarations stay unknown. Historical links are retained, not repair requests;
invalid cached records are accompanied by source freshness in coverage.

Saved identical inputs produce byte-identical reports. All rows and nested
identity/source lists are sorted with ordinary string comparison. No current
wall clock or in-memory relationship history participates. `evaluatedAt` and
source observation timestamps naturally change when a new snapshot is collected.

## First Mate backfill verification

1. Capture a fresh report and retain it as the proposal audit artifact. Review
   source freshness, card status/ownership and every supporting source field.
   Unknown coverage is not an absent worker or an assignment to repair.
2. The responsible coordinating First Mate verifies **each** proposed pair
   against that home's durable task record: exact home/task/generation, Notion
   origin and intended primary card, including any relaunch or ID-reuse evidence.
   Reject ambiguous candidates and investigate competing declarations separately.
3. Re-read the complete Notion property immediately before writing. Merge the
   verified proposals with that latest record, preserving unrelated workers.
   The emitted merge is a review/paste aid, not permission to overwrite newer
   declarations. If only some proposals were verified, rebuild the merge with
   only that verified subset. Serialize edits through one coordinator per card.
4. First Mate writes the merged `tinstar.fm-links.v1` property, then reads all
   rich-text items back, concatenates and validates the complete record. Compare
   all entries and the generation anchors; investigate differences before retry.
5. After ordinary Tin Star source refresh, confirm the intended pairs appear as
   confirmed explicit claims. Retain the original proposal, durable verification,
   Notion readback and refreshed claim evidence. Demonstrate at least five
   real/controlled existing pairs, including a multi-worker merge, and verify
   unknown sources remain unknown. Automated controlled roundtrip tests exercise
   five pairs; they do not claim coordinator validation or live Notion writes.

This report performs no nudge, write, auto-repair, decision-model call, task-card
text edit, progress update or checkpoint change.
