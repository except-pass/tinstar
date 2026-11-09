# Guarded floor deploy

Use `scripts/deploy/floor-deploy.sh` for each floor deploy, including unattended
invocations. It replaces the manual fetch/checkout/install/test/build/restart
sequence. It fetches `origin/main`, checks it out detached, installs dev dependencies,
runs **typecheck and the complete unit suite**, builds the shipped client/server,
then restarts the floor, facade and tunnel in that order. No unit
is restarted if any build gate fails. The source checkout must be clean.

The script gives owner availability and MCP read checks a shared retry deadline
(60 seconds after the helper starts by default); individual HTTP requests can
finish after that deadline. It performs one synthetic Ask round trip and
read-only MCP checks.
After acquiring the lock and checking the existing block, any failure exits
nonzero, prints an `ALERT Tin Star deploy:` line to stderr, and attempts to write
`deploy.blocked`. Failure to persist the marker is reported in the alert and
requires operator intervention. Earlier failures, including lock contention,
do not create a marker. Subsequent invocations refuse an existing marker before
fetching or restarting.
A config-directory `flock` serializes deploys so concurrent invocations cannot
race past the block. No daemon, monitoring service, notification credential or
production infrastructure is installed. The calling CI/scheduler must retain
stderr and notify its operator on a nonzero exit. The marker cannot prevent an
operator bypassing the wrapper and deploying by hand.

## Hulk defaults and configuration

Run from the deployed checkout (the wrapper requires Node, npm, git, Bash, flock,
systemctl and noninteractive sudo permission to restart the selected units):

```sh
/home/farm/srv/tinstar-src/scripts/deploy/floor-deploy.sh
```

All configuration uses environment variables; no shell config file is sourced.
Credential values are read inside the smoke helper and never placed in process
arguments or printed, even on errors. HTTP requests reject redirects.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TINSTAR_DEPLOY_SOURCE` | `/home/farm/srv/tinstar-src` | Dedicated deploy checkout, clean before deploy |
| `TINSTAR_CONFIG_HOME` | `/home/farm/srv/tinstar-config` | Floor state; `config.json` contains `ask.ownerLogins` and `ask.bridgeToken` |
| `TINSTAR_DEPLOY_BLOCK` | `$TINSTAR_CONFIG_HOME/deploy.blocked` | Durable failure latch; use the same path on every deploy |
| `TINSTAR_FLOOR_UNIT` | `tinstar-floor` | systemd unit |
| `TINSTAR_FACADE_UNIT` | `tinstar-mcp-facade` | systemd unit; also queried for last start time |
| `TINSTAR_SHIM_UNIT` | empty | Optional legacy shim unit; no shim restart by default |
| `TINSTAR_TUNNEL_UNIT` | `tinstar-mcp-tunnel` | Restarted after the facade to refresh its startup catalog |
| `TINSTAR_OWNER_URL` | `https://hulk.taile890bc.ts.net:8450` | Real authenticated owner route, via Tailscale Serve |
| `TINSTAR_BRIDGE_URL` | `http://127.0.0.1:5281` | Real `/api/ask/bridge` |
| `TINSTAR_FACADE_URL` | `http://127.0.0.1:5297/mcp` | Facade `tools/list` |
| `TINSTAR_TUNNEL_TARGET_URL` | `http://127.0.0.1:5297/mcp` | Actual configured tunnel target (facade directly) |
| `TINSTAR_TUNNEL_HEALTH_URL` | `http://127.0.0.1:5298` | `/readyz`, `/api/status`, `/metrics` |
| `TINSTAR_CALLER_HEADER_FILE` | `/home/farm/.config/tinstar-tunnel/facade-caller-header` | Private file containing `Bearer <caller-token>`; never the backend install token |
| `TINSTAR_APPROVED_TOOLS_FILE` | `scripts/deploy/approved-tools.json` beside helper | Explicit approved names; default matches Hulk's read + view facade |
| `TINSTAR_SMOKE_WAIT_MS` | `60000` | Startup grace for owner/MCP read checks |
| `TINSTAR_FACADE_STARTED_AT` | Read from systemctl `ActiveEnterTimestamp` | Preview/test override only, ISO timestamp |

The script does not change a unit's environment or URLs. Those must match the
selected deployment configuration. Changing a facade to read-only requires a
corresponding approved names file; do not silently accept a missing tool. Hulk's
shim is retired: the facade handles the tunnel protocol directly, and the defaults
neither restart nor target a shim. Legacy installations can explicitly set
`TINSTAR_SHIM_UNIT` and `TINSTAR_TUNNEL_TARGET_URL` together. Approved names are
an intentional caller scope contract: an added, removed or duplicated tool fails the smoke because it
can either break ChatGPT's expected tools or expose a tool outside approved scope.
Descriptions, annotations, schemas and other tool fields must also match between
the facade and target (JSON object key order and tool ordering are ignored).

`--check-only` runs the same post-deploy checks and failure latch without checkout,
build or restart. It still creates/removes a synthetic Ask record, acquires the
deploy lock and refuses an existing block. It is useful for a preview or an
operator verifying recovery, not a way around the block.

## Synthetic Ask isolation

