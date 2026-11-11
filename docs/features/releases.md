# Releases

Releases (`?view=releases`) reads **fortresspower/cmsandbox version tags,
GitHub Release records and component Actions runs**, through the same GitHub
Reader transport as PRs. No coordinator export or repository configuration is
needed. New version tags appear on refresh. Release identity is repository/tag;
the current tagged commit is retained separately so a moved tag does not reuse
its old source evidence.

Plan opens on Changes for a tag without observed component activity, explicitly
labeled Draft. Verify opens on Acceptance for a tag with observed component push
runs, including failed and incomplete attempts. A tag/run is release activity,
not proof of current production delivery. The 238px desktop selector becomes
horizontal tiles on phones. Changes, Acceptance and draft Release notes remain
scoped to the selected release, with the existing contextual drawer and contracts.

## GitHub-native source and evidence boundaries

`GET /api/releases` returns `releases` and `releaseSource` alongside existing
PR associations and the legacy dry-run projection. It reads tags and published
Release records with pagination. Missing Release records are distinct from failed
reads: **v1.24.0 has no GitHub Release record**, and appears from its tag and
component runs. Surgical tags such as `deploy/v1.24.0-siteconfig-1` are not version
releases. Runs must match the exact tag, tagged commit and `push` event; same-SHA
main/PR/surgical-dispatch runs and the record-only observer are excluded.

The adapter reads cmsandbox's generated `native-production-release` block,
preserving its intended-target/result/native-link rows, snapshot timestamp and
full Release body. It also reads component workflow names, conclusions, attempts,
start/update times and direct run links. The newest run per workflow determines
the activity summary; earlier runs remain available for audit. Operator prose
outside the generated block never becomes deployment proof.

Changes and source-file scope come from the Git compare between consecutive
version tags. Effective merged PR identities are read from those commits and
joined to existing explicit many-to-many Notion associations. Membership advances
in bounded batches, with partial counts and exact gaps until complete. A non-linear
range remains unknown; equal-source consecutive tags have an empty range. GitHub's
300-file compare limit is visible independently of paginated commit/PR membership.

To keep refresh latency and the shared GitHub budget bounded, observations cache
for one minute. Each refresh advances the latest tag and the selected tag (or one historical tag);
other tags remain selectable with explicit pending/unknown evidence. Catalogs
paginate up to ten pages and report partial coverage at that limit. Source loss
retains last-known observations with a visible unknown state. Missing or unreadable
GitHub data never becomes an assertion that there are no releases.

A successful component workflow is **awaiting PROD verification**, exactly as the
native Release body states. Neither a tag, published Release nor green Actions
run supplies an exact deployed component/runtime identity or feature-specific
acceptance. The reader creates no synthetic deployment receipts. Delivery and
acceptance stay Unknown until those proofs exist; Customer notes omit them.
Existing [D.3 contracts](../releases-acceptance.md) and [D.4 draft
notes](../releases-notes.md) keep their acceptance and audience rules.

The live API does not read `releases/reconciliation.json` or coordinator exports.
The old export reader remains for historical CLI fixtures/tests. The legacy
Notion writer's scheduled pass is disabled and the API reports review-only.
No GitHub/Notion writes, workflow dispatch, publication or production changes
are performed by this source. The following export/activation contracts are
**historical**, not instructions for configuring the live Releases view.

Native upstream contracts:
[release workflow](https://github.com/fortresspower/cmsandbox/blob/main/.github/workflows/release-production.yml),
[body generator](https://github.com/fortresspower/cmsandbox/blob/main/.github/scripts/releases/native-release.mjs),
[non-deploying proof](https://github.com/fortresspower/cmsandbox/blob/main/docs/releases/github-native-release-proof.md),
[current operator guide](https://github.com/fortresspower/cmsandbox/blob/main/docs/releases/github-native-release-guide.md).

## Historical coordinator reconciliation and writer (inactive)

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

[Release notes](../releases-notes.md) owns draft usage, editorial wording,
exclusion reasons and publication activation/recovery. D.5 Notion closure and
policy changes remain separate.
