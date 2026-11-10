# Installed PR actions

PR Operations uses the existing registry, executor, scoped owner grants, receipts,
per-PR locks and repository write serialization. The default remains trusted fixture
simulation with actual GitHub writes = 0. Custom source can be inspected/installed but
is not evaluated in default mode.

An operator can explicitly enable Reader/Repair using
`TINSTAR_ACTIONS_LIVE=reader-repair` after the safety review and App provisioning.
There is one broker process and executor implementation. The separate broker identity
owns the live registry/grants/audit store and is the only process that reads App keys
or mints installation tokens. The web process uses a private Unix socket; it never
receives authentication. Missing socket, credentials, IDs or safe runtime refuses
with a not-provisioned reason. There is no ambient-login or unsandboxed fallback.

Live Reader supports GET-only PR/list/files/reviews, check/status, run/job and narrowly
scoped branch/workflow evidence. Every token names one approved repository numeric ID
and the minimal endpoint permissions. Its scope is the approved ten repositories;
external `kunchenguid/firstmate` is unavailable in App mode. Inventory displays Reader
App identity separately from the configured review-author account and derives scope
from verified repository metadata. While live mode is OFF the existing application
GET path stays in place.

Live Repair is cmsandbox only and requires one explicitly selected owner operation:
safe update-branch with `expected_head_sha`, or a single failed job rerun bound to the
selected PR/head/run/job. Fresh provider evidence and installed grants are checked
before effects, including after token minting. No patch/ref/force/delete/main/tag,
workflow edit, broad rerun, dispatch, comment or merge endpoint is available. Reruns
require proven zero dependent jobs; see the runbook for current static push-run-only
topology coverage. GitHub reruns dependent jobs too, so unknown graphs remain held.

Live installed source executes in firstmate-selected Linux bubblewrap isolation:
distinct namespace uid/gid, read-only staged runtime and action, private proc/tmp,
cleared environment, no host files/credentials/control sockets or network. Its only
outside channel is bounded typed broker IPC. Seccomp denies process creation and OS
limits bound CPU, memory, tasks, files, descriptors, output and wall clock. There is
one source slot to protect shared host capacity. Unsupported isolation refuses to run.

The installed-action Admin Merge capability is **globally disabled**, including when a fixture CI matrix is complete.
No live Merge App profile, key reader or adapter is reachable. The existing
[cmsandbox check inventory](../data/tinstar-pr-ops-actions/cmsandbox-check-policy.v2.json)
still enforces its incomplete-workload holds; completing it does not activate Merge.

Select PRs with current captured head/base, inspect a candidate's source, manifest and
tests, then explicitly install its immutable version. Custom creation uses the existing
Discuss Ask composer. Model replies cannot install, grant or invoke a privileged operation.
Live installation happens in the broker's store, separately from simulation grants.
Rollback selects a retained version with its own grants and keeps all receipts.

Simulation registry defaults to `join(getConfigRoot(), 'actions')`, respecting
`TINSTAR_CONFIG_HOME`; `TINSTAR_ACTIONS_DIR` can select another absolute directory.
Live broker paths are private operator configuration and default under
`/var/lib/tinstar-action-broker`. Source digests bind reviewed grants to executable
code; typed scope and isolation protect production data and credentials.

Receipts persist exact intent before a provider effect and retain actor, PR/head/base,
source/version/grants, run/job identity, request, outcome and times. UI/Ask distinguish
simulation, accepted requests, completed local reads and unknown outcomes. Accepted is
not verified repair, merge or deployment. Unknown write counts are not presented as
zero. After an uncertain job rerun, one read-only reconciliation can record completion
if the selected run advanced beyond its original attempt; write attribution remains
unknown and no retry is sent. Cancellation stops unsent requests; restart never automatically retries an
ambiguous effect. Same-head ambiguous Repair and consumed job reruns remain held.

Run focused safety coverage with:

```bash
npm run test:unit -- src/server/actions src/actions src/server/pulls --maxWorkers=1 --minWorkers=1
```

All provider tests use fakes; malicious-source tests exercise real local OS isolation.
No test creates an App, mints a token against GitHub or writes to GitHub. Owner-only
App registration, key placement, activation, read verification, limits and rollback
are in [provisioning.md](../data/tinstar-pr-ops-actions/provisioning.md). Merge provisioning
is not requested.

## Send selected PRs to Clawson for admin merge

The Pulls view has a built-in **Send to Clawson for admin merge** action for the
same authenticated owner principal used by PR reads. Select up to ten PRs, then
click once. Tin Star checks their current GitHub heads, open/draft/conflict state,
active branch rules and branch protection requirements, check runs and commit
statuses. A changed head or any failed, pending, missing required or unreadable
check stops the handoff with the affected PR and reason. This prevents a card
from granting merge permission against an unverified or different commit.

One click creates one card through `create_work`'s shared workflow writer and
creation receipts: Owner **Clawson**, Status **In Progress**, Next check-in at the
click time, and Will action **Merge**. The card records the authenticated owner’s
merge word for only the listed URLs and exact heads, with one command per PR:

```text
gh pr merge <url> --squash --admin --match-head-commit <sha>
```

The card uses an **Authority** heading and a **Step 1 (run once)** Bash code
block. Before each merge, the script checks the recorded head, `MERGEABLE` state,
and zero checks in the `fail` or `pending` buckets. `set -euo pipefail` stops the
batch on a failed line. Clawson must post the output on any stop, or post each
final state and merge commit and hand back. Nothing else is authorized: no other
PR and no deploy. Red and pending checks both stop the merge. The button shows the card link and preserves selection. Double-clicks
and retries of the same selection in the mounted view reuse the same operation receipt.
If a creation response is lost, retrying recovers the existing card before fresh
GitHub preflight, even if a selected PR has since merged or changed or GitHub is
unavailable. Recovery searches all pages matching the selection-derived title for
the exact owner and operation receipt; an unconfirmed creation is never repeated.
Fresh preflight is required before a new creation. Tin Star
does not execute these commands; the installed-action Merge restrictions above still apply.

A First Mate suggested action with the optional `merge` target documented in the
[Ask reply format](features/ask.md#outbound-only-mac-puller) uses this same handoff
instead of creating an operator request. The owner’s initial click reads the PR
and binds its head. The same preflight and card authority apply. The thread shows
the card link after success or an explanation on refusal. Tin Star does not merge.

Within the mounted answer, retries reuse the operation ID. An uncertain outcome,
including an unreadable response or `create-unconfirmed`, retains and replays the
posted URL and head without another GitHub read. A definite refusal clears that
payload so the next click reads the PR again under the same operation ID. Receipt
lookup failures are unconfirmed outcomes; definite preflight refusals remain
refusals.
