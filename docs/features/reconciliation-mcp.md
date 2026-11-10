# Conversational Overview

Tin Star exposes a real [MCP SDK Streamable HTTP](https://ts.sdk.modelcontextprotocol.io/server) endpoint at `POST /api/reconciliation/mcp` on the existing backend. It reads the configured reconciliation sources and steers a selected Overview or Decisions tab. The UI uses the same pure semantic reducer as clicks. It also exposes [shared work reads and policy-aware workflow operations](workflow.md), independent of any window. There are no shell execution, dispatch, approval, merge or domain-priority tools.

## Start and connect

For ready request navigation and owner routing, see the [queue contract](reconciliation-queue.md).

Use Node >=22.12. Configure fleet/Notion reads as described in [reconciliation-floor.md](reconciliation-floor.md). The configured list covers only those homes; a successful connection does not certify a whole-farm census. No extra source credentials or public listener are created by MCP.

```sh
npm ci
npm run build:all
TINSTAR_CONFIG_HOME=/absolute/private/tinstar-config node bin/tinstar.js --host 127.0.0.1 --port 5281 --no-open
```

Open `http://127.0.0.1:5281/`. Each window has an ephemeral `scene_id` available through `list_ui_sessions` (also the view's `data-scene-id` attribute for browser tests). Two tabs have separate IDs, revisions and selections. A reload creates a new ID. Overview and Decisions keep the same registered scene while switching between them; other views disconnect the presentation bridge until return. One of these two views must remain open to apply commands; background browser throttling can delay acknowledgments. See the [Decisions reference](reconciliation-queue.md#decisions-tab) for its focus and flash behavior.

The first backend start creates `<TINSTAR_CONFIG_HOME>/mcp-token` (default `~/.config/tinstar/mcp-token`), a random per-install token with mode 0600. Tin Star never prints it or sends it to the browser. Config permission trouble disables MCP with a visible API error while source viewing continues. The operator can rotate the token by removing that file while the backend is stopped, restarting, and updating their client’s private secret. Do not paste it into chat, command history, screenshots or source control.

Use a conversational client with **Streamable HTTP and custom Authorization headers**. In its private connection settings, supply:

```json
{
  "url": "http://127.0.0.1:5281/api/reconciliation/mcp",
  "headers": { "Authorization": "Bearer <contents of your private mcp-token file>" }
}
```

This is the transport configuration, not a universal client configuration-file format. Some clients support OAuth only; those cannot use this initial private-token interface directly. The official MCP Inspector accepts a Streamable HTTP URL and custom request headers; SDK clients can use `StreamableHTTPClientTransport` with `requestInit.headers` (example below). Use the client’s secret settings, rather than putting the literal credential in a repository.

Localhost is the default. For a remote client, the operator must explicitly bind the existing backend to its Tailscale address and permit the intended tailnet client under the tailnet ACLs; set the URL to that private address. Both MCP and its UI bridge reject peers outside loopback/Tailscale IPv4/IPv6 ranges, ignore forwarded headers, and enforce the application origin policy for browser requests. Do not publish, forward or reverse-proxy this route publicly: a proxy running on localhost would itself be a trusted network peer. For an outbound ChatGPT tunnel, use the separately authenticated scoped facade below; never target this private route directly. Remote web/desktop UI origins must also be in the existing application origin allowlist. No network configuration is silently changed.

## Scoped outbound tunnel facade

`tinstar-mcp-tunnel` is a separate loopback-only MCP facade for an existing backend.
It forwards only the approved tools below using that backend's canonical projection and command receipts; it has no source collector or UI bridge of its own.
The private `/api/reconciliation/mcp` endpoint remains private.
Build with `npm run build:all`, then run:

```sh
TINSTAR_CONFIG_HOME=/absolute/private/tinstar-config node bin/tinstar-mcp-tunnel.js \
  --upstream-port 5281 --port 5297 \
  --caller-id owner-chatgpt --caller-token-file /absolute/private/facade-caller-header
```

The facade binds only `127.0.0.1`, exposes `/mcp`, and exposes the read tools and shared workflow mutations listed below to authenticated consumers. Its default port is 5296; the examples and LIVE handoff explicitly select 5297.
Add `--allow-view` explicitly to authorize `present_view` and `next_queue_item`; these change presentation only.
The approved caller boundary is the private org tunnel. Generate a separate opaque random token of at least 32 non-whitespace characters. Store the full Authorization header value in a single owner-only file shared by the facade and tunnel-client: `Bearer <opaque-random-token>` on one line, with an optional trailing newline. Raw tokens, extra lines and double prefixes are rejected by the CLI. Normal ChatGPT needs no extra authentication; tunnel-client injects the header from this file.
Both credential files must be owned by the runtime user with no group/other permissions (normally 0600).
The facade reads the existing install token from `TINSTAR_CONFIG_HOME/mcp-token` without creating or rotating it.
Never use the install token as the caller token.
Missing/invalid caller configuration prevents startup; wrong, missing or duplicate Authorization and browser origins are rejected.
Forwarded identity headers grant no authority.

The facade accepts stateless `2026-07-28` requests from ChatGPT/tunnel-client as
well as the existing SDK `2025-11-25` path. Modern requests carry matching
`Mcp-Protocol-Version` and `params._meta['io.modelcontextprotocol/protocolVersion']`,
plus `Mcp-Method` and (for calls) `Mcp-Name`. `server/discover` advertises the
facade's supported versions and tools capability; `tools/list` returns only the
configured caller's tools. Discovery and tool lists use private, zero-TTL cache
hints and all responses retain `Cache-Control: no-store`.
SDK 1.x does not yet support this revision, so compatibility is confined to the
facade's discovery/list/call requests; the private backend transport is unchanged.
No version-rewriting proxy is needed in front of the facade.

For the facade command above, the tunnel runtime must target `http://127.0.0.1:5297/mcp`, for example:

```sh
tunnel-client run \
  --control-plane.tunnel-id tunnel_YOUR_EXISTING_ID \
  --control-plane.api-key file:/home/farm/.config/tinstar-tunnel/control-plane-api-key \
  --mcp.server-url 'url=http://127.0.0.1:5297/mcp,channel=main' \
  --mcp.extra-headers 'Authorization: file:/absolute/private/facade-caller-header' \
  --health.listen-addr 127.0.0.1:0
```

The control-plane key is already placed at the path above; never read or print it. Keep credentials out of argv values, environment values, logs and source control; only file paths appear in commands.
Do not enable embedded stub mode, payload capture, raw HTTP logging or public health listeners.
The facade checks the injected bearer on every request, sends the separate install token and its configured caller credential to the fixed localhost backend, and refuses redirects. The backend verifies both credentials for configured PR-read grants; client-supplied identity and owner headers are never forwarded. It does not implement OAuth/DCR or advertise an OAuth issuer.

Firstmate owns deployment and live ChatGPT acceptance after deploy; local SDK/browser proof does not establish live acceptance. Presentation tools still require `--allow-view`; shared workflow tools use the same authenticated caller boundary. Catalog changes require connector refresh after deploy. Do not modify or restart the existing live tunnel during validation.

For the LIVE floor operator handoff, use the installed Node executable and deployed repository directory as the service's working directory. The exact facade command is:

```ini
Environment=TINSTAR_CONFIG_HOME=/home/farm/srv/tinstar-config
ExecStart=/usr/bin/env node bin/tinstar-mcp-tunnel.js --port 5297 --upstream-port 5281 --caller-id owner-chatgpt --caller-token-file /home/farm/.config/tinstar-tunnel/facade-caller-header --allow-view
```

Use that same caller file path in the tunnel's `--mcp.extra-headers 'Authorization: file:/home/farm/.config/tinstar-tunnel/facade-caller-header'`; the mapping remains `url=http://127.0.0.1:5297/mcp,channel=main`. Use the caller-file format and ownership requirements above. The backend's `mcp-token` remains a separate raw install token.
Restart the facade after rotating either credential; restart tunnel-client after caller-file rotation so both use the same value. The facade never installs a service or changes tunnel configuration automatically. These are operator handoff instructions, not validation commands against the live floor.

Whenever the facade tool catalog changes (tools added, removed or renamed), refresh tools in the ChatGPT connector settings (chatgpt.com settings -> Connectors -> Tinstar -> refresh); ChatGPT caches the tool list from connector discovery and keeps showing stale tools until refreshed.

## Tools and authority

| Tool | Result |
| --- | --- |
| `search_work(...)` | Scoped, paginated work properties, UI search predicates, links, evidence and coverage without a browser |
| `get_work(...)` | Exact configured-board card, bounded body/comments, linked worker/PR evidence and freshness without a browser |
| `get_workflow_rules()` | Current code-enforced [workflow rules and operation contracts](workflow.md) |
| `get_work_views()` | Shared [Needs Will and advisory execution warnings](workflow.md#slice-3-shared-operational-views-and-normal-use), without a browser; PR details retain the existing owner authorization boundary |
| `start_work(...)`, `create_work(...)`, `update_work(...)` | [Shared workflow operations](workflow.md): contracts, enforced rules and partial-save handling |
| `submit_handoff(...)` | [Approved implementation handoffs](workflow.md#one-call-approved-implementation-handoffs): recording, assignment outcomes, full-contract retrieval and rollout requirements. |
| `list_ui_sessions` | Window IDs and six-character codes, owner designation, surface/route/title, visibility/focus, selection, commit timestamp, source timestamp, last heartbeat and revision; no browser session secrets |
| `get_scene(scene_id? / session_code?)` | Last browser-applied presentation, rendered-scene timestamp/read-failure status, current server freshness/coverage, counts, semantic card/actor/claim indexes, legacy arrangements and shared organizer groups |
| `read_record(scene_id, target, evidence?)` | Actor/execution, manager, task/card, claim, group or root; optional bounded claim evidence and source freshness |
| `get_card_context(scene_id, card_id)` | Authorized board card properties plus bounded Notion prose, with explicit availability/omissions |
| `get_queue(scene_id)` | Ordered readiness, exact per-source identities/readiness and response anchors, or `queue-source-unavailable`; see [queue reconciliation effects](workflow.md#first-mate-decision-reconciliation) |
| `get_worker_link_report()` | Read-only [worker-link backfill report](../notion-worker-links.md#slice-b-backfill-and-deterministic-mismatch-report); no open window or `scene_id` required |
| `list_prs(offset?, limit?)` | Shared PR Operations open inventory, captured heads, card links and coverage; requires a verified owner binding |
| `get_pr(url, head, include_files?, offset?, limit?)` | Shared exact-head description, checks, reviews, optional file metadata and card/worker attribution; requires a verified owner binding |
| `get_release_status(offset?, limit?)` | Shared Releases PR-first observations, links, production receipts/ancestry, dry-run eligibility and verification requirements; no owner/write authority |
| `present_view(...)` | Enqueue a semantic action for one selected tab and wait up to two seconds for its acknowledgment |
| `next_queue_item(...)` | Navigate the real S4 ordered verified-ready queue with the same acknowledgment protocol |
| `get_command(scene_id, command_id)` | Query a prior command outcome without applying it again |

### PR and release reads (Slice B)

These tools use the same `PullsApi` / `ReleasesApi` instances as the UI, including
its bounded demand caches and shared `AssociationStore`. They require no open
Overview window. They never write associations, change releases or approve PRs.

The authoritative input schemas and defaults live in
[`registerDomainReadTools` and its shared pagination schema](../../src/server/reconciliation/domainReads.ts)
and are exposed through MCP `tools/list`.

**PR reads require an explicit, revocable caller grant (owner-approved Option A).**
With no matching grant, `list_prs` and `get_pr` return
`{outcome:"unauthorized", prerequisite:"...verified owner binding..."}` before
invoking private PR readers. In the backend's private `config.json`, configure:

```json
{
  "mcp": {
    "prReadGrants": [{
      "callerId": "owner-chatgpt",
      "callerTokenFile": "/absolute/private/facade-caller-header",
      "ownerLogin": "existing-owner@example.com"
    }]
  }
}
```

Merge this key into the existing configuration. `ownerLogin` must already be in
`ask.ownerLogins` under the same valid Ask configuration used by browser PR
Operations. `callerTokenFile` is the same owner-only file supplied to the existing
facade's `--caller-token-file` (one `Bearer <separate-token>` line); no secret
values go in config or PR evidence. The facade must run the updated code to
forward its authenticated proof. The backend requires its own `mcp-token` plus
the matching caller ID **and** separate caller credential. Knowing an ID or
installation token, sending an owner header, or reaching loopback/the tunnel
alone grants no PR access. No browser session is needed and no owner header is
synthesized.

Configuration, owner membership and credential files are reread for every PR
call. Delete the entry to revoke on the next call, without restarting backend or
facade; already running reads may finish. Missing, malformed, mismatched or
unreadable configuration/credentials fail closed. Rotating the caller file
revokes the old proof immediately; restart the facade and tunnel-client to load
the new caller credential as described above. Backend installation-token
rotation still requires a backend restart under its existing token lifecycle.

This grant is consulted **only** by `list_prs` and `get_pr`. They retain the shared
PR Operations repository/owner scope and bounded outputs. It grants no browser
API access, merge, approval, review submission, dispatch, Notion write, workflow
mutation or release authority. Existing tool permissions remain independent;
`get_release_status` needs no PR grant. Firstmate adds the live entry after merge
and guarded deployment; this documentation does not establish live availability.
Then request one ChatGPT connector refresh and verify both reads through ChatGPT
against the same PRs in PR Operations before claiming live acceptance.

Once authorized, inventory preserves the authenticated reader account/scope,
canonical `repository#number` identity, captured head, multiple active/historical
association events, repository statuses and `associationsComplete`. CI/reviews
load on demand with `get_pr`; the inventory cannot decide “needs review”. Detail
rechecks the current origin before consulting head-keyed caches, retains unknown
or partial checks/reviews, and returns the shared attribution projection with its
completeness and claim verification/state fields. Files are bounded metadata,
with independent source completeness and response pagination. No patches are
returned. Observed approval/CI is never a merge permission or branch-policy claim.

`get_release_status` calls `ReleasesApi.read(false)`. Its `pulls`,
`unassociatedCards`, `reconciliation.cards` and `reconciliation.targets` are each
paginated independently using the same `offset`/`limit`. Each collection has its
own `{total,next_offset}` under `pagination`; follow every relevant next offset.
These totals describe observed rows, not a certified production queue count.
All collection warnings, association completeness, GitHub sync status, receipt
source status/timestamps, per-target provenance and opt-in verification decisions
remain visible. An `available` outcome means the projection was read; inspect
those fields to determine whether its sources are complete/fresh. A source outage
returns `unavailable` and unknown status rather than an empty successful queue.
Automation drafts are omitted; eligibility remains a dry run. Missing evidence
or a tag alone never proves production shipment.

Pagination is a view of the current shared projection, not a frozen snapshot;
source refreshes can change membership between pages. There is no new service,
cache or persistent graph. After deployment, follow the
[connector catalog refresh instructions](#scoped-outbound-tunnel-facade).

Targets have `{kind,id}`. Kinds are `card`, `execution`, `claim`, `manager`, `group`, `you` and `firstMate`. Use IDs returned by reads, never title matching. Executions retain First Mate home/task/attempt identity. Claims distinguish confirmed, textual, inferred and conflicting relationships.

`present_view` requires `command_id`, `expected_revision`, and `action`; use the user-confirmed `scene_id` or `session_code`, or omit both to use the owner-designated tab (a sole connected tab is also unambiguous). Multiple connected tabs with no designation return `ambiguous-session`; never select by last heartbeat. An explicit ID remains backward compatible. Optional `ttl_ms` is 500–15000 (default 8000). The authoritative action shapes and validation bounds, including Smart Search conditions, reveal, clear and view restoration, live in [`actionSchema` and `searchFilterSchema`](../../src/shared/reconciliationCommands.ts). The following lists the non-search actions:

```text
{type:"set-organizer", organizer:{outer:field|"none", inner:field|"none", order:field|"operational", direction:"asc"|"desc"}}
{type:"set-status-filter", filter:{preset:"operational"|"all"|"custom", statuses:string[]}}
{type:"set-donut-filter", filter:{cards:string[], workers:string[]}}
{type:"clear-donut-filter"}
{type:"reset-floor"}
{type:"set-sort", sort:"activity"|"priority"}
{type:"set-links", visible:boolean}
{type:"set-arrangement", arrangement:"initiative"|"secondMate"|"machine"}
{type:"set-expanded", target:{kind:"manager"|"group",id}, expanded:boolean}
{type:"navigate-card", cardId:string}
{type:"focus", target:{kind,id}}
{type:"set-exceptions", enabled:boolean}
{type:"set-roadmap", expanded:boolean}
{type:"open-queue", cardId?:string, itemId?:string}
{type:"navigate-queue", direction:"next"|"previous"}
{type:"close-queue"}
{type:"flash", targets:[{kind,id},...], durationMs?:0..4000}
{type:"clear-transient"}
{type:"clear-selection"}
```

Fields are `manager`, `machine`, `workerStatus`, `activity`, `initiative`, `epic`, `status`, `owner`,
`priority`, `checkIn`, `due`, `edited`, `area` and `subArea`. `operational` is
accepted only for Order. The [Overview reference](overview.md) owns preset,
base-scope and donut-filter semantics, including persistence and clear behavior.
`get_scene` returns
`records.groups` computed for this window's organizer and filters; group IDs and
outer IDs are valid expansion/focus targets. `read_record` accepts both. Status
options come from the source schema and observed cards. Browser persistence,
including assistant changes after React commits, follows the
[presentation preference rules](overview.md).
Legacy `set-arrangement` maps `secondMate` to Manager, `machine` to Machine and
`initiative` to one group, without inferring Initiative from parents. Legacy
`set-sort` maps activity to Last activity descending and priority to Priority
ascending. New clients should use `set-organizer`.

An accepted `focus` supersedes previous `open-queue` item or card targeting.
Focus and flash reveal relevant ancestors/roadmap and clear the exception filter. Saved filters remain unchanged for focus and flash. Assistant navigation/reveal clears masks and closes the Desk overlay so the requested target is accessible; the [Overview scope rules](overview.md) govern temporary reveal. Focus reveal lasts while selected. `navigate-card` uses the [Discuss navigation behavior](overview.md), with independent reveal/highlight state in `navigation: {cardId, revision}`; an ID missing from the current scene returns `unknown-id`. Arrangement preserves selection. Flash preserves selection, accepts at most 100 semantic targets and lasts at most four seconds, with a static outline for reduced motion. Assistant changes show a subtle cue with **Clear cue**; clearing does not undo domain work because no domain changes occurred.

Card context reads only IDs already on the configured authorized board. Context is cached for 30 seconds, coalesced, bounded to 100 cards, ten requests, four nested levels, 2 MiB and a 20-second deadline. Code, attachments, embeds and unsupported blocks are omitted; omissions and truncation are labeled. Full available prose is returned rather than a fabricated summary. Common credential literals in prose are redacted. No terminal transcript is fetched. An unconfigured or denied source returns unavailable. Source properties/relations retain the existing coverage semantics.

## Delivery and acknowledgment

The browser registers a private window key through the existing local/desktop origin boundary, then sequentially syncs once per second with a five-second deadline. Browser keys stay in memory and are never returned through MCP. A custom header prevents cross-site form registration. Desktop uses `apiFetch` and the same allowed-origin policy as the rest of Tin Star.

The small **ChatGPT · A1B2C3** connection menu in the existing Overview toolbar / Decisions header identifies this exact tab. **Use this tab with ChatGPT** designates it through its existing private browser key; choosing another tab replaces the designation. The menu copies the full UUID on request. Codes are unique among retained scenes; they identify a tab and grant no authority. Navigation stays inside that browser tab; no code activates another browser tab. Assistant card navigation opens Decisions only for the first, canonical card of a non-coordination row in its queue projection. Supporting secondary cards in merged rows, coordination records and other targets fall back to Overview. Focus, flash and reveal can stay in Decisions only when every requested target has such a canonical row; otherwise the full target set hands off to Overview in the same tab.

`outcome: applied` remains a state acknowledgment for compatibility. Read the additive `delivery.stage` separately:

- `accepted`: queued by the server; no browser application proven.
- `applied-to-state`: browser committed the reducer state; no visual delivery proven.
- `rendered`: React committed (for general view changes), or a target exists in DOM but is covered/clipped. Check `pending`, `reason`, `rendered_targets` and `visible_targets`.
- `foreground-visible`: all requested targets passed DOM, viewport/occlusion, document visibility and browser focus observations. This proves observed visibility, not that a person noticed it.
- `not-visible`: background/unfocused tab or missing target. A background target stays pending beyond flash expiry; foregrounding replays a restrained highlight before completing delivery. User input cancels replay and reports that cancellation.
- `not-supported`: requested semantic targets lack a visible representation on this surface; state acknowledgment is not a visual success. In a mixed set, undelivered card/execution targets stay pending through background expiry and replay independently of unsupported targets. Once supported targets are delivered, unsupported targets can finish the receipt with this stage rather than `foreground-visible`.

For `next_queue_item`, either direction of `navigate-queue`, and every `open-queue` form (card ID, item ID or default selection), assistant navigation closes the Discuss overlay before opening Decisions. Delivery observes the canonical card of the destination resolved from the applied queue state, using the same foreground replay and user-input cancellation rules above. A destination without an observable card in a non-coordination Decisions row reports `not-supported`; committing queue state alone does not prove visual delivery.

`rendered_scene.scene_generated_at` continues to mean the loaded **source** snapshot generation time. `rendered_at` and `revision` identify the browser commit, while delivery `observed_at` identifies the DOM inspection. Fresh heartbeats never rewrite old source timestamps. `visibility`, `focused`, `surface`, `route` and `pending_command` explain hidden, stale or unresolved destinations.

The tool names are unchanged, but `get_scene`, `present_view`, and `next_queue_item` accept optional `session_code` and optional `scene_id`; refresh the ChatGPT connector once after deployment to load the updated schemas/descriptions. `search_work` owner/status filtering and `coverage.intentions` are unchanged.

The registry keeps at most 64 windows and 256 command receipts per window. Windows/receipts expire after ten minutes; a heartbeat older than ten seconds is disconnected. The MCP interface is stateless at the transport level: browser window IDs, rather than transport sessions, select the view. There is no event watcher or new fleet poller.

For `present_view` and `next_queue_item`, an implicit command reserves its tab before source reads begin. Identical retries stay bound to that retained tab even if the owner designates another tab while the first request is in flight. Explicit window commands retain independent per-window command IDs and revisions.

- `queued`: accepted for delivery, **not** applied. Query `get_command` or retry the identical `present_view` input.
- `applied`: the UI dispatched the shared reducer, React committed the resulting view, and the browser returned its resulting revision/state. Server acceptance alone cannot yield this result.
- `expired`: the bounded lifetime elapsed without an applied acknowledgment; no late delivery is scheduled. If a browser committed before expiry and its acknowledgment arrives late (within ten seconds), the receipt is corrected to applied with that commit timestamp.
- `ambiguous-session`: multiple connected tabs have no owner designation and no explicit code/ID was supplied. Ask for the visible code or use the tab menu.
- `disconnected`: the known window is offline/stale. Reconnect/open it and obtain its current ID/revision.
- `unknown-id`: no recognized window, target or retained receipt. Reads never invent a missing item.
- `unauthorized`: wrong/missing install token (HTTP 401), wrong browser key or foreign browser origin (HTTP 403). No secret is returned.
- `queue-source-unavailable`: queue navigation or opening the ordered queue lacks a usable queue source; no navigation is applied.
- `stale-revision`: input revision differs from the browser’s current revision. Read the window again before deciding to send a new command.
- `conflict`: the same command ID was reused with different input, or the bounded receipt capacity was reached. Identical retries return the original receipt.

Direct clicks update the same revision synchronously. A queued assistant focus received after a click fails its expected-revision check instead of replacing the user’s view. Competing commands based on the same revision can therefore produce a stale result. Do not automatically override it. The read result distinguishes the browser’s rendered-scene observation from the server’s current source freshness. UI fetch failure retains last-known presentation and source coverage; it never declares an empty fleet or all-clear.

## SDK client and acceptance

The official SDK can connect without copying credentials into command arguments. This example runs on the backend host with the same private config root; install the SDK as a normal client dependency. It reads the token from that root directly into the Authorization header.

```js
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const token = (await readFile('/absolute/private/tinstar-config/mcp-token', 'utf8')).trim()
const client = new Client({ name: 'floor-acceptance', version: '1' })
await client.connect(new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:5281/api/reconciliation/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
))
const read = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  return JSON.parse(result.content[0].text)
}
// Replace this with the code confirmed by the user in the intended tab.
const session_code = 'A1B2C3'
const sessions = await read('list_ui_sessions', {})
const selected = sessions.sessions.find(session => session.session_code === session_code)
if (!selected?.connected) throw new Error('The confirmed tab is not connected')
const scene_id = selected.scene_id
const scene = await read('get_scene', { scene_id })
const receipt = await read('present_view', {
  scene_id, command_id: randomUUID(), expected_revision: scene.state.revision,
  action: { type: 'set-arrangement', arrangement: 'machine' },
})
console.log(receipt) // queued requires get_command; only applied certifies the UI ack
await client.close()
```

In conversation: list windows, select the intended ID, read its scene/card, regroup by Machine, focus a returned actual card/execution, open that card, and flash its semantic ID. Check the browser and applied receipt after each step. Open a second Overview and verify it stays unchanged. Close one window and verify commands report disconnected. Click manually while an older command is queued and verify it reports stale-revision. Unknown IDs and unauthorized requests must fail without changing either window.

Run controlled acceptance on an isolated config, with no production source writes:

```sh
npm run typecheck
npm run build:all
npx vitest run src/reconciliation/__tests__ src/server/reconciliation/__tests__ --exclude='e2e/**'
TINSTAR_MCP_PROOF=/absolute/proof-directory npx playwright test --config playwright.cockpit.config.ts e2e/reconciliation-mcp.spec.ts --output=/absolute/proof-directory/test-results
```

The MCP Playwright test uses an official SDK client and actual browser pages; source records are explicitly controlled fixtures. The separate live development proof uses Hulk’s actual First Mate snapshot and authenticated Notion reads with the discovery helper retaining its credential. Neither is a production whole-farm deployment. Task evidence is saved outside the repository at `/home/farm/fm-home/data/tinstar-recon-s5/` (transcripts, screenshots, failed-start logs and final-head receipts).

Decisions uses the [S4 queue API](reconciliation-queue.md), which owns readiness, deduplication, PR checks, source coverage and ordering. The [Overview reference](overview.md) owns card presentation and floor navigation. Next/previous navigation traverses verified-ready requests; verification candidates can also be opened explicitly by item ID. Navigation mutates only presentation. An answered item removed by a fresh source read stays explicitly unavailable if selected; it is never silently replaced or restored. Queue polling runs 20 seconds after each read completes, with a 60-second deadline. A confirmed or partial local workflow save triggers an immediate refresh, superseding any pending read; superseded responses cannot replace the current result. Read failure retains labeled last-known candidates and downgrades displayed readiness. Production Notion credentials and other farm homes’ authorized snapshot routes remain operator prerequisites from S1–S3. The live proof’s discovery bridge is development evidence, not a production credential deployment.

MCP and workflow request bodies remain bounded at 256 KiB. UI registration and sync allow 16 MiB because a single accepted command expands into search focus, replay flash IDs, an acknowledgment state snapshot, and requested/rendered/visible delivery arrays. The browser sends one acknowledgment per poll to avoid multiplying those snapshots by a 32-item batch. Unsent updates coalesce per command in queue order, preserving the original commit timestamp and terminal delivery observations even when failed batches return to the queue. The large-reveal transport regression exercises a command below 256 KiB whose acknowledgment exceeds that limit, including 4097 targets and a maximum-length semantic ID.
