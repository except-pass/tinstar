# Releases

Releases (`?view=releases`) presents selectable coordinator release objects. Plan
opens on Changes for a frozen RC or an explicitly identified Draft. Verify opens
on Production acceptance for an observed production release, including partial
and superseded attempts. The 238px desktop release selector becomes horizontal
release tiles on phones. Changes, Acceptance and Release notes always belong to
the selected identity; a contextual drawer carries exact targets and provenance.
There is no global PR table or permanent inspector on this surface.

## D.2 read model and evidence boundaries

`GET /api/releases` adds `releases` alongside the existing PR association and
legacy dry-run projections. It reads the same configurable coordinator sources
below; it creates no release ledger, deployment control plane or writer. Candidate
identity includes repository, manifest and frozen plan; production identity also
includes its committed execution/receipt, so repeated same-tag attempts stay
separate. Only coordinator attempts with observed target readback appear in Verify.
Legacy normalized component receipts retain individual receipt/target identities
when no shared coordinator binding is available; equal versions never fuse them. Snapshot
as-of times are visible and never certify current production.

Changes are deterministic Git membership: merged PRs whose effective merge commit
is in the release-source range since the previous version tag with proven Git
ancestry. Tags delimit Changes only; a tag never establishes production delivery.
The reader checks the available first 100 tags, selects the preceding ancestral
version tag, paginates comparison commits, and discovers associated PRs eight
commits at a time (four concurrent reads). Known results remain visible with
partial counts while the range is being read. Missing earlier history is a named
source gap. CLI and live Reader use the existing authenticated transports; no
workflow is dispatched. Immutable range membership is cached in memory.

Changes group by explicit PR/card association, deduplicating each linked work
outcome and preserving every required PR. Explicitly linked required PRs outside
the selected Git range are reconciled against that release’s exact receipts as
supporting evidence; they never become additional Changes members. Coordinator
release reconciliation uses the selected source’s collection time for both member
and supporting PRs, while the legacy writer retains the conservative aggregate
evidence context. An unlinked member remains an unlinked
PR with its actual title. Component names never become invented work items.
Delivery uses the existing exact target mapping, source ancestry and receipt
reader. A partial rollout retains independently verified target observations,
so its proven subset can show Deployed while the release remains Partial rollout.
Missing mapping, unknown sources, partial/skipped/reverted components or
an incomplete required PR set cannot establish delivery or acceptance.

Feature acceptance contracts are tagged `production-acceptance` JSON sections in
existing card Evidence rich text. Checks reference existing safe workflows,
telemetry queries or named human procedures; see [D.3 configuration and recovery](../releases-acceptance.md).
The default-OFF operator runner dispatches only after fresh exact target proof,
records exact run IDs/links and explicit outcomes in existing workflow receipts,
and supports audited manual results, attachment, retry and skip. HTTP reads and
page clicks never dispatch. Build/DEV readiness never establishes acceptance;
missing, failed, skipped and inconclusive checks cannot pass. The drawer shows
the latest result first with prior evidence retained in expandable history.

Production notes remain ineligible until verified membership and linked accepted
work exist. Internal/Customer selection and Copy draft operate on the selected
release; D.4 publication and D.5 Notion closure/policy changes remain separate.

Every V3 surface ships in D.2. Clearly labelled synthetic test-fixture screenshots
cover the failed/manual acceptance drawer and populated eligible-notes compositions
that only D.3/D.4 can supply with real data. Fixtures are never mixed into normal
reads. **The full real-data screenshot gate in controlling handoff section E
remains the bar before the card is Done, after D.3/D.4.**

For isolated composition proof, bundle `test-fixtures/releases/v3-preview.tsx`
with esbuild into a scratch directory and open its standalone HTML wrapper. The
fixture entry is never a production app route. Unit tests exercise release
selection, many-to-many joins, incomplete evidence, note exclusion, drawer focus
restoration, source loading and scoped search. Native modal dialogs supply focus
containment and Escape; the browser comparison covers desktop and phone layouts.

The prior opt-in activation proposal is obsolete under the controlling handoff.
The legacy default-OFF writer below remains untouched and must not be activated
as part of D.2. Its implementation description is historical, not the new
acceptance-completion policy or an activation recommendation.

## Associations

