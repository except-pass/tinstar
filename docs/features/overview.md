# Overview

Tin Star's primary home follows the [operational shared-floor prototype](../design/tinstar-operational/prototype.html).
The reference contains illustrative data only. Production reads the configured
Notion and First Mate sources and never substitutes fixture records.

Overview defaults to **Ultra Compact**: 29px collapsed rows, 25px outer
headers and 21px inner headers. Workers stay on the left and Notion tasks on
the right, with real confirmed relationships in a dedicated gutter. Each
canonical endpoint renders once across compact groups; reference badges name
its other memberships. Unmatched records and unavailable sources keep their
coverage labels. Customize offers **Detailed** for the original rich cards
and Inspector interaction. Density persists across reloads in browser storage.
Both columns remain side by side on narrow screens using horizontal scrolling.

In Ultra Compact, click a row or press Enter/Space to open that relationship:
the selected endpoint and all directly confirmed current counterparts expand
inline. Expansion is one hop; it never recursively opens a connected component.
Several relationship roots can remain open. Click a root again to close it;
a counterpart shared by another open root stays expanded. Expanded rows label
whether clicking opens or closes their own relationship. Direct tasks hidden
by a status filter are temporarily revealed. Opening a relationship reopens only
groups containing that root or its immediate counterparts; previously opened
relationships do not reopen groups you collapsed. Sorting and grouping retain
expansion by canonical ID.
Truncated text has a full title tooltip and a visible keyboard-focus tooltip;
expanded titles and metadata wrap. Connectors follow measured anchors after
expansion, sorting, filtering, group collapse, scrolling and resizing.
Nested groups use an outer field label and deduplicated worker/task counts,
with compact worker/task counts on each violet inner band. One 48px toolbar
starts the floor immediately below it, without a separate title or controls row.

| Preset | Outer | Inner | Order |
| --- | --- | --- | --- |
| By Initiative (default) | Initiative, alphabetical | Manager, alphabetical | Operational status |
| By Machine | Machine, alphabetical | Initiative, alphabetical | Operational status |
| By Manager | Manager, configured hierarchy then alphabetical | Initiative, alphabetical | Operational status |

Configured parent-home relationships establish manager ancestry; names and task
Owner never imply hierarchy. Unknown/Unassigned groups sort last. Each preset
replaces the organizer slots and direction only; status selections, base scope,
density and unrelated filter choices survive. Browser-local organizer settings
remain authoritative on reload. Customize can override any slot, and closes
without discarding edits. It exposes Outer, Inner, Order, direction, density,
Operational/All cards/Custom, Filters (status checkboxes, gaps and links), Fields
(draggable chips or keyboard slot controls), and Reset in a temporary popover.
Operational status is available only in Order, not as a grouping field or Fields chip.
Escape closes the popover and restores its trigger's focus.

The authoritative worker and card attention orders, exact source labels and
unknown-state handling live in [`floorStatus.ts`](../../src/shared/floorStatus.ts).
The worker projection preserves observation/event precedence and exposes additional
publisher states only when otherwise unknown; history remains separate.
Within the same status, Next check-in ascending, display
name and canonical ID settle ties. Worker check-in ties use the earliest linked
card checkpoint in that subdivision. In both densities and under every preset,
tasks follow the mean row position of their visible workers with explicit,
confirmed, current links within each rendered group. Equal positions use the
chosen Order then stable identity; tasks without such a link follow linked tasks
in Order. Operational status and its tie-breakers remain the secondary task
ordering within each position. This preserves the shared floor's crossing
reduction. This is presentation ordering only.

The two labelled status donuts use unique canonical current endpoints from the
base scope. Activate a slice with click, Enter or Space to toggle it; text status
menus expose the same choices and counts. Multiple selections within one donut
are OR; selections across donuts are AND. A card selection shows matching cards
and only their confirmed linked workers; a worker selection shows matching
workers and only their confirmed linked cards. With both selected, only matching
endpoints on valid current explicit confirmed links survive. Candidate,
conflicting, historical and unavailable-endpoint references never supply links.

Each donut's eligible distribution ignores its own selections and applies the
opposite donut's selections, so other eligible statuses stay selectable. The
labels show visible/eligible unique counts; column counts show the filtered
unique nodes, independent of repeated group memberships. Selected statuses with
zero candidates remain removable in the menu and inline chips. Clear is always
in the toolbar and clears only these explicit selections, restoring the saved
base scope and organizer. No filter-summary row is added. Empty results are
labelled, and source health remains available from the toolbar indicator.
Counts retain partial/last-known labels; an unavailable or uncertain empty worker
scope displays unknown rather than asserting a verified zero.

