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
whether clicking opens or closes their own relationship. Direct tasks can be
temporarily revealed under the scope rules below. Opening a relationship reopens only
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

Workers precede cards in the status donuts, selected-status chips, Inspector
group summaries and connection pairs,
matching the floor's left-to-right column order.
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

Without explicit donut or search predicates, Operational retains independent and
unmatched endpoints and its intentional hidden-task labels. Opening a relationship can
reveal direct tasks through the base status scope; it never overrides explicit
donut or search predicates. Selecting a Smart Search suggestion uses the temporary
reveal described below. Filtering never changes claim evidence or absence findings.
Both donuts and the floor use the same canonical projection and presentation
reducer; selections and organizer overrides persist in the existing browser
preferences. Source refreshes recompute candidates from the current graph. The compact
refresh icon beside Search runs the existing scene read without changing the view.
Its hover/focus label reports refreshing/failure state and the last complete
successful sync; incomplete or failed attempts retain the previous timestamp.
Automatic polling and browser-focus refresh follow the [shared refresh contract](reconciliation-floor.md#floor-ui-s3).

Available Worker fields are Manager, Machine, Worker status and Last activity.
Work fields are Initiative, Epic, Task Status, Task Owner, Priority, Next check-in,
Due Date, Last edited, Area and Sub-area. Initiative and Epic use only explicit
Notion properties named exactly Initiative and Epic: canonical IDs for relations,
option values for select, and text for rich_text. Missing properties place tasks
in Unassigned / Unknown; parent chains never establish either. Initiative search
options and matching use this same explicit-property contract.
The initial and Reset organizer uses the By Initiative preset. Explicitly saved browser choices take precedence
on reload.

Only explicit, non-conflicting canonical page-ID links carry endpoints between
groups. Textual/equal-title candidates remain diagnostics. Multiple references
retain one canonical entity ID. Each group and the headline deduplicate counts.
Independent workers/tasks retain Unassigned / Unknown membership. A missing or
hidden task never removes a current worker when no explicit donut or search
predicates apply. Finished/offline workers stay in
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
records. Organizer and status preferences and shared presentation selection persist in browser-local storage;
window credentials and transient cues do not. Separate open windows
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

Unknown workers and unverified links under incomplete coverage are explained
once in Source health for the unique cards in the current view. They do not
contribute to exception totals or add relationship warning badges to task rows.
Positive conflicting worker evidence is counted separately and remains available
in each card's Evidence & diagnostics. Confirmed worker facts remain on task rows.

Expanded and Detailed worker cards show an identity avatar, title and a consistently placed worker status at the top right. Confirmed linked
tasks supply the Initiative / Epic breadcrumb; independent workers have none.
Machine and the manager/home tag follow the title; activity and age share a
divided footer. Last activity uses the [Codex log timestamp](codex-activity.md)
when available, otherwise the status-report timestamp, for display, grouping
and sorting. Status-report ages remain independent of log activity. Observation freshness is a separate
Last known signal; retained status follows the same event/state precedence as
[liveness](reconciliation-floor.md#floor-ui-s3). Secondary linked counterparts in
[Smart Search](#smart-search-core) never represent execution status.

Expanded and Detailed task cards keep the same field order in every grouping: Initiative / Epic
breadcrumb and top-right Priority, two-line title, then a status dot and
Notion Status opposite Owner. Next check-in and edit age share a divided footer;
Last touched by is available on the edit-age tooltip and in Inspector. Contextual
Due Date, Waiting For and Will action follow when applicable. Relationship evidence belongs in the gutter and diagnostics.
Check-ins are accountability checkpoints, independent of Due Date and edit age.
Done, Archived, Backlog, Todo, Not started, Planned and Spare tokens display
Not applicable; other statuses distinguish missing, upcoming, overdue and
invalid checkpoints using the calendar rules above.

Task and worker headers carry an Inspect panel icon in both densities, including
collapsed rows. It opens the separate Inspector while Your desk remains available.
For swipe entry, see the shared [Ask/Inspector gesture contract](ask.md).
Clicking
the row or card body in either view expands or collapses it. The Inspector exposes metadata, related records, connection
and activity history, evidence and safe source links. Next to Open Notion card, Copy link
copies that card's URL. Task prose loads on demand;
partial content labels omissions and unavailable content offers the source link.
Worker terminal links use the exact-home resolver and open the safe viewer
separately. Closing the Inspector restores focus to the floor card.

The [Ask reference](ask.md) owns the Desk inbox layout, question submission,
answers and history. The [queue reference](reconciliation-queue.md) owns
operational request visibility, readiness, source identity and per-source response controls.
Clicking a Desk card navigates by canonical task ID without opening the Inspector
or moving the queue position: it expands the required groups and can reveal the
card through base status, search and donut exclusions using a temporary exception
for that card only, then scrolls and focuses the first matching floor
reference deterministically, then flashes the card and its current confirmed
explicit worker connections. A persistent highlight and navigation reveal remain
after the flash. Another Desk target replaces the reveal; changing or clearing
search, restoring the search view, or Reset clears it. Saved grouping, order,
search and status choices stay intact during navigation. If the card is missing
from the current scene, the Desk reports that it is not on the floor and offers that clicked card's own
Notion link. Navigation never answers, dismisses or writes a source record;
Answer/Dismiss remain separate explicit controls. The [Ask reference](ask.md)
owns mobile conversation navigation; reduced motion uses static highlighting.

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

Smart Search opens a compact palette beside Search in the existing 48px toolbar
with Cmd/Ctrl+K. It starts empty; typing shows at most eight suggestions with a
name, entity type and short context. Find retains multi-token text, literal quoted
phrases, prefixes and Fuse.js typo matching. Ranking is exact identifier → exact
name/title → title prefix → text relevance → fuzzy. Short numeric/technical IDs
never drift into neighboring IDs. Machines, managers and explicit Initiatives
are named suggestions derived from the same authorized scene; PR matches keep
their original card/worker target.

Typing leaves Overview unchanged. Arrows/Enter or pointer/touch select a result,
close the palette and filter to the seed plus its direct verified neighbors in
the existing Workers-left / Tasks-right graph. Unrelated rows are hidden; linked
counterparts have a secondary, dashed appearance. The real SVG gutter and compact
row density remain; no recursive fan-out or text-inferred connection is added. An
outside-view result can temporarily reveal planned work hidden by roadmap
visibility. Clear search focus restores organizer, scope, donuts, density,
expansions, scroll and selection. Escape first closes an open palette, then clears
focus. Mobile Back dismisses the same transient layers. Focus and its restoration
snapshot survive section switches within the application; Clear or Escape after
returning restores Overview without navigating back to another section. Search
rewinds browser history only while the current entry belongs to that search
session. Focus is not saved across reloads.

The horizontal Pattern Dial shares the toolbar between Search and the two
Workers/Cards status donuts. Its circular order is All → Stalled → Blocked →
Needs me → Unstaffed → Mismatch → Stale → Active. Click a neighbor, swipe sideways,
scroll the wheel or trackpad, or use Left/Right on the dial to move one detent.
With the pattern list closed, the page does not scroll while the pointer is over
the dial. One notch or scroll step moves one pattern; small trackpad movements
accumulate before the first step. Within a pixel-scroll burst, decreasing deltas
are suppressed after that step, while equal or increasing deltas keep turning
the dial. A direction change or about 200 ms of silence starts a new burst.
Hold the dial for about half a second, or press Enter or Alt+Down, to open every
pattern in that order with the same counts and reminders. Arrows move in the list,
Enter selects one, and Escape closes it and returns focus to the dial. Moving more
than a few pixels cancels the hold, so a swipe still turns one detent and a short
click still selects a neighbor or pins the center reminder.
Picking any detent, including All, clears temporary search focus and its restore
session. All also clears the pattern; other search/facet, donut and base-scope
conditions remain. Pattern selection uses the existing search-filter reducer and persists
with the ordinary view preferences. Non-matches are hidden. Matches retain only
their direct linked counterparts as secondary context; uncertain cards stay
visible. One line above the list counts unchecked cards and names the missing
evidence. Cards show known worker facts in their existing metadata, such as
Worker running or Worker state unknown (codex pane); a wait's report age is
shown only when the published event reports that same state.
No worker requires a supported per-card execution-gap finding and fresh source
coverage. Fresh configured homes alone do not establish absence on an unknown
home; when absence remains unknown, the card omits that fact.
An empty result names the selected pattern, for example No blocked work. See the
[shared execution-health contract](#shared-execution-health-contract) for pattern
evidence requirements.

Center and neighbor counts preview unique matching work under the other filters,
ignoring the dial's current pattern. They are overlapping predicates, not pie
slices. `?` means insufficient evidence; `N+` means N confirmed matches with
incomplete coverage. No unpublished signal is treated as zero. Hover/focus the
center for a delayed reminder; tap to pin/unpin it. Outside/Escape dismisses the
reminder without clearing the pattern. The tooltip takes precedence over graph
focus dismissal, while an open search palette closes first. At narrow widths the
single toolbar scrolls horizontally; the centered pattern stays legible and its
neighbors retain touch targets.

An unrelated stale home does not make conclusive visible predicates unknown.
Home coverage still matters when worker filters, text search or machine/manager/entity
facets can hide cards. The reminder names unavailable evidence classes and home paths.

Search and patterns are read-only and never send Ask requests or change Notion,
assignment or execution state.

### Index and source coverage

`searchDocuments.ts` projects authorized scene records into allowlisted fields.
`SearchDocumentCollector` adds safe card prose through the existing bounded Notion
reader, up to four cards per 20-second refresh in the background. Scene responses
never wait for those reads. Prose is cached by canonical ID and Notion edit revision;
a changed revision invalidates the prose-reader TTL. Changed revisions and expired observations fall back to searchable metadata
while prose retries with the ordinary source budget. The browser also drops
expired body fields if its scene refresh fails. Removed authorized
IDs are deleted from the returned index. Pending/partial/unsupported content retains source coverage in the index;
ordinary search shows bounded suggestions without a diagnostics panel. A no-hit
message refers only to available records.

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
Original-text highlight offsets are computed lazily when a suggestion's ranges
are read, with literal field maps reused and fuzzy maps limited to matching words.
Index construction and graph filtering do not segment every excerpt or vocabulary
word. The bounded 150-card / 30-worker prose regression in
[`smartSearch.test.ts`](../../src/reconciliation/__tests__/smartSearch.test.ts)
checks cold construction relative to a short-prose baseline on the same cards,
using the median of five baseline builds to limit scheduling noise. Unicode and
exact-identifier offset tests remain in that suite.

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
`null` for unavailable runnable/resolver evidence and unpublished progress time, and per-pattern
`match`, `no-match` or `unavailable` plus concrete evidence and a reason. Null never means zero.
Health uses the shared current-activity classification: fresh crew-state
(`run-step` or `pane`) and the [Codex turn fallback](codex-activity.md). Historical
status verbs and endpoint existence do not prove current activity. Floor badge
liveness follows the [liveness contract](reconciliation-floor.md#floor-ui-s3).
This feature implements no recovery, watchdog or scheduling behavior.

The inspectable builtin definitions live in `patternDefinitions`:

| Pattern | Required evidence / current behavior |
|---|---|
| Active | In Progress plus a fresh verified running or runnable path. Missing evidence stays unknown. |
| Blocked | Fresh, complete Notion evidence with status Waiting For and a nonempty Waiting For field; worker freshness is not required for that Notion state. An In Progress card with Waiting For and a verified waiting worker or published blocker also matches. Done/Archived never match. Legitimate waiting is not called deadlock. |
| Unstaffed | In Progress, no verified assigned worker, and complete configured source/link coverage with explicit accountability. Missing/blank links or stale/partial homes are unknown. |
| Needs my decision | Explicit Notion Will action or structured needs-decision request from a verified worker. Never inferred from prose. |
| Stalled | In Progress with assigned verified workers and complete fresh running, runnable and resolver zeros; unknown coverage stays unavailable. Done/Archived, explicit Waiting For or a positive running/runnable/resolver path rules it out. |
| Idle workers | Requires no runnable assignment and distinction from intentional waits/terminal history. Unavailable because assignment availability is unpublished. |
| State mismatch | Requires lifecycle disagreement after excluding tracked continuations. Unavailable because continuation coverage is unpublished. |
| Stale | Requires a meaningful-progress timestamp and an inspected threshold. Unavailable because progress time is unpublished; heartbeat/check-in/edit age is not substituted. |

The dial exposes missing evidence through unknown counts and the reminder,
without disabled buttons or an additional patterns menu. Multiple blocked workers
retain one Work cluster and deduplicated blocker identifiers. Detailed evidence
remains in the shared health projection for tests and consumers; it is not a
second results inventory. Readiness is projected read-only from each configured home's existing snapshot:
queued, unheld, non-captain-actionable backlog rows with an explicit empty
`unresolved_blocker_ids` list are runnable only when no observed execution is
working or has unknown activity. Accountable rows come from confirmed
current explicit links; card references alone never join.
Distinct named blockers and explicit Origin continuations can supply runnable
paths; their fresh working executions instead supply active resolvers.
Blockers and continuations join only within the same home/task identity.
Missing blocker rows, candidates with unresolved dependencies, and continuation
paths beyond the directly inspected candidates leave coverage unknown. A complete fresh
backlog census and known candidate activity are required to prove zero;
missing lists, incomplete inventories and stale/failed home reads remain null.
