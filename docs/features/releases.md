# Releases

Releases is a PR-first observation page (`?view=releases`). Each table row is a
GitHub PR, with its linked Notion cards in the same row. Initiative → Epic is
inherited from the cards' existing Work properties; Repository is an alternative
preset. A PR can appear in several groups while keeping one canonical
`repository#number` identity, selection and count. Search uses the shared compact
Smart Search palette and exact/full-text/fuzzy index, including available linked
card prose. Card links open the real card in Tin Star (`?card=<page-id>`).

## Associations

The reader imports explicit GitHub PR URLs in operational and Done cards' `Link`, `GitHub`,
`GitHub PRs` and `Pull requests` properties. It does not guess links from titles,
similar worker assignments or prose. The shared join also accepts confirmed, current, explicit Notion First Mate tasks claims for exact worker executions with registered PRs; unverified, conflicting and historical claims do not create active edges. PR Operations uses this same association projection (see `src/shared/releases.ts`). Done cards retain their explicit associations for Shipped history; archived and trashed cards are excluded. This read does not backfill or modify cards.
A missing PR declaration on a Waiting for Prod Release card appears under
Exceptions, outside the PR table.

Additional many-to-many associations and local exclusions are audited in
`<getConfigRoot()>/releases/associations.json`. The append-only event history
records a retry ID, PR URL, card ID, link/unlink, authenticated owner, UTC time
and reason. Unlink locally excludes that edge while retaining its Notion source
and audit history; it does not edit Notion. A later link can restore it. These manual events apply after automatic associations. An
unreadable/corrupt audit is reported visibly and never overwritten as an empty
store. Local audit persistence uses atomic replacement under the existing single
server/config-root boundary. There is no shared database or new service.

Editing uses the same `ask.ownerLogins` and trusted local Tailscale Serve identity
boundary as Ask: the backend must be loopback-only behind the tailnet proxy.
The UI handshake and allowed browser origin are required for writes. Only cards
in the authorized Notion source can be linked. Read-only operation remains
available without configured owner logins. A directly exposed backend must never
trust a client-supplied Tailscale identity header (see [Ask](ask.md)).

## Evidence and current boundaries

GitHub supplies PR title, captured head and base branch, merged state/time and effective merge commit. Reads
use the shared scalar reader (gh-axi by default, or the live Reader broker described
in the [installed PR actions guide](../pr-actions.md)), at most four PR reads per refresh and
no repository crawl. Successful merged identities cache for ten minutes so a
bounded reader can cover the queue; open/failed reads retry after one minute.
Failures retain visibly stale facts. The navigation badge and page queue count
are unknown (`?`) while any association's GitHub state is unresolved, the Notion
association source or worker PR source is stale, partial or unavailable, or the local association
audit is unreadable. Collection-level source warnings remain visible even when
no PRs are known; an incomplete observation never becomes a complete zero.
The eventual count is unique merged PRs awaiting
production evidence, not cards or repeated group references.

In Queue includes merged PRs awaiting verified component evidence and unresolved
observations. Shipped and Verify in Prod require the read-only reconciliation
proof below. Neither Notion Done nor a version tag implies shipment. The drawer
shows merge provenance, required targets, receipts, card dry-run eligibility and
link history. The sync disclosure reports failures and unknown deployed versions
explicitly. Transition and owner-verification proposals can be inspected. A separate scheduled
writer is available behind the default-OFF operator switch; GET never writes.
Deployment actions and mass backfill are outside this page.

The table's canonical PR selection feeds the shared
[installed PR actions framework](../pr-actions.md), which owns action execution modes,
installation and action receipts. Existing Ask/inspect and direct GitHub/Tin Star
links remain available.

Read-only reconciliation consumes actual component receipts (including cmsandbox
coordinator results where available), checks merge ancestry per repository and
target, and reports dry-run eligibility. Enabling automatic Notion Done and
opt-in verification routing remains a separate rollout gate with simultaneous
board-guide and PM-bot sweep updates.

## Read-only reconciliation

Releases now computes per-PR/component shipment and per-card **dry-run** eligibility.
`GET /api/releases/reconciliation` returns the same inspectable report used by the
page; GET never writes cards, comments, Discuss requests or GitHub. Replaying the
same observations produces the same report ID and decisions. The separately scheduled writer remains OFF unless the operator enables it;
this endpoint never invokes that writer.

