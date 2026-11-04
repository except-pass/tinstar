# Overview

Tin Star's primary home follows the [operational shared-floor prototype](../design/tinstar-operational/prototype.html).
The reference contains illustrative data only. Production reads the configured
Notion and First Mate sources and never substitutes fixture records.

Workers and Notion tasks render as independent stacks inside shared groups,
with links in the gutter. A compact toolbar controls both columns:

- Outer groups by one field; Inner optionally subdivides it.
- Order sorts both stacks ascending or descending, with deterministic ID ties
  and blanks last. Task fields carry linked workers and worker fields carry
  linked tasks. Counterpart ordering uses the earliest value ascending or latest
  descending among links in that subdivision.
- Filters contains status checkboxes plus the existing gap and connection controls.
- Fields reveals draggable chips; click a chip and choose a slot, or use the
  keyboard-accessible toolbar selects. Reset restores the default view.

Available Worker fields are Manager, Machine, Worker status and Last activity.
Work fields are Initiative, Epic, Task Status, Task Owner, Priority, Next check-in,
Due Date, Last edited, Area and Sub-area. Initiative and Epic use only explicit
Notion properties named exactly Initiative and Epic: canonical IDs for relations,
option values for select, and text for rich_text. Missing properties place tasks
in Unassigned / Unknown; parent chains never establish either.
The initial organizer uses Task Status, no Inner, and Next check-in ascending.

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
reads retain last-known data and suppress absence conclusions. Worker counts
label unavailable or last-known observations when coverage is insufficient.

Worker cards show an identity avatar, title and a consistently placed Running,
Waiting, Blocked, Finished or Unknown status, followed by Machine, Manager,
activity and human-readable activity age. Observation freshness is a separate
Last known signal; retained status follows the same event/state precedence as
[liveness](reconciliation-floor.md#floor-ui-s3). An absent endpoint displays
Unknown, not Finished. Selection and relationships never fade whole cards or
serve as execution status.

Task cards keep the same field order in every grouping: Initiative / Epic
breadcrumb, two-line title, Notion Status, Owner, Next check-in, edit age,
Last touched by, Priority when set, then contextual Due Date, Waiting For and
Will action. Relationship evidence belongs in the gutter and diagnostics.
Check-ins are accountability checkpoints, independent of Due Date and edit age.
Done, Archived, Backlog, Todo, Not started, Planned and Spare tokens display
Not applicable; other statuses distinguish missing, upcoming, overdue and
invalid checkpoints using the calendar rules above.

Click a floor worker or task to open the separate Inspector while Your desk
remains available. The Inspector exposes metadata, related records, connection
and activity history, evidence and safe source links. Task prose loads on demand;
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

Clicks and authenticated MCP use the same reducer. The [MCP reference](reconciliation-mcp.md#tools-and-authority)
owns semantic actions, targeting and browser acknowledgments. Grouping/filtering
never edits Notion or First Mate, launches workers, or changes relationship truth.

For a private development preview, build with `npm run build:all` and run the
standalone backend with an isolated `TINSTAR_CONFIG_HOME`, explicit loopback host
and preview port. Source access failures remain visible; they are never treated
as an empty board. See the [source configuration reference](reconciliation-floor.md#run-and-configure).