The smoke POSTs to the ordinary `/api/ask/requests` owner route with the normal UI
handshake and configured owner identity, **plus** bridge bearer authentication and
a random `synthetic_id`. On the tailnet URL, Tailscale Serve must authenticate the
operator and inject the actual owner login. Supplying the configured login in a
client header cannot bypass Serve's identity. A preview can use loopback and the
same server-side owner check without tailnet access.

Synthetic creation uses a reserved all-zero card anchor so this health check does
not depend on a Notion card or query First Mate. It uses the same store create,
bridge note/reply ingestion and persisted conversation read paths as real Ask.
The helper reads just that partition from the real `/api/ask/bridge`, acknowledges
a synthetic note, submits a unique plain-text answer, then verifies the answer
through the owner conversation route. **No fm-inbox, clavis, First Mate call or
Mac puller is invoked.** This checks the deployed server's round trip; the
published Mac puller's compatibility is a separate CI contract check.

`synthetic_id` is private stored metadata, omitted from public Ask items. Ordinary
bridge reads exclude synthetic rows from **both pending and tracked** work;
ordinary bridge updates and conversation reads cannot address them. Desk lists,
follow-ups, selections and row actions cannot find them. Only bridge reads with
that exact `?synthetic_id=<uuid>` see smoke work. Owner conversation reads with
the partition require both owner and bridge credentials.

A `finally` deletes only that random partition using authenticated
`DELETE /api/ask/bridge?synthetic_id=<uuid>`, even if the create response was lost.
Cleanup is idempotent. Cleanup failure fails the smoke. A killed process or host
outage can leave an invisible synthetic row; it never becomes real puller work.
An operator can recover leftover partition IDs from private `ask-requests.json`
and delete them using the same authenticated API; never rewrite the live store
behind a running server. Treat that file as private owner data.

## MCP evidence and its limits

The smoke requires all of these:

1. Tunnel `/readyz` returns exactly HTTP 200, before and after catalog checks.
2. The facade's authenticated `tools/list` exactly matches approved tool names.
3. The actual tunnel target's authenticated `tools/list` matches the **complete**
   facade catalog, including schemas. All pages are read. This catches a stale or
   incorrectly configured shim as well as a wrong facade scope.
4. Tunnel `/api/status` identifies the enabled, healthy `main` channel and the
   exact target URL checked above. Its `started_at` is no earlier than the
   facade's last systemd start.
5. `/metrics` reports a successful control-plane poll timestamp at or after that
   tunnel start. tunnel-client 0.0.20 holds polling until its startup catalog has
   succeeded; together with restarting the tunnel after the facade, this is
   evidence that this generation passed the startup catalog gate and contacted
   the control plane. The known `startup catalog failed; polling disabled` state
   fails readiness and/or this poll check. An unreadable timestamp or missing
   metric fails visibly rather than treating an old catalog as current.

**The local 0.0.20 health JSON and journal do not expose the remote published MCP
tool catalog for independent equality readback.** The harpoon startup digest is
for a different catalog and cannot establish MCP tool equality. This script proves
source/target equality and a fresh startup/publication gate, not the contents of
a cached catalog served to ChatGPT, remote cache propagation or a successful
ChatGPT tool invocation. It does not call privileged control-plane APIs or read
runtime credentials to imply otherwise. If independent remote readback becomes
available, add it here; until then the above limitation is explicit. Runtime
telemetry changes should update the smoke and its executable tests together.

## Failure recovery

Read the failed phase from the block marker and the deployment log. Investigate
and repair the underlying problem (including credential permissions or service
configuration). The script deliberately does not roll back or keep deploying over
a failed floor. The old process may still be running after a failed build; after
a failed restart or smoke, some units may already run the new code.

Only after the operator has diagnosed the failure, remove the configured block
and rerun the wrapper (or `--check-only` when all units are already repaired):

```sh
rm -- "$TINSTAR_CONFIG_HOME/deploy.blocked"
/home/farm/srv/tinstar-src/scripts/deploy/floor-deploy.sh --check-only
```

Use the actual configured marker path if `TINSTAR_DEPLOY_BLOCK` was overridden.
A failed recovery check immediately reinstates the block. Keep this manual step
visible in the operator runbook; an automated job must never clear the marker.

## Preview proof

Do not run deployment validation against the live floor. First check that
`127.0.0.1:5293` is free, and use
`TINSTAR_CONFIG_HOME=/home/farm/srv/tinstar-preview-config-2`. Run the built preview
on loopback and override both owner and bridge URLs to `http://127.0.0.1:5293`.
Use separate preview caller credentials, facade/target/health ports, approved
tools and a preview facade start timestamp; never reuse live tunnel config.
`--check-only` performs the complete check without restarting any production unit.

Deploy tests clear ambient `TINSTAR_*` settings and related shell/Node startup
hooks, then explicitly configure each isolated fixture. Exporting deploy URLs or
unit names when running the suite cannot redirect its requests or restarts.
Behavioral shell tests use executable git/npm/systemctl command doubles and real
HTTP Ask routes in isolated temp configs. They verify restart ordering, no
restart after test failure, no credentials in output, smoke cleanup, durable
blocking and refusal of the next deploy. Server tests prove partition isolation
across reloads. CI also runs ShellCheck on the wrapper.
