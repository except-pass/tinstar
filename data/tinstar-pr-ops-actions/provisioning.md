# Reader + Repair owner provisioning runbook

**Nothing in this runbook has been provisioned or activated.** Will (or his designated
GitHub organization administrator) owns App registration/installation and key transfer.
The broker operator owns service deployment and activation. Firstmate must first
review the safety tests and the final validated commit. The next trigger is firstmate's
handoff of that evidence; this document alone is not an activation instruction.

See the [PR actions guide](../../docs/pr-actions.md) for installed-action Merge
holds and the separate Clawson card handoff.
**Merge App: not requested.** Do not create/install it, generate its key, change any
ruleset/bypass actor, or provision a merge endpoint.

## 1. Review the code and fake-only safety evidence

On an isolated Linux checkout with Node >=22.12, bubblewrap and util-linux installed:

```bash
npm run test:unit -- src/server/actions src/actions src/server/pulls --maxWorkers=1 --minWorkers=1
npm run typecheck
```

The malicious-source tests execute the real bubblewrap boundary against a temporary
staged runtime. They test credential/host-file/proc isolation, DNS/TCP egress, host
signals, process creation, writes, malformed IPC, CPU/memory/output/wall limits and
missing isolation. Provider/IPC tests use generated **test-only** RSA keys and a fake
transport: zero real token requests, GitHub writes, Apps or installations. The final
review also runs the full unit suite and build. On macOS or a restricted Linux kernel,
source execution refuses; there is no unsandboxed fallback. Passing a fixture is not
proof of a production installation or an actual repaired PR.

## 2. Register only Reader and Repair

