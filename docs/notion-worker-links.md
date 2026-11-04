# Notion-owned worker links

Notion declares the primary task association. First Mate owns worker identity,
execution state and location. Tin Star reads both sources, compares identities,
and displays the relationship and evidence; it never writes assignments or
executes a path/command from a Notion field. No First Mate patch or spawn CLI
flag is required. A worker may have one primary card; a card may have many
workers. Independent/ad hoc workers may have no card.

## Property format

The existing board property is named exactly **First Mate tasks**, with type
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
association. Blank text is invalid JSON; writers should use the explicit empty
record when that is what they mean.

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
worker declaration. All findings remain scoped to configured sources.

| Observation | Tin Star result |
| --- | --- |
| Valid declaration + exact observed home/task/spawn | Confirmed explicit claim; normal connection in the existing gutter. No worker-side link metadata required. |
| Valid declaration + unavailable, stale, partial or unconfigured home | Last-known claim and unknown/unavailable diagnostic; no broken-link or absence conclusion, no deletion or invented worker. |
| Observed executing worker without a declaration + positive Notion-origin evidence | Investigation candidate (`untracked-worker`) only with complete fresh sources and readable declarations; never automatically assigned. |
| Independent/ad hoc worker without a declaration | Legitimately unlinked; no orphan finding. |
| Declared task absent from a complete fresh home | Unverified declared relationship with an investigation diagnostic; never switch to a similarly named worker. |
| Same worker on two primary cards, multiple observed attempts with the same ID, or different spawn evidence | Conflicting claims; request First Mate investigation. Hidden/Done cards still participate in duplicate detection. |
| Done/archived card or changed Owner with a declared relationship | Historical claim retained. Card status/ownership alone is not an identity conflict. Operational expectations are evaluated separately. |
| Notion missing, inaccessible, stale, expired or incomplete card pagination | Unknown/last-known; no confirmation or absence-based mismatch claims. A missing/unreadable/invalid declaration also suppresses absence claims. |
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

First Mate pickup/dispatch/check-in/completion instructions must preserve existing
board rules and serialize writes per card. Use fresh read–merge–write–readback;
retain all other worker entries and unrelated properties, bound retries and
surface conflicts. Do not claim atomic compare-and-swap guarantees from that
sequence. Link maintenance is not progress: it must not reset Next check-in,
clear overdue commitments, or create Will-action tags.

Slice A requires an operator-owned real property/link write and a sanitized
readback plus a screenshot of a confirmed gutter edge after ordinary source
refresh. The owner/PM Bot creates the property; First Mate writes and verifies
the real active worker reference. Tin Star performs neither operation. Fixture
proof and automated tests do not substitute for that real integration evidence.
The local nudge bridge, broad backfill, and optional decision model are later
slices and are not implemented here.