A PR is shipped only when every explicit required target has a successful current
production receipt and GitHub's effective merge commit is an ancestor of that
component's deployed source. A digest without source provenance stays unknown.
A merged PR absent from deployed source remains In Queue. Wrong repository,
environment, target/component, missing mapping, partial/skipped/failed deployment,
rollback, known disabled flag, cherry-pick without provenance, or revert prevents
fulfillment. Standard Git revert messages naming the effective merge or a commit
introduced by that merge are detected in descendant history;
other known release exceptions must be published by the evidence source or
listed on the requirement. No title matching, LLM judgment or tag-only inference
is used.

A card is eligible to **would-complete** only in `Waiting for Prod Release`, with
complete association sources and *all* linked PR/target requirements proven live.
The optional existing Notion checkbox named exactly `Requires production
verification`, when true, instead produces **would-verify**, including the owner.
The read-only proposal appears in Verify in Prod and the drawer; generating it performs no Discuss or status action.
Missing checkbox means no opt-in verification requirement; the reader does not
create it. Other Notion statuses cannot be completed by this report; a confirmed
unresolved verification route can remain visible after transition to In Progress.
The writer requires the checkbox schema and fresh current production evidence;
rollout requires coordinated board-guide/PM Bot updates.

### Default-OFF transition and Decisions review

`GET /api/releases/automation` and `automation` on the Releases collection return
a pure, deterministic plan reporting the configured mode (`review-only` or
`automatic`). Reading the plan never executes it. It proposes `Waiting for Prod Release`
→ `Done` for eligible unflagged cards. An opted-in card instead proposes
`Waiting for Prod Release` → `In Progress` with explicit production-check context
and a draft for its current responsible owner. It never proposes completion of
an opted-in card. Opening a drawer, navigating Discuss, sending Ask, or replaying the
report does not record a successful check. Verification remains open until the
owner explicitly records the result through the existing card workflow. Cards in
other statuses, archived cards and unresolved requirements cannot be transitioned.
A missing verification owner holds that card visibly without preventing a
neighboring eligible unflagged card's Done proposal.

The optional trusted operator file
`<getConfigRoot()>/releases/automation.json` is separate from deployment evidence:

```json
{ "version": 1, "enabled": false }
```

Omitting the file defaults to OFF. Invalid/unreadable settings remain OFF with a
visible warning. `enabled: true` enables a deterministic pass every 60 seconds in
the existing backend. There is no browser activation/execute endpoint. GET still
only reports proposals. Enable only with the owner-approved checkbox schema and
coordinated policy updates. The [activation packet](../releases-activation.md)
contains exact replacement text, operating commands and current evidence limits.

The writer re-reads the authorized board, current associations/evidence and exact
card immediately before each write. It requires an actual readable boolean
`Requires production verification` checkbox even for an unflagged card. It
comments the evidence, revalidates, then changes Status. It preserves owner,
unrelated asks and other properties. Opted-in cards route to In Progress with an
explicit production-check request; unflagged cards go to Done. A missing verification owner,
unknown source, stale export, wrong target, disabled flag, rollback, revert,
partial deployment or changed precondition holds the affected operation.