Without explicit donut selections, Operational retains independent and unmatched
endpoints and its intentional hidden-task labels. Opening a relationship can
reveal direct tasks through the base status scope; it never overrides explicit
donut selections. Filtering never changes claim evidence or absence findings.
Both donuts and the floor use the same canonical projection and presentation
reducer; selections and organizer overrides persist in the existing browser
preferences. Source refreshes recompute candidates from the current graph.

Available Worker fields are Manager, Machine, Worker status and Last activity.
Work fields are Initiative, Epic, Task Status, Task Owner, Priority, Next check-in,
Due Date, Last edited, Area and Sub-area. Initiative and Epic use only explicit
Notion properties named exactly Initiative and Epic: canonical IDs for relations,
option values for select, and text for rich_text. Missing properties place tasks
in Unassigned / Unknown; parent chains never establish either.
The initial and Reset organizer uses the By Initiative preset. Explicitly saved browser choices take precedence
on reload.

Only explicit, non-conflicting canonical page-ID links carry endpoints between
groups. Textual/equal-title candidates remain diagnostics. Multiple references
retain one canonical entity ID. Each group and the headline deduplicate counts.
Independent workers/tasks retain Unassigned / Unknown membership. A missing or
hidden task never removes a current worker. Finished/offline workers stay in
expandable history, including last-known final reports after source expiry.

Date groups use America/New_York calendar buckets: Overdue, Today, Tomorrow,
This week (through Sunday), Later, Not scheduled, plus Unknown for invalid dates.
A timed Next check-in before the current instant is Overdue, including earlier
today. Date-only values use the New York calendar date, including DST boundaries.
Order uses timestamps, never bucket labels or displayed date text.

Operational is the default status preset: In Progress, Queued, Waiting,
Waiting For, Waiting for Prod Release, Ready for Review, In review and
Delegated to person. All cards includes every status (including blank/unknown),
while source-archived/trashed pages remain excluded. Selecting checkboxes enters
Custom. Status choices come from current source schema options and observed
records. Organizer and status preferences persist in browser-local storage;
selection, window credentials and transient cues do not. Separate open windows
retain their own state; reload restores the most recently saved preferences.

Filters affect presentation only. Reconciliation sees the complete authorized
source read; hiding a linked task cannot create an orphan finding. Expired/failed
reads retain last-known data and suppress absence conclusions.

Worker coverage is authoritative only for fresh, complete, unexpired home
observations. When some configured homes remain authoritative, known worker
counts remain visible with a partial-coverage warning; an empty uncertain scope
shows Unknown workers rather than a verified zero. With no authoritative homes,
counts show last known workers, or Workers unavailable when no workers are known.
A failed scene read also makes retained counts last-known. Source health details
name the affected homes and show their observation status, coverage and age.
Refreshing all homes restores ordinary counts and absence labels.

Manager groups scope coverage to their home label. Machine groups use the homes
publishing the workers placed on that machine, including remote placements;
the configured machine name alone does not establish authority. Outer aggregate
headers and Inspector use the same scope as their groups. Unassigned, unmatched
and groups without a manager or machine axis use all configured homes. Partial coverage labels an
unmatched worker relationship Unknown worker instead of asserting No linked
worker; absence conclusions remain suppressed.

