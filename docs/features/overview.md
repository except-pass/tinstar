# Overview

Tin Star's primary home follows [prototype 08](../design/tinstar-v8/prototype-08.html).
Workers and Notion cards render as independent stacks within shared group boundaries.
The existing source readers, reconciliation findings and authenticated MCP broker
remain authoritative. No demo data or local Assist parser enters production.

Initiative and Machine use the scene's union memberships. Manager lists a card
only when a current running or waiting non-manager worker in that home names it
through its own explicit or textual card reference. Equal-title candidates,
standalone backlog mentions and finished, absent or unobserved workers do not
establish Manager card membership. Collapsing workers preserves that membership.
Cross-group
memberships carry a continuation marker and the same semantic identity; headline
counts are deduplicated. Activity and priority sorting coordinate both stacks,
with deterministic ties. Links may be hidden without removing either list.
Gaps only uses confirmed execution gaps on both sides, never filter-created
absence. Expired/failed reads retain last-known data and suppress gap coloring.
Worker counts show unavailable or last-known observations when coverage is insufficient,
and identify workers hidden by collapse or filtering rather than asserting absence.
The second-mate cards in the top command strip retain their worker-count text
and width when toggled with +/−; they do not show a hidden-worker count.
Finished and offline worker records move to expandable history, including last-known final reports after expiry. Waiting and planned cards can be collapsed using the compact Planned control; selecting a hidden counterpart reveals it without changing gap classification.

Overview excludes archived or trashed cards and cards whose Status is missing,
blank, Unknown or Archived (ignoring surrounding whitespace and case). This same
visibility rule applies to card groups, gap targets and the headline Notion-card
count. A known Status remains visible regardless of ownership or execution
expectation; Manager membership still follows the rule above.

One contextual Desk shows the current verified request and the next few. Secondary
requests remain in Later & needs verification. Inspecting and regrouping retain
the queue identity. The [queue reference](reconciliation-queue.md) owns readiness, source identity
and per-source response controls. Card context, evidence, raw source identities and diagnostics are read
on demand in the same panel. Worker terminal links retain the existing exact-home
resolver and open the safe viewer separately.

Clicks and authenticated MCP use the same reducer. The [MCP reference](reconciliation-mcp.md#tools-and-authority) owns semantic action names, wire values, targeting and acknowledgments. No domain-write tool is added.

Development preview (two terminals):

```sh
TINSTAR_TELEMETRY=0 TINSTAR_CONFIG_HOME=/private/config node --import tsx src/server/standalone.ts --host 127.0.0.1 --port 5381 --no-open
TINSTAR_BACKEND_PORT=5381 TINSTAR_FRONTEND_PORT=5380 npm run dev:frontend
```

Open `http://127.0.0.1:5380`.
Use a private `TINSTAR_CONFIG_HOME` containing an authorized config; never commit
credentials. A Notion access failure leaves the worker column usable. Sharing the
configured board with its integration is an owner prerequisite, not an empty board.

Display labels and full-home routing identities are configured in the
[source reference](reconciliation-floor.md#run-and-configure). The configured root
appears as First Mate in the command strip rather than a duplicate manager card.