`releases/writer-receipts.json` durably records intent before side effects and
tracks pending/done/skipped operations. Stable IDs include card, owner, required
PRs and deployment evidence. Comment markers deduplicate retries through the
shared Notion content transport. A lost PATCH response is recovered by reading
current Status and the exact comment marker; completed operations never replay
or flap status. See the [activation packet](../releases-activation.md#retry-audit-and-rollback)
for the concurrent-edit limitation and recovery procedure.

Confirmed verification routes are published through the existing shared Decisions
queue with the current card owner and direct card/PR/deployment links. Decisions and
Verify in Prod use the latest completed, unresolved verification operation for
each card, together with its current In Progress status and checked checkbox.
Status and checkbox alone never resurrect a retired check. Checked waiting cards
still propose verification normally. The owner records the result on the card
and uses the existing workflow to finish it.

Decisions publication and scheduled retirement acquire fresh exact-card observations
inside the writer's serialized boundary. Leaving In Progress, clearing the
checkbox, archiving or trashing the card retires its verification operation;
a newer completed route supersedes older routes. Retirement is durable, so
reopening a completed card does not restore its old check. These observations
do not themselves record a successful verification. Turning automation OFF stops
new transitions; outstanding human verification requests remain visible until
resolved. No second queue service or Ask transport is introduced.

Inspect/dry-run with `npx tsx scripts/releases-automation.ts --config-root <root>
--passes 32 --output <output-path>`. This command uses a read-only Notion
transport even if the runtime switch is ON. Each pass retains the existing
four-PR/eight-ancestry budget. For audited skip/resume, receipt recovery and
rollback, see the [activation packet](../releases-activation.md#retry-audit-and-rollback).

GitHub read failures are separate from pending reads. In default CLI mode, a missing `gh-axi` displays
`Sync error: gh-axi unavailable on server PATH`; access/CLI/read failures display
`Sync error: GitHub reader failed`. The disclosure lists safe error descriptions,
never stderr/credentials. Fix the **service** PATH/auth, not only an interactive
shell. In live mode, broker/access failures also remain sync errors; the reader never falls back to CLI authentication. Recovered reads clear the error; stale prior facts remain labeled.

### Configure existing sources

Put the following in `<getConfigRoot()>/releases/reconciliation.json`. This is
trusted operator configuration, never a browser edit or a new release controller.
Tin Star reads existing receipt exports and Git objects only. It does not assume
AWS roles, fetch repositories, invoke workflows, generate deploy receipts, or run
deploy commands. An upstream/export owner must provide current evidence.

```json
{
  "version": 1,
  "repositories": [
    { "repository": "owner/repo", "checkout": "/srv/read-only-mirrors/repo" }
  ],
  "requirements": [
    {
      "pull": "https://github.com/owner/repo/pull/123",
      "targets": [{ "target": "api-prod", "component": "api" }],
      "exceptions": []
    }
  ],
  "receiptFiles": ["/srv/release-evidence/current.json"],
  "maxSnapshotAgeSeconds": 300
}
```

Targets are exact deployed identities, not repository-wide version tags. For a
monorepo, enumerate every affected required component explicitly. Missing mappings
are Exceptions. `repositories[].checkout` is an existing checkout/bare mirror
whose origin must match the configured GitHub repository (HTTPS or SSH). Set
`checkout: "github"` to use the same authenticated GitHub scalar reader as PR
observations instead. GitHub comparisons check exact ancestry and standard
reverts; truncated descendant/introduced history stays unknown. Configure a local
mirror when the bounded GitHub response cannot establish complete history. The
operator updates missing objects outside Tin Star. Reads use
`git merge-base --is-ancestor`; failure or absent objects stays unknown. At most
eight uncached commit pairs are inspected per refresh under a short read budget;
remaining pairs are visibly pending. Immutable answers cache for ten minutes,
failed reads retry after one minute.

The snapshot freshness limit protects against an old export certifying a service
after a later unobserved deployment. It applies to **collectedAt**, when the
source confirmed its current state, not the original deployment date. Refresh
exports from all relevant writers, including surgical deploys/rollback paths.
A historical deploy record alone is insufficient to assert current state after
an unobserved change. Missing, stale, malformed or conflicting exports are
visible and cannot fulfill cards. Snapshot reads are bounded to 8 MiB per file
so an unbounded journal cannot exhaust the HTTP process; export a bounded history.

### Deployment receipt snapshot contract

Existing deployment collectors can export this normalized contract. Values must
come from actual successful component/runtime deployment verification; editing a
tag into this file is not provenance. The configured local file is the trust
boundary: keep it operator-controlled, and retain direct immutable receipt and
workflow references. Tin Star validates and reconciles it; it does not make an
untrusted producer authoritative.

```json
{
  "schema": "tinstar.deployment-receipts.v1",
  "collectedAt": "2026-11-06T18:15:00Z",
  "receipts": [{
    "id": "api-prod/run-123/attempt-1",
    "repository": "owner/repo",
    "environment": "production",
    "target": "api-prod",
    "component": "api",
    "deployedSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "artifactDigest": null,
    "version": "v1.2.3",
    "deployedAt": "2026-11-06T18:10:00Z",
    "workflowUrl": "https://github.com/owner/repo/actions/runs/123",
    "receiptUrl": "https://example.com/immutable-receipts/api-prod/run-123.json",
    "outcome": "succeeded",
    "exceptions": []
  }]
}
```

`outcome` can also be `failed`, `partial`, `skipped` or `rollback`; retain newer
failures/partial attempts so an older success cannot override them. For each exact
repo/target/component the latest attempt wins, comparing parsed timestamp instants
regardless of UTC-offset spelling, with conflicting equal-time identities kept
unknown. Identical receipt IDs replay without duplication;
conflicting copies make the source an error. A digest-only receipt is readable
but requires verified `deployedSha` provenance before ancestry can prove a PR.
Known flags/reverts/cherry-picks or other exceptions are explicit strings in
`exceptions`, never silently discarded.

### Consume cmsandbox coordinator records

The native adapter consumes the existing coordinator records; it does not rebuild
its approval or deployment machinery. Export current `control.json`, its committed
journal chain, and referenced frozen objects from
`s3://fortresspower-cmsandbox-release-prod-298117917676/coordinator/production/v1/`.
Preserve raw JSON values and S3 `LastModified` metadata. Wrap them as:

```json
{
  "schema": "tinstar.cmsandbox-production-export.v1",
  "repository": "fortresspower/cmsandbox",
  "bucket": "fortresspower-cmsandbox-release-prod-298117917676",
  "collectedAt": "2026-11-06T18:15:00Z",
  "control": { "head": "sha256:<committed-journal-digest>" },
  "journal": { "sha256:<digest>": "<raw production-event object>" },
  "journalMetadata": { "sha256:<digest>": { "lastModified": "2026-11-06T18:10:00Z" } },
  "objects": { "sha256:<digest>": "<raw frozen object>" }
}
```

The placeholder strings above represent JSON objects, not stringified JSON.
Journal keys are immutable hashes: Tin Star verifies them, follows only the
current committed chain (not orphan events), and resolves frozen bindings.
Only fully completed, authorized live production releases with verified service
or static steps produce successful receipts. Stage-only and rehearsal records
never prove PROD. A newer open/stopped/rollback release invalidates earlier success
for affected targets. Exact coupled service/container members retain independent
component identities. Selected OCI digest/source provenance comes from the frozen
candidate and matching trusted build object, **not** the monorepo tag SHA. Static
publications use the matching versioned frozen manifest. ECS target IDs are
`account/region/cluster/service/container`; static IDs are
`account/region/bucket/prefix`. Use those exact IDs in required-target mappings.

Authoritative upstream contracts:
[production coordinator](https://github.com/fortresspower/cmsandbox/blob/main/.github/scripts/releases/coordination.mjs),
[verified step identity](https://github.com/fortresspower/cmsandbox/blob/main/.github/scripts/releases/execution-plan.mjs),
[immutable S3 journal](https://github.com/fortresspower/cmsandbox/blob/main/.github/scripts/releases/s3-coordination-store.mjs),
[production runbook](https://github.com/fortresspower/cmsandbox/blob/main/docs/releases/production-runbook.md).

### Review an exported native coordinator directory

For an already exported store, configure this alongside `receiptFiles`:

```json
{
  "coordinatorSnapshots": [{
    "directory": "/srv/release-evidence/v1.24.0",
    "collectedAt": "2026-11-10T16:48:50Z"
  }]
}
```

The directory contains `control.json`, `journal/<digest>.json` and
`objects/<digest>.json`. Preserve journal S3 LastModified as file mtime. The
reader follows the committed chain and loads referenced objects only, verifying
native content-addressed keys. Superseded bindings certify nothing. Reads are
bounded to 8 MiB per object and 32 MiB total so an accidentally unbounded export
cannot exhaust the HTTP process. An incomplete export is visibly an error;
provide a bounded current chain to continue.

These directories are explicitly historical snapshots: the UI labels the exact
as-of time, `sourceStatus` is `snapshot`, and no writer can execute their
proposals even if enabled. The snapshot has no freshness extension pretending it
is current PROD. A later current-state export can use the existing normalized
`receiptFiles` contract; this slice builds no AWS poller or release service.

The [activation packet](../releases-activation.md#evidence-and-limits-of-this-slice)
owns the captured v1.24.0 proof, exact component mapping and remaining activation
prerequisites.
