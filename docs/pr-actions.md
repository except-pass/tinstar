# Installed PR actions (simulated)

PRs and Releases share local installed versions, owner grants, receipts and per-PR
locks. Select PRs, inspect an example's source, manifest and test evidence, then install
that immutable version. Use the installed buttons to simulate an investigation or
proposal. Fix CI also offers explicit safe-update and one-failed-job rerun proposals
for a single selected PR. The receipt always records actual GitHub writes = 0.

Invocation requires current captured heads and observed base branches. Unknown bases
disable the buttons; stacked PRs retain their actual base. A changed head or base at
capture requires refresh before invocation. Repair options apply only to Fix CI;
they do not affect Explain or other read actions on one or multiple selected PRs.

“Make a button…” opens the existing Desk Ask composer. First Mate can return a JSON
candidate containing `manifest` and `source`; paste it under Inspect a Custom candidate.
Installation stores source for inspection. Custom code is never evaluated: approved
OS isolation is unavailable. Only Tin Star's trusted simulation fixture interpreter
runs. Model answers and receipt Ask responses cannot install, grant or merge anything.

The registry defaults to `join(getConfigRoot(), 'actions')`, respecting
`TINSTAR_CONFIG_HOME`. Set `TINSTAR_ACTIONS_DIR` explicitly to use a different absolute
actions directory, including `$HOME/.tinstar/actions` if desired. Retained versions contain
`manifest.json`, `implementation.mjs`, and an owner-bound `installation.json`; `active.json`
is atomically replaced. Inspect exposes grants, source and test evidence. Rollback
selects an old version with its own grants and retains all receipts. Running work
continues on its original inspected version.

Receipts persist intent before a proposal and retain per-PR results, exact evidence,
actor, installed digest, plan/order and credential profile names. No token is minted
or exercised. Cancellation stops unsent proposals. On restart, unfinished intent is
marked unknown; the same idempotency key never retries it automatically. The existing
shared lock implementation is reused for cross-view/process exclusion. Unknown
dependencies serialize with an explanation. Selected exact base-ref/base-SHA dependencies
are ordered before their children; no coordinator dispatch is invented.

Admin Merge is disabled for all current workloads because the check inventory is
incomplete. The versioned candidate matrix and recorded real failures live in
[data/tinstar-pr-ops-actions](../data/tinstar-pr-ops-actions). Names inferred from source
but not corroborated by checks are marked as such and never authorize a merge.
REST review summaries cannot prove resolved threads, so current live snapshots retain
unknown review-thread/rule evidence. These are visible technical holds, with no hidden
switch that enables writes. A future live adapter and isolated runner require their
own review and provisioning. Exact owner steps are in
[provisioning.md](../data/tinstar-pr-ops-actions/provisioning.md).

Run `npm run test:unit -- src/server/actions src/actions` for registry, broker, real-check
refusal, lifecycle, ten-target and UI coverage. Source digests prevent code changing
under reviewed grants; typed capability and target refusals protect production data
and credentials. No unrelated file pins, policy expiry date or automatic kill switch
are introduced.

The GitHub job-rerun endpoint also reruns dependent jobs. Current REST job/run reads
cannot prove a job has no dependents, so rerun proposals remain held unless independent
topology evidence proves zero dependents. There is no fallback to a run-wide rerun.
[Provider behavior](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run).
