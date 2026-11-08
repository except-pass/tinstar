# Releases

Releases is a PR-first observation page (`?view=releases`). Each table row is a
GitHub PR, with its linked Notion cards in the same row. Initiative → Epic is
inherited from the cards' existing Work properties; Repository is an alternative
preset. A PR can appear in several groups while keeping one canonical
`repository#number` identity, selection and count. Search uses the shared compact
Smart Search palette and exact/full-text/fuzzy index, including available linked
card prose. Card links open the real card in Tin Star (`?card=<page-id>`).

## Associations

The reader imports explicit GitHub PR URLs in active cards' `Link`, `GitHub`,
`GitHub PRs` and `Pull requests` properties. It does not guess links from titles,
similar worker assignments or prose. The shared join also accepts confirmed, current, explicit Notion First Mate tasks claims for exact worker executions with registered PRs; unverified, conflicting and historical claims do not create active edges. PR Operations uses this same association projection (see `src/shared/releases.ts`). Done/archived historical cards are not mass imported.
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

GitHub supplies PR title, merged state/time and effective merge commit. Reads
use the existing gh-axi scalar transport, at most four PR reads per refresh and
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
explicitly. Transition and owner-verification drafts can be inspected, but no
Notion writer, active Desk routing, deployment action or mass backfill exists.

Multi-select PR action toolbar + shared custom-action framework: not present in
main; deferred to its own card. The table preserves canonical row selection for
future reuse, existing Ask/inspect and direct GitHub/Tin Star links. It does not
introduce an action execution engine.

Read-only reconciliation consumes actual component receipts (including cmsandbox
coordinator results where available), checks merge ancestry per repository and
target, and reports dry-run eligibility. Enabling automatic Notion Done and
opt-in verification routing remains a separate rollout gate with simultaneous
board-guide and PM-bot sweep updates.

## Read-only reconciliation

Releases now computes per-PR/component shipment and per-card **dry-run** eligibility.
`GET /api/releases/reconciliation` returns the same inspectable report used by the
page; GET never writes cards, comments, Desk requests or GitHub. Replaying the
same observations produces the same report ID and decisions. There is no
active transition switch or Notion writer in this build.

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
It appears in Verify in Prod and the drawer but performs no Desk or status action.
Missing checkbox means no opt-in verification requirement; the reader does not
create it. Other Notion statuses stay unrelated and cannot be completed by this
report. Actual automation/routing and the board-guide/PM-bot rollout remain gated.

### Default-OFF transition and Desk review

`GET /api/releases/automation` and `automation` on the Releases collection return
a pure, deterministic **review-only** plan. It proposes `Waiting for Prod Release`
→ `Done` for eligible unflagged cards. An opted-in card instead proposes
`Waiting for Prod Release` → `In Progress` with explicit production-check context
and a draft for its current responsible owner. It never proposes completion of
an opted-in card. Opening a drawer, navigating Desk, sending Ask, or replaying the
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
visible warning. **Even `enabled: true` is only a blocked enablement request in
this build**: the response always has `enabled: false`, the UI shows OFF, and no
Notion writer or Desk publisher exists. There is no HTTP method to activate or
execute the plan. This boundary prevents premature live-board transitions before
the parent approves activation together with the board-guide and PM-bot sweep
updates in the same release. Do not change those operational instructions early.
There is no mass-backfill path.

Each proposal carries all required PRs, effective merge SHAs, per-component deploy
identities/version/time and direct workflow/receipt links, plus short audit text.
Its ID is stable for the same card, release evidence and routing owner; refreshing
collection timestamps or unrelated work does not create a new proposal. Changed
deployment evidence or verification owner changes the ID. No comments, audit
events, status changes or active queue entries are emitted on replay. A future
approved writer must re-read current status, opt-in flag, requirements and fresh
evidence before execution, and durably deduplicate the proposal ID; this preview
does not claim to implement exactly-once writes.

Desk drafts reuse the existing `QueueItem` shape wrapped with their responsible
owner. They retain card/PR/receipt links and use `future-or-conditional` readiness,
`oneTouch: false`, no response anchor and no decision key. They stay outside
`/api/reconciliation/queue` and default actionable Desk navigation while OFF. The
shared global Desk/Ask implementation owns eventual publication and owner routing;
Releases adds no parallel queue, Ask provider or response transport.

GitHub read failures are separate from pending reads. A missing `gh-axi` displays
`Sync error: gh-axi unavailable on server PATH`; access/CLI/read failures display
`Sync error: GitHub reader failed`. The disclosure lists safe error descriptions,
never stderr/credentials. Fix the **service** PATH/auth, not only an interactive
shell. Recovered reads clear the error; stale prior facts remain labeled.

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
whose origin must match the configured GitHub repository (HTTPS or SSH). The
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

At implementation inspection the production deploy workflow had zero runs and no
final successful native PROD record was confirmed. The adapter is exercised with
explicit synthetic fixtures; real records without available evidence remain
unknown. Existing build/DEV receipts or a planner candidate alone cannot certify
production. Firstmate/the upstream evidence owner must supply readable, current
exports and repository/component mappings before positive real shipment proof.