Use GitHub Settings → Developer settings → GitHub Apps → New GitHub App. Reader must
be installable on both approved owners (choose **Any account**); register Repair under
fortresspower and restrict it to that owner. Use the actual Tin Star homepage. Disable
webhooks and user OAuth/device flow. No organization/account permissions, callback,
event subscriptions or webhook receiver are needed. Record the two distinct numeric
App IDs and slugs. See [GitHub registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

These are the equivalent App manifest templates for review. Replace the `.invalid`
homepage/hook URL with the actual homepage; the inactive hook receives no events.
Manual settings registration avoids implementing the manifest conversion flow that
returns private keys/client secrets. If using that flow separately, its secret
response belongs only in the operator's custody, never in Tin Star's browser/API/logs.
[Manifest fields](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

Reader:

```json
{
  "name": "Tin Star Reader",
  "url": "https://replace-with-tinstar-homepage.invalid",
  "public": true,
  "hook_attributes": {"url": "https://replace-with-tinstar-homepage.invalid", "active": false},
  "request_oauth_on_install": false,
  "default_events": [],
  "default_permissions": {"metadata": "read", "contents": "read", "pull_requests": "read", "checks": "read", "statuses": "read", "actions": "read"}
}
```

Repair:

```json
{
  "name": "Tin Star Repair",
  "url": "https://replace-with-tinstar-homepage.invalid",
  "public": false,
  "hook_attributes": {"url": "https://replace-with-tinstar-homepage.invalid", "active": false},
  "request_oauth_on_install": false,
  "default_events": [],
  "default_permissions": {"metadata": "read", "contents": "write", "pull_requests": "write", "checks": "read", "statuses": "read", "actions": "write"}
}
```

Everything omitted is **No access**. Repair's App permission ceiling contains the
approved evidence permissions; each actual installation token requests only the
permissions needed by that operation:

| Operation | Token permissions (plus Metadata read) |
|---|---|
| PR/list/files/reviews | Pull requests read |
| Checks | Checks read |
| Commit statuses | Commit statuses read |
| Runs/jobs/workflow identity | Actions read |
| Branch protection flag / workflow source | Contents read |
| Safe update-branch | Contents write + Pull requests write |
| One failed leaf job rerun | Actions write |

No Administration, Workflows write, Checks write, Statuses write, secrets,
environments, runners, arbitrary refs or merge permission route is used. The broker
specifies exactly one numeric repository ID on every mint and rejects a broader
returned grant. It never falls back to ambient gh authentication. GitHub tokens can
last one hour; they stay only in broker memory. [Token scoping](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## 3. Install on the exact repositories

Choose **Only select repositories**, never All repositories:

- Reader installation on except-pass: dirt-computing, quota-bar, tinstar.
- Reader installation on fortresspower: build-farm, cmsandbox, data-catalog,
  firmware-genome, hilda, keystone-designer, srena.
- Repair installation on fortresspower: cmsandbox only.

Reader totals exactly ten repositories. `kunchenguid/firstmate` is external and is not
included. In App mode external/uninstalled sources visibly report unavailable; there
is no ambient fallback. Keep the legacy Reader path until ready to accept that
coverage change. Record installation IDs from the installation pages. Obtain numeric
repository IDs with ten explicit read-only GETs, one per name, for example:

```bash
gh-axi api GET /repos/fortresspower/cmsandbox --jq '{id,full_name,owner:.owner.login}' --full
```

Do not infer App identity from `/user`. The review-author account (normally
`except-pass`) is configured separately. After activation the broker verifies the
repository IDs/names/owners using Reader-scoped metadata reads and returns that
installation scope and authenticated actor to the inventory.

## 4. Deploy a separate broker identity and private runtime

These are **later owner/operator commands**, not commands the implementation worker
has run. Use a dedicated Tin Star web service account in place of WEB_USER. Never run the
broker under the web UID or as root. Do not modify any shared Firstmate daemon,
worktree pool, release builder or e2e service. The socket group must contain only the
broker and trusted web service identity. Do not add a general worker account; if the
current web process shares a UID with workers, the deployment operator must first
separate that web identity. Unix permissions are the broker client-auth boundary.

```bash
sudo groupadd --system tinstar-actions
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid tinstar-actions tinstar-action-broker
sudo usermod -aG tinstar-actions WEB_USER
sudo install -d -o tinstar-action-broker -g tinstar-actions -m 0700 /var/lib/tinstar-action-broker
sudo install -d -o tinstar-action-broker -g tinstar-actions -m 0700 /var/lib/tinstar-action-broker/credentials
sudo install -d -o root -g tinstar-actions -m 0750 /etc/tinstar-action-broker
```

If an identity/group already exists, inspect and reuse the intended one rather than
recreating it. Deploy the reviewed package under `/opt/tinstar`, readable by the broker,
with its normal dependencies/build output. `npm run build:all` ships separate
`dist/server/standalone.js` and `dist/server/brokerMain.js` entrypoints. The web process
imports only the Unix IPC client; it does not load the key custodian.

Stage the trusted Node binary and its linked libraries, plus prlimit, into the dedicated
runtime. Use an installed Node binary outside host homes. The script deliberately
requires an unused destination; retain an old runtime for operator rollback when
updating it. It copies only these executables/libraries and empty mount points, never
host HOME/config data. Example after deployment:

```bash
broker_node="$(node -p 'process.execPath')"
sudo -u tinstar-action-broker "$broker_node" /opt/tinstar/bin/tinstar-stage-action-runtime.js /var/lib/tinstar-action-broker/runtime
```

The runtime is bound read-only as the runner's entire filesystem. Only reviewed source,
a target JSON snapshot and Tin Star's bootstrap are additionally mounted read-only.
The runner has uid/gid 65534 in an unshared user namespace, private PID/mount/network/
IPC/UTS namespaces, a fresh proc and a 16 MiB private tmpfs. Environment is cleared
(bubblewrap supplies only `PWD=/tmp`). Seccomp denies fork/vfork/process clones while
allowing bounded Node threads. OS limits: 2 CPU seconds, 1 GiB virtual address space,
32 tasks, 64 descriptors, 16 MiB files, no core dumps; Node heap is capped at 64 MiB.
Manifest limits further bound wall clock (at most 30 seconds), output (64 KB) and
broker calls (32). One source execution slot protects shared host capacity.

## 5. Place only the two private keys and nonsecret config

After the safety evidence is accepted, generate each App private key in its GitHub App
settings. Transfer it directly from the owner to the broker operator's protected file
transfer channel. Do not paste a key into a command, environment variable, log, Ask,
action source, browser response or repository. Using paths to the protected received
files, install them as:

```bash
sudo install -o tinstar-action-broker -g tinstar-actions -m 0600 /PROTECTED-INCOMING/reader.pem /var/lib/tinstar-action-broker/credentials/reader.pem
sudo install -o tinstar-action-broker -g tinstar-actions -m 0600 /PROTECTED-INCOMING/repair.pem /var/lib/tinstar-action-broker/credentials/repair.pem
sudo -u WEB_USER test ! -r /var/lib/tinstar-action-broker/credentials/reader.pem
sudo -u WEB_USER test ! -r /var/lib/tinstar-action-broker/credentials/repair.pem
```

Keys must be broker-owned 0600 files in a broker-owned 0700 directory. Missing keys,
wrong ownership/modes, invalid PEM, missing IDs, or uninstalled repositories refuse
with **not provisioned**. No credentials exist by default. Custody is configurable
through the broker's private config; key filenames remain reader.pem and repair.pem.

Write `/etc/tinstar-action-broker/config.json` with actual IDs. **Every number below is
an example placeholder**, including `webUid`; replace all of them with verified IDs.
`ownerLogins` must match Tin Star's authenticated owner configuration.

```json
{
  "webUid": 1000,
  "ownerLogins": ["OWNER_TAILSCALE_LOGIN"],
  "reviewAuthor": "except-pass",
  "custody": "/var/lib/tinstar-action-broker/credentials",
  "socket": "/run/tinstar-action-broker/broker.sock",
  "actions": "/var/lib/tinstar-action-broker/actions",
  "runtime": "/var/lib/tinstar-action-broker/runtime",
  "reader": {"appId": 101, "installations": [
    {"installationId": 201, "repositories": {"except-pass/dirt-computing": 301, "except-pass/quota-bar": 302, "except-pass/tinstar": 303}},
    {"installationId": 202, "repositories": {"fortresspower/build-farm": 304, "fortresspower/cmsandbox": 305, "fortresspower/data-catalog": 306, "fortresspower/firmware-genome": 307, "fortresspower/hilda": 308, "fortresspower/keystone-designer": 309, "fortresspower/srena": 310}}
  ]},
  "repair": {"appId": 102, "installations": [
    {"installationId": 203, "repositories": {"fortresspower/cmsandbox": 305}}
  ]}
}
```

Make config root-owned and group-readable, mode 0640; group/others must not be able to
write it. The broker additionally refuses a duplicate repository mapping, a repo
outside the approved scope or the same App ID for Reader and Repair. These checks
prevent accidental privilege expansion or shared write/read identity.

## 6. Operator switch, read verification, then explicit Repair

Use one optional activation file shared by the existing web unit and broker unit:
`EnvironmentFile=-/etc/tinstar-action-broker/activation.env`. Leave that file **absent**
until the safety evidence, identities, runtime and config have been verified. Absent
or any value other than the exact setting below leaves real execution OFF; the web
continues its existing authorized GET path and trusted simulations.

Install an operator-managed service with these settings, replacing the Node executable
with the actual non-home installation path:

```ini
[Service]
User=tinstar-action-broker
Group=tinstar-actions
UMask=0007
RuntimeDirectory=tinstar-action-broker
RuntimeDirectoryMode=0750
Environment=TINSTAR_ACTION_BROKER_CONFIG=/etc/tinstar-action-broker/config.json
EnvironmentFile=-/etc/tinstar-action-broker/activation.env
ExecStart=/opt/tinstar-node/bin/node /opt/tinstar/bin/tinstar-action-broker.js
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/tinstar-action-broker /run/tinstar-action-broker
Nice=15
CPUQuota=25%
MemoryMax=384M
TasksMax=48
```

Have the deployment operator install/start that service and restart only the existing
Tin Star web unit to pick up its group and environment. The broker listens only on its
0660 Unix socket, never a TCP port. No :8450, Docker or e2e slot is involved. The broker
refuses a preexisting socket instead of unlinking another process's endpoint; after a
crash the operator checks that this dedicated service is stopped and removes only its
stale socket before starting. Do not remove a live socket.

After the safety review, the operator creates the activation file containing exactly:

```dotenv
TINSTAR_ACTIONS_LIVE=reader-repair
```

Restart the two dedicated Tin Star units through the normal deployment process.
If using a nondefault socket, set `TINSTAR_ACTION_BROKER_SOCKET` on the web unit to the
same nonsecret path; this is routing, not a second execution switch. The broker config
path can be selected with `TINSTAR_ACTION_BROKER_CONFIG` on the broker unit.

First verify only GET data (the local POST below is typed read IPC, not a GitHub write):

```bash
sudo -u WEB_USER curl --fail --silent --show-error --unix-socket /run/tinstar-action-broker/broker.sock http://localhost/identity
sudo -u WEB_USER curl --fail --silent --show-error --unix-socket /run/tinstar-action-broker/broker.sock -H 'Content-Type: application/json' --data '{"path":"/repos/fortresspower/cmsandbox/pulls?state=open&per_page=1"}' http://localhost/reader
```

Confirm the returned actor is Reader App, review author is correct, and the verified
scope lists exactly the ten repositories. Check PR inventory/files/reviews/checks in
the owner UI. Outside-scope requests must refuse; no ambient fallback is acceptable.
Missing credentials/socket must show not provisioned. These production verification
reads may mint short-lived read tokens inside the broker after activation; the
implementation's tests never do so against GitHub.

Inspect/install an action version again through the live owner UI. Live mode has a
separate broker-owned registry/grants/audit store; it never trusts a caller-supplied
grant or silently imports the web process's simulation grants. Only then may the
owner explicitly select **one** cmsandbox PR and invoke safe update-branch or one failed
job rerun. This is a real GitHub write and must be a deliberate owner operation; do
not include it in automated smoke verification. The receipt records initiating login,
PR/head/base, installed source/grants, exact method/path/body, run/job identity when
applicable, start/finish and outcome. Accepted is not verified completion or deployment.

Job rerun has an additional narrow technical hold: GitHub's endpoint reruns dependent
jobs too. This build can prove a leaf only for a completed first-attempt **push** run
whose exact-head workflow source has an unambiguous static job identity, no matrix or
reusable workflow, and no `needs` edge to it. PR-merge-ref runs and unknown/dynamic graphs
refuse. The final read must also match the selected branch/head/run/job. A consumed or
ambiguous rerun never repeats, including after restart or selection through another PR.
There is no run-wide fallback, debug rerun, retry loop or workflow dispatch.
[Provider behavior](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run).

## 7. Rollback, reconciliation and key rotation

Remove the `TINSTAR_ACTIONS_LIVE` line from the activation file and restart the web and
broker units using the normal deployment process. The web returns to legacy GET reads
and simulation-only execution. Stop the dedicated broker if revoking access, and
suspend/uninstall the affected App installation or revoke its key in GitHub. No ruleset
rollback is needed because no ruleset or Merge App change is requested.

Retain the broker's append-only receipts and installed versions. Restart marks unfinished
intent unknown; a live request with uncertain acceptance has an unknown write count,
not a claimed zero. Compare the exact PR head and run/job attempts with GitHub before
any follow-up. Same-head ambiguous Repair is held, and a consumed job stays held; do
not delete receipts to retry it. If a provider effect cannot be reconciled, report that
hold to firstmate rather than bypassing it. Cancellation stops unsent requests and
never claims to undo an accepted request. Rollback of installed source does not erase
receipts or inherit expanded grants.

To rotate: disable live execution, stop the dedicated broker to discard in-memory
tokens, generate a replacement App key in GitHub settings, transfer/install it with the
same 0700/0600 custody, restart and re-enable after read verification, then revoke the
old key. GitHub may retain previously minted tokens until expiry unless installation
access is revoked; revoke/suspend installation access on suspected exposure. Record
the operator/time, App/installation IDs, approved repo/permission scope and a nonsecret
key fingerprint. Never record the key, JWT or token.

The broker uses in-process HTTPS to keep all authentication in its own memory. The
installed gh-axi API accepts explicit headers in argv and normal authentication in
process environment; neither is suitable for this token boundary. Ambient gh-axi
remains only the legacy GET reader while live mode is OFF and the owner's explicit
read-only metadata inspection tool. No worker or generated action receives a token.
