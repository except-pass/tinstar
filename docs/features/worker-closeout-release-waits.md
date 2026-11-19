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
the Releases screen, alongside the existing deployment reconciliation.
`containedPulls` shows whether each linked merge is in the tagged source, even
when it falls outside the Changes range between consecutive tags. Missing
ancestry stays unknown.

Tin Star retired the minute-by-minute job that moved cards to Done or In Progress
when all linked pull requests appeared in published releases. Membership shows
which merges are in the tagged history. Current deployment and feature acceptance
require their own evidence. The owner can still verify in production and record
the outcome through the existing card workflow, including an explicit audited
`update_work complete` or `park` as appropriate.

Past `Tin Star production wait: membership:` comments remain on their Notion
cards. The existing source-write reconciliation can still resolve an uncertain
write from before retirement. The older coordinator writer stays inactive and
its receipts and Decision Desk records remain readable. There is no scheduled
release-wait write left to retry or deduplicate. Manual workflow operations
still use their existing operation IDs.

Reverting the retirement re-enables automatic membership-based status writes
immediately on startup and every minute thereafter. Obtain separate explicit
owner authorization before reverting the retirement and redeploying. Without
that authorization, roll back only unrelated changes.

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
