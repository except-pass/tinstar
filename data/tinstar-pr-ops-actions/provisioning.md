# Owner runbook — later provisioning only

This branch implements a simulator. It contains no live adapter, key reader, App token
mint, GitHub mutation client or switch that enables real execution. None of the steps
below were executed. Firstmate must review the final safety-test evidence before the
owner registers or installs Apps or adds any bypass actor.

**Current technical hold:** the
[versioned cmsandbox check inventory](cmsandbox-check-policy.v2.json) remains incomplete.
See [Installed PR actions](../../docs/pr-actions.md) for the shared broker refusal and
simulation behavior. Completing the inventory and obtaining a separately reviewed
live broker/isolated runner remain prerequisites. This is an evidence gap, not a
request for a new product decision.

## Registration and installation — owner/admin only

Owner: Will or the organization administrator he designates. Next trigger: firstmate
supplies passing safety-test results **and** a complete applicable CI matrix, with a
reviewed live broker custody design. The current simulation tests alone do not lift
the technical hold.

Create three distinct Apps in GitHub account/organization Settings → Developer settings
→ GitHub Apps → New GitHub App. Suggested unique names: `Tin Star Reader`, `Tin Star Repair`,
`Tin Star Merge`. Use the actual Tin Star homepage. Disable webhooks; no user OAuth,
callback, device flow, organization permissions or event subscriptions are needed.
Choose “Any account” for the Reader if registering it under an organization so it can
be installed on both approved owners. Keep Repair/Merge installable only by the
organization that owns cmsandbox. Record each numeric App ID and slug separately.
[GitHub registration instructions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

Use these exact repository permission settings (everything omitted remains No access):

| Permission | Reader | Repair | Merge |
|---|---|---|---|
| Metadata | Read | Read | Read |
| Contents | Read | Read and write | Read and write |
| Pull requests | Read | Read and write | Read |
| Checks | Read | Read | Read |
| Commit statuses | Read | Read | Read |
| Actions | Read | Read and write | Read |

Repair needs Contents and Pull requests write for safe update-branch, and Actions
write for a single job rerun. Its token must never reach installed source. Merge has
Contents write for explicit squash-through-PR only. No app gets Administration,
Workflows, Checks-write, Statuses-write, secrets, environments or runner management.
GitHub grants these permissions at repository scope; the broker enforces the narrower
PR/ref/operation limits. A future implementation must verify actual App endpoint
support and fail closed rather than broaden permissions.

Install Reader using **Only select repositories**, in two owner-controlled installations:

- except-pass: `dirt-computing`, `quota-bar`, `tinstar`.
- fortresspower: `build-farm`, `cmsandbox`, `data-catalog`, `firmware-genome`, `hilda`,
  `keystone-designer`, `srena`.

Exactly ten repositories. No `kunchenguid/firstmate`, no All repositories. Its external
public-read route remains separate. Install Repair and Merge only on
`fortresspower/cmsandbox`. Record installation IDs, repository numeric IDs, installation
owner and actual permissions. Verify each with an installation-scoped read before
any live activation; do not infer App identity from the ambient `/user` login.

## Key custody, scoping and rotation — broker operator only

After an approved isolated broker identity exists, generate each App's private key in
its GitHub App settings and transfer it directly to that operator's protected storage:
`/var/lib/tinstar-action-broker/credentials/{reader,repair,merge}.pem`.
Use directory mode 0700 and file mode 0600, owned by the broker identity. The web server,
workers and runner must not be able to read the directory, host HOME, process environment
or control sockets. Never place keys in config sent to browsers, action source, Ask,
repository files, shell arguments or logs. Do not create a broker service identity
from this runbook without the separate deployment process.

Future broker tokens remain in memory and request explicit `repository_ids` and the
minimum `permissions` for each operation when minted. Never omit those fields and
inherit the whole installation. Reader, Repair and Merge are distinct token profiles;
no ambient-login fallback. Before expiry/rotation, generate a second key, transfer it
with the same custody, verify a read with the intended installation, switch the broker,
revoke the old key and discard in-memory tokens. Log operator, timestamp, key fingerprint
(nonsecret), App/installation IDs and scoped permission proof. Revoke affected keys and
installation access immediately on suspected exposure.

## Ruleset actor change — repository owner only, held

GitHub bypass applies to an entire ruleset, not just one review requirement. The
broker must independently require resolved threads and every applicable successful
check even when the App can bypass ruleset 6108448. The sibling ruleset 12095487,
including its PR and unattributed-change requirements, stays fully enforced. Never
expand bypass after a provider denial. [GitHub ruleset API](https://docs.github.com/en/rest/repos/rules).

When all holds are resolved, the owner uses repository Settings → Rules → Rulesets:

1. Export/save current ruleset 6108448 and 12095487 and all active rules for `main`.
   Verify 6108448 is active and its ref conditions cover only the default/main branch.
   Verify it is the review/approval/code-owner ruleset. Retain the before evidence.
2. Edit **6108448 only**, adding **Tin Star Merge** (the recorded numeric App identity)
   as an Integration bypass actor with **For pull requests only** (`pull_request`).
   Preserve all other actors, rule contents, enforcement and conditions. No `always`
   or `exempt` mode. Do not add Reader or Repair.
3. Do **not** edit 12095487 or any other ruleset. Export both after saving; compare the
   sibling byte-for-byte after canonical JSON sorting, and compare 6108448 allowing
   only this added bypass actor. Verify the new actor ID against the Merge App ID.
4. Save before/after exports, owner identity/time and the reviewed CI policy version in
   the activation audit. Abort activation if effective rules or actor scope differ.

These exact read-only commands can supply the operator's evidence (no mutation command
is required when using the settings steps above):

```bash
gh-axi api GET /repos/fortresspower/cmsandbox/rulesets/6108448 --full
gh-axi api GET /repos/fortresspower/cmsandbox/rulesets/12095487 --full
gh-axi api GET /repos/fortresspower/cmsandbox/rules/branches/main --full
```

An operator who cannot see bypass actors must inspect using the owner's ruleset access;
do not grant Administration write to any runtime App merely for inspection.

## Future activation acceptance

Firstmate owns the separate live implementation/review. It must enforce the approved
scopes, App isolation, safe ref updates, one explicit failed-job rerun, and per-PR
validation even in bulk. For each merge, re-read head/base/state, review threads, all
applicable rules and exact check identities immediately before an explicit
`merge_method: squash` request bound to `sha: <expected-head>`. Verify the merged PR and
final commit SHA; enqueued/accepted is not success. Test an actual failed check refusal.
Missing, skipped-when-required, stale, pending, cancelled, timed-out and failed checks
must all block. No zero-required-check shortcut, Ask auto-merge, generic bypass switch,
force/delete/main push, alternate merge method or ambient administrator is authorized.
A merge receipt never establishes production deployment or completes a Notion card.

For the one-job Repair capability, GitHub's
[job-rerun endpoint](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run)
also restarts dependent jobs. Before a future live broker sends it, prove the selected
job has zero dependent jobs. Current job/run REST evidence leaves topology unknown,
so the broker refuses that proposal rather than dispatching a wider retry.
