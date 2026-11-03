# Overview

Tin Star's primary home follows [prototype 08](../design/tinstar-v8/prototype-08.html).
Workers and Notion cards render as independent stacks within shared group boundaries.
The existing source readers, reconciliation findings and authenticated MCP broker
remain authoritative. No demo data or local Assist parser enters production.

Initiative, Manager and Machine use the scene's union memberships. Cross-group
memberships carry a continuation marker and the same semantic identity; headline
counts are deduplicated. Activity and priority sorting coordinate both stacks,
with deterministic ties. Links may be hidden without removing either list.
Gaps only uses confirmed execution gaps on both sides, never filter-created
absence. Expired/failed reads retain last-known data and suppress gap coloring.
Finished and offline worker records move to expandable history, including last-known final reports after expiry. Waiting and planned cards can be collapsed using the compact Planned control; selecting a hidden counterpart reveals it without changing gap classification.

One contextual Desk shows the current verified request and the next few. Secondary
requests remain in Later & needs verification. Inspecting and regrouping retain
the queue identity. Existing exact First Mate decision identities reconnect to
its authorized response UI and receipts; presentation actions never submit a
response. Card context, evidence, raw source identities and diagnostics are read
on demand in the same panel. Worker terminal links retain the existing exact-home
resolver and open the safe viewer separately.

Clicks and authenticated MCP use the same reducer. `set-sort` accepts `activity`
or `priority`; `set-links` accepts `visible`. Existing arrangements retain their
wire names (`initiative`, `secondMate`, `machine`), with Manager as the UI label.
The existing targeted window, revision, expiry, idempotency and post-commit
acknowledgment protocol remains in place. No domain-write tool is added.

Development preview (two terminals):

```sh
TINSTAR_TELEMETRY=0 TINSTAR_CONFIG_HOME=/private/config node --import tsx src/server/standalone.ts --host 127.0.0.1 --port 5381 --no-open
TINSTAR_BACKEND_PORT=5381 TINSTAR_FRONTEND_PORT=5380 npm run dev:frontend
```

Open `http://127.0.0.1:5380`.
Use a private `TINSTAR_CONFIG_HOME` containing an authorized config; never commit
credentials. A Notion access failure leaves the worker column usable. Sharing the
configured board with its integration is an owner prerequisite, not an empty board.

Fleet entries accept an optional `label`, for example `{ "home": "/absolute/home",
"label": "hulk", "parentHome": "/absolute/root" }`. Labels only affect display.
Fallback is the home basename without a leading `fm-`; stable IDs and authorized
routing continue to use the complete home path. The configured root appears as
First Mate in the command strip, with its own worker count, rather than as a
duplicate manager card.
