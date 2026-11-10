# Releases activation packet

The implementation is default OFF. The production verification decision is
already approved and remains opt-in. This packet requests only activation of the
writer, the checkbox schema, and the coordinated operational instructions.
It does not authorize deployment, merging, activation, or backfill during review.

## Owner activation request (exact text)

> Approve adding the Notion checkbox named exactly **Requires production
> verification**, default unchecked; publishing the replacement board-guide and
> PM Bot instructions below in the same rollout; and changing the existing
> Tin Star `releases/automation.json` to `{"version":1,"enabled":true}` once
> Firstmate has supplied a fresh current-state production export and the final
> dry run has been reviewed. Unchecked eligible waiting cards will automatically
> become Done after all required PR/targets are proven deployed. Checked cards
> will become In Progress with an actionable production check for their current
> owner and stay open until that check is explicitly recorded. This approval
> does not turn a historical release snapshot into current-state evidence.

Firstmate applies configuration only to the designated deployed Tin Star config
root after the release is approved. There is no browser activation control.
Keep `{"version":1,"enabled":false}` throughout this handoff. The source mapping
lives in the same root's `releases/reconciliation.json`; a current source uses
`receiptFiles` with the documented normalized/native receipt contract and the
normal `maxSnapshotAgeSeconds` limit. Directory `coordinatorSnapshots` are always
review-only and cannot be activated as current evidence.

## Exact board-guide replacement (main home)

Firstmate owns installing this replacement in the main home's
`data/notion-board-procedure.md` at rollout. Do not edit that other home from this
worker or prematurely replace live instructions.

> **Production release completion and optional verification**
>
> Keep Notion as the status authority. A card in **Waiting for Prod Release**
> automatically moves to **Done** when Tin Star proves that every explicitly
> required PR and production component/target is live, with no known rollback,
> revert, disabled feature flag, partial deployment or missing evidence.
> The completion comment must identify the actual version, target, source SHA
> or digest, deployment time, workflow/receipt links and all required PRs.
>
> Production verification is **opt-in**. Before shipping, check **Requires
> production verification** on a card that needs an explicit production check.
> When all required changes deploy, Tin Star moves that card to **In Progress**
> with explicit production-check context and routes the check to its current
> responsible owner in Your Desk. The owner records the explicit result on the
> card and uses the existing work workflow to mark Done only after the check
> succeeds. Opening a view, merging a PR or acknowledging a request is not a
> successful check. A neighboring unchecked eligible card closes automatically.
>
> Missing mappings, stale/current-source failures, wrong environment/target,
> cherry-picks without provenance and other exceptions remain open and visible
> in Releases. Do not move cards in unrelated statuses, infer deployment from a
> merge/tag, mass-backfill associations, or return every released card to
> In Progress by default. The former mandatory-prod-check rule is superseded.

## Exact PM Bot sweep replacement (owner-managed Notion agent)

The owner maintains PM Bot's instructions. Supply this exact text for the owner
to install during the same rollout; locating or editing that agent is not a
prerequisite for preparing this packet.

> For production release cards, follow Tin Star Releases' deterministic,
> evidence-backed reconciliation. Do not infer shipment from PR merge or a
> version tag. Do not move every released card back to In Progress for a manual
> check. **Requires production verification** is opt-in: unchecked cards already
> Waiting for Prod Release close automatically only when all required PR/targets
> are proven live with no known exceptions. Checked cards route to In Progress
> with an explicit check for the responsible owner and remain open until the
> explicit production verification is recorded. Preserve unrelated statuses,
> asks, owners and historical receipts. Surface missing/stale deployment evidence,
> partial/skipped components, rollback/revert/flag exceptions and unresolved PR
> links; do not manufacture Done, create new statuses, or duplicate Tin Star's
> comments/status writes on replay. During rollout keep the previous operational
> handling until the new schema, writer and this instruction update are deployed
> together and the owner explicitly enables automation.

## Evidence and limits of this slice

The source snapshot is the actual committed coordinator store exported after
v1.24.0 completed, as supplied by Firstmate on November 10. The final close points
to https://github.com/fortresspower/cmsandbox/actions/runs/42855184812 . Native
frozen candidate/build/publication provenance yields source
`466a3e27918a8f17a21546a6b4664d318f5fcc6a` for these components:

| Component | Exact target (account/region omitted here: 298117917676/us-west-2) |
| --- | --- |
| manager-analysis | manager-analysis/manager-analysis-service/manager-analysis-prod-container |
| manager-analysis-alloy | manager-analysis/manager-analysis-service/alloy |
| ra-workflow | ra-workflow/ra-workflow/ra-workflow |
| ra-workflow-alloy | ra-workflow/ra-workflow/alloy |
| web-fmp-portal | web-ui-fmp-prod-bucket/ |
| web-fmp-runtime-json | web-ui-fmp-prod-bucket/runtime-config.v1.json |

The complete target IDs, digests, journal receipt URLs, workflow URL, component
mapping audit and per-card dry-run JSON are delivered outside the repository in
`/home/farm/fm-home/data/tinstar-releases-activation/`. No exported source records,
board contents or credentials are added to version control.

The board proof uses real explicit Link/GitHub declarations. Worker home
namespaces are excluded from this task's proof and the scope is disclosed;
unlinked cards remain exceptions. The locked opt-in neighboring-card behavior
is additionally exercised against the real planner/writer interfaces with an
isolated synthetic board and fake Notion transport, never fake live records.

The first dry run observed 51 waiting cards: one proposed Done, zero proposed
verification routes, 50 held. These are snapshot/as-of decisions, not a statement
that a historical export still represents current PROD. Review the delivered
JSON for the final captured counts and exact reasons. Unknown paths, unonboarded
services/infrastructure, missing migration/flag coverage and truncated GitHub
revert history remain exceptions. Providing an explicit local Git mirror is a
supported alternative when bounded GitHub history is insufficient.

Firstmate owns the remaining live-source prerequisite: a refreshed current-state
export covering all deployment/rollback paths, then rerun the same dry run before
enabling writes. This slice deliberately adds no live AWS path. Owner-only
schema/policy/switch activation follows that prerequisite; it is not a renewed
product-design decision about opt-in verification.

## Retry, audit and rollback

Set `enabled` to false to stop new writes on the next precondition check; reads
remain available. A write already submitted to Notion may finish. Review the
exact receipt/comment before making any correction through the existing audited
work workflow. Disabling does not reopen cards or discard verification requests.

Inspect `releases/writer-receipts.json` and the card's `Tin Star release:` marker.
Retry is automatic while enabled and evidence stays current. For an individual
stuck operation use:

```bash
npx tsx scripts/releases-automation.ts --config-root /path/to/config \
  --skip sha256:PROPOSAL_ID --actor owner --reason 'Reason for holding this operation'
npx tsx scripts/releases-automation.ts --config-root /path/to/config \
  --resume sha256:PROPOSAL_ID --actor owner --reason 'Reason normal checks can resume'
```

Both dispositions retain their audit history. They do not bypass production
proof. For corrupt local receipts disable automation, inspect affected cards,
then run `--recover-receipts --actor owner --reason 'Recovery reason'`. It keeps
the original file and records the recovery in a new journal. Completed operations
cannot be replayed through resume. The existing explicit owner card workflow is
the audited manual disposition when automation cannot prove a change.

Notion does not provide conditional PATCH for Status: a concurrent direct edit
can race the final fresh read. The writer minimizes this window, preserves all
unrelated fields, deduplicates comments and confirms Status after writes; it
does not claim distributed exactly-once transactions or atomic compare-and-swap.
