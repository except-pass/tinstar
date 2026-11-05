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
metadata is not continuity proof. No backfill or automatic repair runs here.

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

The owner has created the board property. The responsible First Mate writes and
verifies real active worker references. Keep live property feasibility/round-trip
evidence, sanitized Notion readback and a screenshot of a confirmed gutter edge
after ordinary source refresh on the owning card.
Tin Star performs neither property creation nor link writes. Fixture proof and
automated tests do not substitute for live integration evidence.
The local nudge bridge, broad backfill, and optional decision model are later
slices and are not implemented here.
