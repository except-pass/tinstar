# Conversational Floor (S5)

Tin Star exposes a real [MCP SDK Streamable HTTP](https://ts.sdk.modelcontextprotocol.io/server) endpoint at `POST /api/reconciliation/mcp` on the existing backend. It reads the configured reconciliation sources and steers an explicitly selected Floor window. The UI uses the same pure semantic reducer as clicks. There are no execution, command, approval, merge, Notion-edit, claim-repair or domain-priority tools.

## Start and connect

Use Node >=22.12. Configure fleet/Notion reads as described in [reconciliation-floor.md](reconciliation-floor.md). The configured list covers only those homes; a successful connection does not certify a whole-farm census. No extra source credentials or public listener are created by MCP.

```sh
npm ci
npm run build:all
TINSTAR_CONFIG_HOME=/absolute/private/tinstar-config node bin/tinstar.js --host 127.0.0.1 --port 5281 --no-open
```

Open `http://127.0.0.1:5281/?view=floor`. Each open Floor has an ephemeral `scene_id` shown above the hierarchy. Two tabs have separate IDs, revisions and selections. A reload creates a new ID. The Floor must remain open to apply commands; background browser throttling can delay acknowledgments.

The first backend start creates `<TINSTAR_CONFIG_HOME>/mcp-token` (default `~/.config/tinstar/mcp-token`), a random per-install token with mode 0600. Tin Star never prints it or sends it to the browser. Config permission trouble disables MCP with a visible API error while source viewing continues. The operator can rotate the token by removing that file while the backend is stopped, restarting, and updating their client’s private secret. Do not paste it into chat, command history, screenshots or source control.

Use a conversational client with **Streamable HTTP and custom Authorization headers**. In its private connection settings, supply:

```json
{
  "url": "http://127.0.0.1:5281/api/reconciliation/mcp",
  "headers": { "Authorization": "Bearer <contents of your private mcp-token file>" }
}
```

This is the transport configuration, not a universal client configuration-file format. Some clients support OAuth only; those cannot use this initial private-token interface directly. The official MCP Inspector accepts a Streamable HTTP URL and custom request headers; SDK clients can use `StreamableHTTPClientTransport` with `requestInit.headers` (example below). Use the client’s secret settings, rather than putting the literal credential in a repository.

Localhost is the default. For a remote client, the operator must explicitly bind the existing backend to its Tailscale address and permit the intended tailnet client under the tailnet ACLs; set the URL to that private address. Both MCP and its UI bridge reject peers outside loopback/Tailscale IPv4/IPv6 ranges, ignore forwarded headers, and enforce the application origin policy for browser requests. Do not publish, forward or reverse-proxy this route publicly: a proxy running on localhost would itself be a trusted network peer. Do not use an Internet tunnel to bridge the private interface. Remote web/desktop UI origins must also be in the existing application origin allowlist. No network configuration is silently changed.

## Tools and authority

| Tool | Result |
| --- | --- |
| `list_ui_sessions` | Authorized window IDs, connected state, last heartbeat, revision; no browser session secrets |
| `get_scene(scene_id)` | Last browser-applied presentation, rendered-scene timestamp/read-failure status, current server freshness/coverage, counts, semantic card/actor/claim indexes and actual arrangements |
| `read_record(scene_id, target, evidence?)` | Actor/execution, manager, task/card, claim, group or root; optional bounded claim evidence and source freshness |
| `get_card_context(scene_id, card_id)` | Authorized board card properties plus bounded Notion prose, with explicit availability/omissions |
| `get_queue(scene_id)` | Ordered readiness from the queue source, or `queue-source-unavailable` |
| `present_view(...)` | Enqueue a semantic action for one explicit window and wait up to two seconds for its acknowledgment |
| `next_queue_item(...)` | Navigate the real S4 ordered ready / verification queue with the same acknowledgment protocol |
| `get_command(scene_id, command_id)` | Query a prior command outcome without applying it again |

Targets have `{kind,id}`. Kinds are `card`, `execution`, `claim`, `manager`, `group`, `you` and `firstMate`. Use IDs returned by reads, never title matching. Executions retain First Mate home/task/attempt identity. Claims distinguish confirmed, textual, inferred and conflicting relationships.

`present_view` requires `scene_id`, `command_id`, `expected_revision`, and `action`; optional `ttl_ms` is 500–15000 (default 8000). Actions:

```text
{type:"set-arrangement", arrangement:"initiative"|"secondMate"|"machine"}
{type:"set-expanded", target:{kind:"manager"|"group",id}, expanded:boolean}
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

Focus and flash reveal relevant ancestors/roadmap and clear the exception filter so valid targets become visible. Arrangement preserves selection. Flash preserves selection, accepts at most 100 semantic targets and lasts at most four seconds, with a static outline for reduced motion. Assistant changes show a subtle cue with **Clear cue**; clearing does not undo domain work because no domain changes occurred.

Card context reads only IDs already on the configured authorized board. Context is cached for 60 seconds, coalesced, bounded to 100 cards, ten requests, four nested levels, 2 MiB and a 20-second deadline. Code, attachments, embeds and unsupported blocks are omitted; omissions and truncation are labeled. Full available prose is returned rather than a fabricated summary. Common credential literals in prose are redacted. No terminal transcript is fetched. An unconfigured or denied source returns unavailable. Source properties/relations retain the existing coverage semantics.

## Delivery and acknowledgment

The browser registers a private window key through the existing local/desktop origin boundary, then sequentially syncs once per second with a five-second deadline. Browser keys stay in memory and are never returned through MCP. A custom header prevents cross-site form registration. Desktop uses `apiFetch` and the same allowed-origin policy as the rest of Tin Star.

The registry keeps at most 64 windows and 256 command receipts per window. Windows/receipts expire after ten minutes; a heartbeat older than ten seconds is disconnected. The MCP interface is stateless at the transport level: browser window IDs, rather than transport sessions, select the view. There is no event watcher or new fleet poller.

- `queued`: accepted for delivery, **not** applied. Query `get_command` or retry the identical `present_view` input.
- `applied`: the UI dispatched the shared reducer, React committed the resulting view, and the browser returned its resulting revision/state. Server acceptance alone cannot yield this result.
- `expired`: the bounded lifetime elapsed without an applied acknowledgment; no late delivery is scheduled. If a browser committed before expiry and its acknowledgment arrives late (within ten seconds), the receipt is corrected to applied with that commit timestamp.
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
const sessions = await read('list_ui_sessions', {})
// Explicitly choose the scene_id shown in the intended browser window.
const scene_id = sessions.sessions[0].scene_id
const scene = await read('get_scene', { scene_id })
const receipt = await read('present_view', {
  scene_id, command_id: randomUUID(), expected_revision: scene.state.revision,
  action: { type: 'set-arrangement', arrangement: 'machine' },
})
console.log(receipt) // queued requires get_command; only applied certifies the UI ack
await client.close()
```

In conversation: list windows, select the intended ID, read its scene/card, regroup by Machine, focus a returned actual card/execution, open that card, and flash its semantic ID. Check the browser and applied receipt after each step. Open a second Floor and verify it stays unchanged. Close one window and verify commands report disconnected. Click manually while an older command is queued and verify it reports stale-revision. Unknown IDs and unauthorized requests must fail without changing either window.

Run controlled acceptance on an isolated config, with no production source writes:

```sh
npm run typecheck
npm run build:all
npx vitest run src/reconciliation/__tests__ src/server/reconciliation/__tests__ --exclude='e2e/**'
TINSTAR_MCP_PROOF=/absolute/proof-directory npx playwright test --config playwright.cockpit.config.ts e2e/reconciliation-mcp.spec.ts --output=/absolute/proof-directory/test-results
```

The MCP Playwright test uses an official SDK client and actual browser pages; source records are explicitly controlled fixtures. The separate live development proof uses Hulk’s actual First Mate snapshot and authenticated Notion reads with the discovery helper retaining its credential. Neither is a production whole-farm deployment. Task evidence is saved outside the repository at `/home/farm/fm-home/data/tinstar-recon-s5/` (transcripts, screenshots, failed-start logs and final-head receipts).

The desk uses the [S4 queue API](reconciliation-queue.md), which owns readiness, deduplication, PR checks, source coverage and ordering. It shows one item and the next few, with next/previous navigation through ready and verification candidates. Future/conditional items remain in a separate context section. Navigation mutates only presentation. An answered item removed by a fresh source read stays explicitly unavailable if selected; it is never silently replaced or restored. Queue reads run sequentially, 20 seconds after each read completes, with a 60-second deadline. Read failure retains labeled last-known candidates and downgrades displayed readiness. Production Notion credentials and other farm homes’ authorized snapshot routes remain operator prerequisites from S1–S3. The live proof’s discovery bridge is development evidence, not a production credential deployment.
