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
Work fields are Task Status, Task Owner, Priority, Next check-in, Due Date,
Last edited, Area and Sub-area. Initiative and Epic are unavailable until the
board has explicit properties; parent chains never establish either.
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

The existing Desk and card designs remain in this slice. The [queue reference](reconciliation-queue.md)
owns readiness, source identity and per-source response controls. Inspecting
and regrouping retain queue identity. Worker terminal links use the exact-home
resolver and open the safe viewer separately.

Clicks and authenticated MCP use the same reducer. The [MCP reference](reconciliation-mcp.md#tools-and-authority)
owns semantic actions, targeting and browser acknowledgments. Grouping/filtering
never edits Notion or First Mate, launches workers, or changes relationship truth.

For a private development preview, build with `npm run build:all` and run the
standalone backend with an isolated `TINSTAR_CONFIG_HOME`, explicit loopback host
and preview port. Source access failures remain visible; they are never treated
as an empty board. See the [source configuration reference](reconciliation-floor.md#run-and-configure).