The reader imports explicit GitHub PR URLs in operational and Done cards' `Link`, `GitHub`,
`GitHub PRs` and `Pull requests` properties. It does not guess links from titles,
similar worker assignments or prose. The shared join also accepts confirmed, current, explicit Notion First Mate tasks claims for exact worker executions with registered PRs; unverified, conflicting and historical claims do not create active edges. PR Operations uses this same association projection (see `src/shared/releases.ts`). Done cards retain their explicit associations for release history; archived and trashed cards are excluded. This read does not backfill or modify cards.
A missing declaration remains a named source gap; no work row or relationship is guessed.

Additional many-to-many associations and local exclusions are audited in
`<getConfigRoot()>/releases/associations.json`. The append-only event history
records a retry ID, PR URL, card ID, link/unlink, authenticated owner, UTC time
and reason. Unlink locally excludes that edge while retaining its Notion source
and audit history; it does not edit Notion. A later link can restore it. These manual events apply after automatic associations. An
unreadable/corrupt audit is reported visibly and never overwritten as an empty
store. Local audit persistence uses atomic replacement under the existing single
server/config-root boundary. There is no shared database or new service.

The retained link/unlink API uses the same `ask.ownerLogins` and trusted local
Tailscale Serve identity boundary as Ask: the backend must be loopback-only behind the tailnet proxy.
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
Failures retain visibly stale facts. The navigation badge's legacy queue count
are unknown (`?`) while any association's GitHub state is unresolved, the Notion
association source or worker PR source is stale, partial or unavailable, or the local association
audit is unreadable. Collection-level source warnings remain visible even when
no PRs are known; an incomplete observation never becomes a complete zero.
The eventual count is unique merged PRs awaiting
production evidence, not cards or repeated group references.

## Read-only reconciliation

Releases now computes per-PR/component shipment and per-card **dry-run** eligibility.
`GET /api/releases/reconciliation` returns the legacy aggregate report;
the page uses the selected-release projection from `GET /api/releases`. GET never
writes cards, comments, Discuss requests or GitHub. Replaying the
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
The legacy read-only proposal remains available in the API; generating it performs no Discuss or status action.
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
only reports legacy proposals. Do not enable this obsolete opt-in proposal under
the controlling handoff. The [historical activation packet](../releases-activation.md)
records the previous implementation and evidence limits; D.5 owns replacement
policy and a separate later owner activation decision.

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
queue with the current card owner and direct card/PR/deployment links. Decisions uses
the latest completed, unresolved verification operation for
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

GitHub read failures are separate from pending reads. The legacy PR projection
retains safe read errors in `readError` and `githubSync.errors`; the release
projection names unavailable Git history in its source gaps. Neither exposes
stderr/credentials. Fix the **service** PATH/auth, not only an interactive
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
remain Unknown with the exact missing component/target evidence stated. `repositories[].checkout` is an existing checkout/bare mirror
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
For the legacy writer, only fully completed, authorized live production releases
with verified service or static steps produce successful receipts. The release
read model also preserves matching successful per-target readback from stopped
or incomplete executions; that observation does not satisfy the writer’s
completed-close requirement. Stage-only and rehearsal records
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

The directory contains `objects/<digest>.json` and, when production execution
exists, `control.json` and `journal/<digest>.json`. Preserve journal S3 LastModified
as file mtime. The reader follows the committed chain and loads all digest-named
frozen objects in the same directory, verifying native content-addressed keys.
Frozen candidate/plan pairs appear in Plan even before any production binding;
missing `control.json` means an empty journal. Include these pre-deployment objects
in exports rather than exporting only journal references. Unfrozen plans never
become RCs. Superseded bindings certify nothing. Reads are
bounded to 1,000 objects, 8 MiB per object and 32 MiB total so an accidentally
unbounded export cannot exhaust the HTTP process. An incomplete export is visibly an error;
provide a bounded current chain to continue.

These directories are explicitly historical snapshots: the UI labels the exact
as-of time, `sourceStatus` is `snapshot`, and no writer can execute their
proposals even if enabled. The snapshot has no freshness extension pretending it
is current PROD. A later current-state export can use the existing normalized
`receiptFiles` contract; this slice builds no AWS poller or release service.

The [activation packet](../releases-activation.md#evidence-and-limits-of-this-slice)
owns the captured v1.24.0 proof, exact component mapping and remaining activation
prerequisites.

### D.4 release notes

[Release notes](../releases-notes.md) documents release-scoped Internal/Customer
drafts, optional wording in the D.3 contract, exclusion reasons, and the separate
default-OFF GitHub publication command. Copy is read-only. Publication requires
an existing tag matching the release source and explicit owner activation after listener
review; it never creates a tag or enables the D.1 Notion writer.
