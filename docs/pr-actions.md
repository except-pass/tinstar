# Installed PR actions

PRs and Releases share the existing registry, executor, scoped owner grants, receipts,
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

Admin Merge is **globally disabled**, including when a fixture CI matrix is complete.
No live Merge App profile, key reader or adapter is reachable. The existing
[cmsandbox check inventory](../data/tinstar-pr-ops-actions/cmsandbox-check-policy.v2.json)
still enforces its incomplete-workload holds; completing it does not activate Merge.

Select PRs with current captured head/base, inspect a candidate's source, manifest and
tests, then explicitly install its immutable version. Custom creation uses the existing
Desk Ask composer. Model replies cannot install, grant or invoke a privileged operation.
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
