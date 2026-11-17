# Worker close-out and production release waits

Authenticated owners, PM Bot and First Mate finish paths use the shared
`update_work` writer. Both operations need `card_id` and a stable `operation_id`;
retain a claimed card's `lease_token` as for other workflow updates.

```json
{
  "card_id": "41a50ce6d422811f89bfdfb05859c34b",
  "operation_id": "finish-observability-attempt-1",
  "kind": "close_worker",
  "worker": {
    "kind": "firstmate",
    "fm_home": "/home/farm/fm-obsf",
    "task_id": "visualization-influx",
    "first_observed_spawn_gen": "exact-generation-from-card"
  },
  "disposition": "done",
  "evidence": "Finish receipt and terminal outcome, with a link or report path."
}
```

Dispositions are `done`, `failed`, `absent` and `cancelled`. Close-out removes only
the exact home/task/generation from `First Mate tasks` (`tinstar.fm-links.v1`).
It preserves siblings, status, asks and waits. A different declared generation
or unreadable declaration prevents removal, because replacing either could erase
another worker. History records actor, date, operation, identity, disposition,
evidence and whether the identity was still declared. Repeat the same operation
to recover its receipt; an already removed identity also supports an explicit
new audited close-out. This never stops a worker or edits First Mate state.

```json
{
  "card_id": "41a50ce6d422811f89bfdfb05859c34b",
  "operation_id": "await-release-prs-1",
  "kind": "release_wait",
  "pulls": ["https://github.com/owner/repository/pull/123"],
  "evidence": "These changes are required for this card's production release."
}
```

On `Waiting for Prod Release`, `release_wait` appends canonical PR URLs to the
existing `GitHub PRs` rich-text field, preserving other content and recording an
audited note. It leaves status and generic wait fields intact. Generic `wait`
still refuses to convert a release wait to `Waiting For`.

`get_release_status` exposes the same native `releases` and `releaseSource` as
the Releases screen, alongside the existing deployment reconciliation. A scheduled
pass every minute advances a release wait once every actively associated PR is
in a published production release. The shared native reader exposes
`containedPulls`: effective merge ancestry in the production source, independent
of the incremental Changes range between tags. Earlier required PRs and changes
first tagged in a prerelease can therefore qualify after a cold restart. Unknown
ancestry stays explicit; bounded comparison reads continue on later refreshes.

The writer rechecks associations, owner, production verification and independent
typed blockers before writing. It preserves both destinations while an active
Actor/Event/Work blocker remains; resolve that blocker through the shared
workflow first. The existing Notion release transport saves a durable audit
marker before the status change. A stable source-operation identity lets a later
pass recover an applied audit after a lost response, even across restart or a new
production release. An uncertain mutable status PATCH retains its fence for the
existing audited source-write reconciliation; matching mutable properties alone
do not clear it. Reads remain read-only.

The existing `Requires production verification` checkbox routes to `In Progress`
for the named owner; otherwise the release wait goes to `Done`. The audit states
that release membership does not establish current deployment or feature acceptance.
Draft, missing, unknown and historical evidence cannot resolve the wait. Existing
audited `update_work complete`/`park` remain available for an explicit owner
corrective disposition. The older coordinator-based automation stays inactive;
its historical receipts and Desk routes stay readable.

## Remote home configuration

No live configuration is changed by this feature. Add this exact entry to
`config.json`'s `reconciliation.fleet` at deployment, and publish the supported
snapshot from stewie to the specified local file:

```json
{
  "home": "/home/farm/fm-obsf",
  "label": "Observability",
  "machine": "stewie",
  "snapshotFile": "/home/farm/srv/fm-snapshots/obsf.json"
}
```

The snapshot must identify `/home/farm/fm-obsf` as `fm_home`; local file placement
does not change its identity. Follow the existing [publication freshness and
completeness contract](../notion-worker-links.md#published-home-freshness-and-completeness).
The worker-link report includes configured remote homes and their workers. Its
[`coverage.unconfiguredHomes` field](../notion-worker-links.md#slice-b-backfill-and-deterministic-mismatch-report)
inventories other observed home identities for configuration review.

`search_work` owner/status filters and `coverage.intentions` are unchanged; the
Clawson poller can continue requesting owner `Clawson`, statuses `["In Progress"]`.