Expanded and Detailed worker cards show an identity avatar, title and a consistently placed worker status at the top right. Confirmed linked
tasks supply the Initiative / Epic breadcrumb; independent workers have none.
Machine and the manager/home tag follow the title; activity and age share a
divided footer. Observation freshness is a separate
Last known signal; retained status follows the same event/state precedence as
[liveness](reconciliation-floor.md#floor-ui-s3). An absent endpoint displays
Unknown, not Finished. Selection and relationships never fade whole cards or
serve as execution status.

Expanded and Detailed task cards keep the same field order in every grouping: Initiative / Epic
breadcrumb and top-right Priority, two-line title, then a status dot and
Notion Status opposite Owner. Next check-in and edit age share a divided footer;
Last touched by is available on the edit-age tooltip and in Inspector. Contextual
Due Date, Waiting For and Will action follow when applicable. Relationship evidence belongs in the gutter and diagnostics.
Check-ins are accountability checkpoints, independent of Due Date and edit age.
Done, Archived, Backlog, Todo, Not started, Planned and Spare tokens display
Not applicable; other statuses distinguish missing, upcoming, overdue and
invalid checkpoints using the calendar rules above.

Expanded Detailed cards and expanded Ultra Compact rows carry an Open in Inspector
control that opens the separate Inspector while Your desk remains available. Clicking
the row or card body in either view expands or collapses it. The Inspector exposes metadata, related records, connection
and activity history, evidence and safe source links. Next to Open Notion card, Copy link
copies that card's URL. Task prose loads on demand;
partial content labels omissions and unavailable content offers the source link.
Worker terminal links use the exact-home resolver and open the safe viewer
separately. Closing the Inspector restores focus to the floor card.

Your desk shows a focused ready Notion card and the next few, with conditional
and unverified cards in a secondary section. The [queue reference](reconciliation-queue.md)
owns readiness, source identity and per-source response controls.
Clicking a Desk card navigates by canonical task ID without opening the Inspector
or moving the queue position: it expands the required groups, reveals the card
through saved status filters, scrolls and focuses the first matching floor
reference deterministically, then flashes the card and its current confirmed
explicit worker connections. A persistent highlight and navigation reveal remain
after the flash until another Desk target or Reset. Saved grouping, order and
status choices stay intact. If the card is missing from the current scene, the
Desk reports that it is not on the floor and offers that clicked card's own
Notion link. Navigation never answers, dismisses or writes a source record;
Answer/Dismiss remain separate explicit controls. Mobile Desk navigation returns
to the floor; reduced motion uses static highlighting.

Grouping, filters and authenticated MCP use the same reducer. Compact inline
relationship roots are local to the current window and are not source writes. The [MCP reference](reconciliation-mcp.md#tools-and-authority)
owns semantic actions, targeting and browser acknowledgments. Grouping/filtering
never edits Notion or First Mate, launches workers, or changes relationship truth.

For a private development preview, build with `npm run build:all` and run the
standalone backend with an isolated `TINSTAR_CONFIG_HOME`, explicit loopback host
and preview port. Source access failures remain visible; they are never treated
as an empty board. See the [source configuration reference](reconciliation-floor.md#run-and-configure).

## Smart Search core

Card: [Tin Star: Smart Search — full-text/fuzzy Find, patterns & graph exploration](https://app.notion.com/p/40f50ce6d422816bb1e3df937c779ad2).

Smart Search opens from the existing compact toolbar or Cmd/Ctrl+K. Find supports
multi-token text across fields, literal quoted phrases, prefixes and Fuse.js typo
matching. Ranking is exact identifier → exact name/title → title prefix → text
relevance → fuzzy. Short words and numeric/technical identifiers never use fuzzy
fallback; `0143` does not drift into adjacent IDs. Suggestions show a bounded
highlighted excerpt and the field/source that matched.

Search is another predicate in the existing presentation/status projection.
Text, named patterns and entity/initiative/machine/manager chips compose with AND
on the same verified Work/Worker pair. Existing donut semantics stay OR within
an axis and AND between axes; each histogram ignores its own status selection.
Organizer presets still change only grouping/order; Operational/All/Custom stays
authoritative. Matching seeds retain only direct explicit/current/confirmed
neighbors; context is dimmed, canonical endpoints are counted once and the real
SVG gutter is retained. No transitive component expansion or search-inferred link.

Suggestions include authorized records outside the current view. They are labeled
**Outside current view**; choosing one temporarily reveals its one-hop cluster,
without rewriting the base scope or donut selections. Arrows/Enter choose and
focus a cluster inline. Escape or **Back** restores grouping, sort, filters,
selection, density, expanded relationships and a semantic scroll anchor. **Apply
filters** keeps the lens; **Clear Smart Search** removes its chips while restoring
the underlying scope. Search conditions persist in existing browser preferences;
transient reveal and excerpt text do not. Storage failure falls back to a working
in-memory view. Recent builtin patterns are suggested; saved personal combinations,
deeper pivots/breadcrumbs, URL state and a visual builder belong to the next slice.
Phone search is a temporary viewport-bounded panel, adding no persistent row.
Search does not send Ask requests or change Notion, assignment or execution state.

### Index and source coverage

`searchDocuments.ts` projects authorized scene records into allowlisted fields.
`SearchDocumentCollector` adds safe card prose through the existing bounded Notion
reader, up to four cards per 20-second refresh in the background. Scene responses
never wait for those reads. Prose is cached by canonical ID and Notion edit revision;
a changed revision invalidates the prose-reader TTL. Changed revisions and expired observations fall back to searchable metadata
while prose retries with the ordinary source budget. The browser also drops
expired body fields if its scene refresh fails. Removed authorized
IDs are deleted from the returned index. Pending/partial/unsupported content is
visible in **Index coverage**, rather than being represented as an exhaustive
zero-hit search.

Indexed metadata includes Notion names, IDs, URLs, Status/Owner/Priority/Waiting
For/Initiative/Epic and useful published action/evidence fields; First Mate task
and attempt IDs, worker/manager/machine names, branch and PR URL, current state,
state explanation and bounded published activity/hold/blocker summaries. Known
PR numbers are parsed from published URLs, never used to create relationships.
PR titles/errors are searchable only if present in the collected fields. Comments,
raw logs, transcripts, briefs, files, code blocks and embeds are not indexed.
Card prose exclusions/partial reads inherit the existing reader's ten-request,
four-level and response-size bounds.

Likely credential literals are redacted before new search text reaches the
browser. Excerpt text is capped at 8,192 characters per entity and 2,097,152
characters total; identity/title metadata remains available when excerpt budgets
are exhausted, and omissions are disclosed. Never persist the index in browser
storage. Use the existing configured source/origin authorization; a search match
never authorizes another source or card. The disposable browser index reuses the
existing `fuse.js` dependency (7.3.0 measured at 24,313 minified / 8,435 gzip bytes,
before production tree shaking); no additional database/service or query DSL.
Queries are text plus typed conditions, never arbitrary or model-generated SQL.

The browser normalizes literal fields once, indexes a deduplicated word vocabulary
with postings to original fields, and applies Fuse to that vocabulary. This avoids
running fuzzy scans over every long excerpt per keystroke while preserving literal
phrases, snippets and provenance. Changed documents update their postings; the
small Fuse vocabulary is rebuilt only when its words change. Health queries share
ephemeral canonical-ID joins within each query rather than repeatedly scanning
all cards, findings and workers. Neither index is another scene/source of truth.

The browser incrementally removes/upserts changed semantic document IDs on live
scene refreshes. Clock ticks do not rebuild the index. Missing index data falls
back to scene metadata; an absent cache rebuilds from the current snapshot. Source
failure/expiry retains last-known search hits with freshness labels while absence
and health conclusions are suspended. Search predicates/results are cached only
until the next source observation expiry or new scene, with bounded query caches.

### Shared execution-health contract

`src/shared/workHealth.ts` is a pure view projection for Tin Star and a future
First Mate liveness reconciler. It returns canonical verified worker IDs/count,
running/waiting/terminal/unknown counts, blockers, observation/coverage, explicit
`null` for unpublished runnable/resolver/progress evidence, and per-pattern
`match`, `no-match` or `unavailable` plus concrete evidence. Null never means zero.
The existing liveness precedence and authoritative source/link coverage remain
unchanged. This feature implements no recovery, watchdog or scheduling behavior.

The inspectable builtin definitions live in `patternDefinitions`:

| Pattern | Required evidence / current behavior |
|---|---|
| Active | In Progress plus a fresh verified running path. Missing runnable availability stays unknown. |
| Blocked | Explicit Waiting For plus linked waiting workers or a published tracked blocker. Legitimate waiting is not called deadlock. |
| Unstaffed | In Progress, no verified assigned worker, and complete configured source/link coverage with explicit accountability. Missing/blank links or stale/partial homes are unknown. |
| Needs my decision | Explicit Notion Will action or structured needs-decision request from a verified worker. Never inferred from prose. |
| Stalled | Requires absence of running/runnable paths and an active resolver. Unavailable because runnable/resolver coverage is unpublished; a running neighbor explicitly rules it out. |
| Idle workers | Requires no runnable assignment and distinction from intentional waits/terminal history. Unavailable because assignment availability is unpublished. |
| State mismatch | Requires lifecycle disagreement after excluding tracked continuations. Unavailable because continuation coverage is unpublished. |
| Stale | Requires a meaningful-progress timestamp and an inspected threshold. Unavailable because progress time is unpublished; heartbeat/check-in/edit age is not substituted. |

Unsupported patterns are visibly unavailable with the missing evidence named;
there are no guessed alarms. Multiple blocked workers retain a single Work
cluster and deduplicated blocker identifiers. **Why matched?** lists concrete
Work status, worker states/counts, observation times, link provenance and blocker
identity. No active resolver is claimed without structured source evidence.
