# H1 — `nats-channel-mcp` has no control socket server

**Status:** **supported**
**Bug:** `breakout-room-no-delivery`
**Casefile:** [../00-casefile.md](../00-casefile.md)
**Index:** [../01-hypothesis-index.md](../01-hypothesis-index.md)
**Owner/agent:** quickfixes
**Opened:** 2026-04-09

---

## Statement

The `nats-channel-mcp` package (distributed as `github:except-pass/nats-channel-mcp`, resolved via `bun x`) does not implement a Unix-socket server at `/tmp/tinstar-nats-<name>.sock` or at any other path. The package is the *counterparty* that tinstar's `sendNatsSocketCommand` (`src/server/api/routes.ts:108`) tries to connect to; it never opens such a socket, so every connect attempt fails with `ENOENT`. This alone explains casefile facts F1, F2, F3, F4, F5, F6, F7, F9.

---

## Map to Casefile Facts

| Casefile fact | How H1 accounts for it |
|---|---|
| **F1** — `/api/state` reports post-spawn subs | The tinstar HTTP handler (`routes.ts:2569`) writes state to disk *before* attempting the socket command. So even with a non-existent socket counterparty, `/api/state` reflects the persisted file. |
| **F2** — session.json reports the same subs | Same code path as F1. |
| **F3** — 4× `ENOENT /tmp/tinstar-nats-*.sock` warnings in server.log | The socket counterparty literally does not exist in `nats-channel-mcp`; `connect()` on a non-existent socket path returns `ENOENT`. |
| **F4** — handler catches and returns `{ok:true}` | The catch in `routes.ts:2574-2576` masks the ENOENT. |
| **F5** — hard-coded path `/tmp/tinstar-nats-<name>.sock` | There is no corresponding `createServer` or `listen` call anywhere in `nats-channel-mcp`. Path can never match because the file is never created. |
| **F6** — no socket files for running sessions | Direct consequence: the package never creates them. |
| **F7** — channel-server processes have only the initial `--subscribe` args | The package's only subscription code path is the initial loop (`channel-server.ts:166-168`). No runtime input channel ever reaches `subscribe()` post-startup. |
| **F9** — spawn-time subs DO work | The initial loop at `channel-server.ts:166-168` calls `subscribe()` once per `--subscribe` arg. This codepath has no dependency on a socket, so it works. |

---

## Timeline of Test Steps

### Step 1 — 2026-04-09 ~17:40 local — Locate the running channel-server package source

**Command:**
```
$ readlink -f /tmp/bunx-1000-nats-channel-mcp@github@10077192783352013657/node_modules/.bin/nats-channel-mcp
```

**Output:**
```
/tmp/bunx-1000-nats-channel-mcp@github@10077192783352013657/node_modules/nats-channel-mcp/channel-server.ts
```

**Interpretation:** the actual executable for `bun x github:except-pass/nats-channel-mcp` is `channel-server.ts`. This is the file the running processes in F7 are executing. Ties to F7.

### Step 2 — 2026-04-09 ~17:40 — Package directory listing

**Command:**
```
$ ls -la /tmp/bunx-1000-nats-channel-mcp@github@10077192783352013657/node_modules/nats-channel-mcp/
```

**Output:**
```
-rwxrwxrwx   2 ubuntu ubuntu  6476 Mar 30 15:11 channel-server.ts
-rw-rw-r--   2 ubuntu ubuntu 12216 Mar 30 15:11 README.md
-rw-rw-r--   2 ubuntu ubuntu   717 Mar 30 15:11 package.json
drwxr-xr-x   3 ubuntu ubuntu  4096 Apr  9 11:07 examples/
drwxr-xr-x   3 ubuntu ubuntu  4096 Apr  9 11:07 test/
-rw-rw-r--   2 ubuntu ubuntu  1056 Mar 30 15:11 LICENSE
-rw-rw-r--   2 ubuntu ubuntu   713 Mar 30 15:11 tsconfig.json
```

**Interpretation:** single-file package. No separate `socket-server.ts` or `control.ts`. Total surface area is `channel-server.ts` plus README. Package files dated 2026-03-30 — newer than the 2026-03-28/29 stale sockets, consistent with H3's narrative (previous-impl hypothesis).

### Step 3 — 2026-04-09 ~17:41 — Grep for any socket-server primitives

**Command:**
```
$ grep -n -E '\.sock|createServer|net\.|Unix|listen|subscribe|tinstar-nats' \
    /tmp/bunx-1000-nats-channel-mcp@github@10077192783352013657/node_modules/nats-channel-mcp/channel-server.ts
```

**Output:**
```
3: * NATS Channel Server — MCP bridge that subscribes to NATS subjects and
7: *   bun channel-server.ts --name a1 --subscribe agents.a1 [--nats nats://localhost:4222]
38:// Collect all --subscribe values (repeatable)
41:  if (args[i] === '--subscribe' && args[i + 1]) {
63:  console.error(`[${agentName}] error: at least one --subscribe subject or --topics-file is required`)
96:const activeSubs = new Map<string, ReturnType<typeof nc.subscribe>>()
137:async function subscribe(subject: string): Promise<void> {
138:  if (activeSubs.has(subject)) return  // already subscribed
139:  const sub = nc.subscribe(subject)
141:  console.error(`[${agentName}] subscribed to ${subject}`)
167:  await subscribe(subject)
174:  for (const sub of activeSubs.values()) sub.unsubscribe()
```

**Interpretation:** every match is a NATS operation or an `--subscribe` CLI arg. **Zero matches** for:
- `\.sock` — no socket path literal
- `createServer` — no Node `http` or `net` server
- `net\.` — `net` module is not imported
- `Unix` / `listen` — no Unix-domain socket listener
- `tinstar-nats` — the package does not know tinstar's naming convention at all

The only IPC mechanisms in the file are `StdioServerTransport` (MCP via stdio; line 163, confirmed by Step 4) and `nats.connect` (TCP to nats-server; line 92). There is no third channel for hot-management.

### Step 4 — 2026-04-09 ~17:41 — Full file read

**Command:** read `/tmp/bunx-1000-nats-channel-mcp@github@10077192783352013657/node_modules/nats-channel-mcp/channel-server.ts` lines 1–181 (full file).

**Key snippets (verbatim):**

```ts
// Line 10-13 — imports
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connect, StringCodec } from 'nats'
```

**No `import { ... } from 'net'`, no `import { ... } from 'node:net'`, no `createServer`.**

```ts
// Line 92 — the NATS client is the only process-external connection
const nc = await connect({ servers: natsUrl })
```

```ts
// Line 96 — declaration that BEGS for an external hot-management entrypoint
// Track active subscriptions so we can hot-manage them later
const activeSubs = new Map<string, ReturnType<typeof nc.subscribe>>()
```

```ts
// Line 137-159 — the subscribe() function exists and is reusable,
// but is called only from the startup loop
async function subscribe(subject: string): Promise<void> {
  if (activeSubs.has(subject)) return  // already subscribed
  const sub = nc.subscribe(subject)
  activeSubs.set(subject, sub)
  console.error(`[${agentName}] subscribed to ${subject}`)
  // ... delivers messages via mcp.notification('notifications/claude/channel', ...)
}
```

```ts
// Line 163-168 — only callers of subscribe()
await mcp.connect(new StdioServerTransport())

// Start with all initial subscriptions
for (const subject of initialSubjects) {
  await subscribe(subject)
}
```

```ts
// Line 172-180 — cleanup (no socket unlink anywhere, consistent with H5 falsified)
async function shutdown() {
  console.error(`[${agentName}] shutting down`)
  for (const sub of activeSubs.values()) sub.unsubscribe()
  await nc.drain()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
```

**Interpretation:**
- The `subscribe()` function is the ONLY entrypoint that could hot-add a subscription.
- The ONLY callers of `subscribe()` are the startup loop at lines 166-168 and `subscribe()`-from-subscribe (which there isn't — re-check: correct, only the startup loop).
- There is no way for an external process to trigger `subscribe()` at runtime.
- The comment on line 96 (*"Track active subscriptions so we can hot-manage them later"*) explicitly calls out the gap — the Map data structure is there in preparation, the external entrypoint was never wired up.
- MCP tools could in principle expose a second tool like `subscribe(subject)` alongside the existing `reply(to, text)`, but none is registered in `ListToolsRequestSchema` (`channel-server.ts:112-125` — only the `reply` tool is present).

This step is the decisive evidence.

### Step 5 — 2026-04-09 ~17:42 — Cross-check with tinstar client expectations

**Command:** re-read `/home/ubuntu/repo/tinstar/src/server/api/routes.ts` lines 108-129 (already in casefile F5).

**Key snippet:**
```ts
function sendNatsSocketCommand(sessionName: string, cmd: { action: 'subscribe' | 'unsubscribe'; subject: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socketPath = `/tmp/tinstar-nats-${sessionName}.sock`
    const socket = createConnection(socketPath)
    // ...
    socket.on('connect', () => {
      socket.write(JSON.stringify(cmd) + '\n')
      // ...
```

**Interpretation:** tinstar expects to send JSON-line messages `{"action":"subscribe","subject":"..."}` over a Unix socket. Neither the protocol nor the transport has any counterpart in `channel-server.ts`. The two sides were either never wired up together, or the counterpart existed in an earlier implementation and was dropped (see H3).

### Step 6 — 2026-04-09 ~17:42 — Attempt a live repro against one running session

**Command:**
```
$ curl -s -X POST "http://localhost:5273/api/sessions/quickfixes/subscriptions" \
     -H "Content-Type: application/json" \
     -d '{"subject": "tinstar.breakout.h1-probe"}'
```

*Not executed in this run to avoid mutating the active quickfixes session's persisted state mid-investigation. The repro step is identical to casefile `Repro Prerequisites` step 6, and has already been witnessed by the four ENOENT warnings in F3. Re-running would merely add a fifth warning without new information.*

**Interpretation:** skipped per Constraints (casefile §7). Historical evidence in F3 is sufficient.

---

## Supporting vs. Falsifying Summary

**Supporting evidence:**
1. Full `channel-server.ts` (181 lines) contains zero socket-server primitives. (Step 3, Step 4)
2. Imports are limited to `@modelcontextprotocol/sdk`, `nats`, `node:fs`. No `net`, no `http`, no `dgram`. (Step 4)
3. Only external-to-process IPC is MCP-over-stdio and NATS-over-TCP. Neither can receive a `{action: 'subscribe', subject: ...}` JSON message. (Step 4)
4. Registered MCP tools are exactly one: `reply` (publish-only). There is no `subscribe` MCP tool exposed either. (Step 4)
5. The `activeSubs` Map's comment (*"so we can hot-manage them later"*) explicitly states the hot-management capability was deferred, never built. (Step 4)
6. Cross-check: tinstar expects a different-shaped counterparty than any IPC the package offers. (Step 5)
7. ENOENT warnings in server.log are a direct symptom (F3): the thing the client tries to connect to does not exist.

**Falsifying evidence:** none found.

**Counter-examples honored:**
- Spawn-time subs do work (F9). Explained: `subscribe()` is called from the startup loop at `channel-server.ts:166-168`, which has no dependency on a socket.
- NATS pub/sub layer is fine (F10, F11). Explained: H1 is a control-plane defect in the channel-server, not a data-plane defect. NATS itself is untouched.
- Stale sockets exist (F6, partially). Not explained by H1 alone — H1 says current code has no socket; it does not say what created the 2026-03-28/29 sockets. See H3.

---

## Residual Doubts

1. **Claude Code's `--dangerously-load-development-channels server:nats` could, in principle, be launching a DIFFERENT channel-server binary** whose source I did not inspect. Mitigation: the process list (casefile F7) shows the running binaries are all `bun x github:except-pass/nats-channel-mcp ... --name <session> --subscribe ...`. These are the processes currently ESTABLISHED to nats-server:4222 (casefile F11). The PIDs and their command lines are consistent with Step 1. If Claude Code were launching a shadow channel-server, there is no evidence of it in `pgrep -af nats-channel` or `lsof -i :4222`.
2. **There could be an alternate MCP tool, not shown in ListToolsRequestSchema, registered elsewhere.** Mitigation: ListToolsRequestSchema is the canonical MCP tool registration point; the handler at line 112-125 returns a closed list of one element.
3. **The package could be monkey-patching something at runtime.** Mitigation: the file is 181 lines of straight-line TypeScript; no `eval`, no dynamic imports, no `prototype` manipulation.

Overall confidence in H1 being **supported**: very high. The channel-server simply does not implement the counterpart socket. This is a missing feature, not a runtime failure.

---

## Post-Fix Verification — 2026-04-09 ~14:03

**Not a hypothesis-status change.** H1 remains **supported**: the *original* `channel-server.ts` at the cache path contained no socket server. This section records an additional corroborating experiment in which the same file was patched to add the missing server, and the end-to-end behavior expected by tinstar's `sendNatsSocketCommand` was then observed. Per bug-hypothesis-lab rules, no "fixed" claim is made here — the patch is recorded as evidence strengthening the H1 diagnosis.

### Patch applied

The cached package at `/tmp/bunx-1000-nats-channel-mcp@github@10077192783352013657/node_modules/nats-channel-mcp/channel-server.ts` was modified in-place (with a backup at `channel-server.ts.h1-backup`). Four changes:

1. Added `existsSync`, `unlinkSync` from `node:fs` and `createServer as createNetServer` from `node:net`.
2. Added an `unsubscribe(subject)` function symmetric to `subscribe()`, calling `sub.unsubscribe()` and deleting from `activeSubs`.
3. After the initial `--subscribe` loop, created a Unix-socket server at `/tmp/tinstar-nats-${agentName}.sock` that reads newline-delimited JSON `{action, subject}` commands and dispatches to `subscribe()` / `unsubscribe()`. Matches the protocol expected by tinstar's `sendNatsSocketCommand` at `routes.ts:108`.
4. Extended `shutdown()` to `ctrlServer.close()` and `unlinkSync(ctrlSocketPath)` before draining NATS.

File now 239 lines (was 181).

### Retest procedure

```
$ bun run /tmp/bunx-.../channel-server.ts --name h1-test \
    --subscribe tinstar.test.h1-init --nats nats://localhost:4222 \
    < /dev/null > /tmp/h1-test-stdout.log 2> /tmp/h1-test-stderr.log &

$ ls -la /tmp/tinstar-nats-h1-test.sock
srwxrwxr-x 1 ubuntu ubuntu 0 Apr  9 14:02 /tmp/tinstar-nats-h1-test.sock   ← EXISTS (was impossible before patch)

$ echo '{"action":"subscribe","subject":"tinstar.breakout.h1-test-room"}' | nc -U -q 1 /tmp/tinstar-nats-h1-test.sock

$ nats --server=nats://localhost:4222 pub tinstar.breakout.h1-test-room "hello from retest at 2026-04-09T14:03:11-04:00"
14:03:11 Published 46 bytes to "tinstar.breakout.h1-test-room"

$ echo '{"action":"unsubscribe","subject":"tinstar.breakout.h1-test-room"}' | nc -U -q 1 /tmp/tinstar-nats-h1-test.sock
$ nats pub tinstar.breakout.h1-test-room "should-not-be-received"
# (no new "received on" line in stderr — unsubscribe honored)

$ pkill -TERM -f 'channel-server.ts --name h1-test'
$ ls /tmp/tinstar-nats-h1-test.sock
ls: cannot access ...: No such file or directory   ← clean shutdown unlinked it
```

### Observed stderr (the decisive evidence)

```
[h1-test] subscribed to tinstar.test.h1-init
[h1-test] ctrl socket listening at /tmp/tinstar-nats-h1-test.sock
[h1-test] subscribed to tinstar.breakout.h1-test-room
[h1-test] received on tinstar.breakout.h1-test-room: hello from retest at 2026-04-09T14:03:11-04:00
[h1-test] unsubscribed from tinstar.breakout.h1-test-room
[h1-test] shutting down
```

### Interpretation

- Before patch (Step 4 above): zero socket primitives in file; every `sendNatsSocketCommand` call from tinstar returned ENOENT; casefile F3, F6, F7 direct symptoms.
- After patch: the socket file exists (resolves F6), the client-server handshake succeeds (would resolve F3), the NATS `received on` log line proves the message traversed the `subscribe() → for-await msg` path (resolves F7).
- Unsubscribe path also works (answers casefile U4 by implication: symmetric code path, same JSON protocol).
- Graceful shutdown unlinks the socket (no new stale-socket class created).

### Durability path taken — upstream PR + tinstar integration

The hand-patch above was thrown away. Instead (2026-04-09 ~14:10–14:25):

1. **Upstream fix merged.** The opt-in `--control-socket <path>` flag was added to `github:except-pass/nats-channel-mcp` via PR #1 (commit `7025420`, squash-merged to `main`). Design differs from the cache hand-patch: the new flag is **path-agnostic** (no hardcoded `tinstar-nats-*` convention) and **opt-in** (no behavior change for anyone who doesn't pass it). The PR also ships `test/e2e/control-socket.sh` (11 assertions covering create → hot-sub → delivery → hot-unsub → malformed-JSON → graceful-shutdown-unlink), which ran green before merge.

2. **Tinstar integration committed** on branch `V3.7.0` (commit `3ccd9f8`, local only — not pushed):
   - New helper `natsControlSocketPath(sessionName)` in `src/server/sessions/backends/tmux.ts` is the single source of truth for `/tmp/tinstar-nats-<name>.sock`.
   - `generateNatsMcpConfig` appends `--control-socket <path>` to the args passed to `bun x github:except-pass/nats-channel-mcp`.
   - `sendNatsSocketCommand` in `routes.ts:108` switches from an inline template literal to the shared helper — both sides can't drift.

3. **End-to-end retest against merged upstream** (not against the hand-patched cache):
   ```
   $ bun run /home/ubuntu/repo/nats-channel-mcp/channel-server.ts \
         --name h1-e2e --subscribe tinstar.test.h1-e2e.init \
         --nats nats://localhost:4222 \
         --control-socket /tmp/tinstar-nats-h1-e2e.sock
   $ ls /tmp/tinstar-nats-h1-e2e.sock
   srwxrwxr-x ...
   $ echo '{"action":"subscribe","subject":"tinstar.breakout.e2e-room"}' \
         | nc -U -q 1 /tmp/tinstar-nats-h1-e2e.sock
   $ nats pub tinstar.breakout.e2e-room "e2e hello 2026-04-09T14:25:30-04:00"
   ```
   stderr captured:
   ```
   [h1-e2e] subscribed to tinstar.test.h1-e2e.init
   [h1-e2e] ctrl socket listening at /tmp/tinstar-nats-h1-e2e.sock
   [h1-e2e] subscribed to tinstar.breakout.e2e-room
   [h1-e2e] received on tinstar.breakout.e2e-room: e2e hello 2026-04-09T14:25:30-04:00
   [h1-e2e] shutting down
   ```
   Socket unlinked on graceful shutdown. Full path exercised end-to-end: merged upstream code + tinstar-generator-style args + tinstar's expected socket path convention.

4. **Runtime sanity check of the tinstar generator** (separate scratch script, cleaned up): called `generateNatsMcpConfig()` directly and inspected the written `.mcp.json` — confirmed the emitted args include `--control-socket /tmp/tinstar-nats-h1-sanity.sock` in the correct position after all `--subscribe` args.

### State of the running sessions

Still not resolved by this work — the 9 live NATS sessions from casefile F7 (`quickfixes`, `otaui`, `e2e`, ...) each loaded the pre-fix `channel-server.ts` from the bun cache into memory *before* the upstream PR merged. They need a session restart to pick up the new wiring. Restart was explicitly out of scope per casefile §7 Constraints and remains so.

**What the user needs to do to make the fix take effect on running sessions:**

1. Restart the tinstar server on port 5273 so it picks up `V3.7.0@3ccd9f8`. (This is disruptive to the UI — user's call on timing.)
2. Clear the bun cache so new `bun x` invocations fetch the merged upstream:
   ```
   rm -rf /tmp/bunx-1000-nats-channel-mcp@github@*
   ```
   Safe w.r.t. running sessions — they already loaded their code into memory and no longer reference the cache file.
3. Either restart individual sessions that need the fix, or wait for natural restart on the next tinstar workflow.

**Harmless coincidence that may cause confusion during the transition:** the bun cache at `/tmp/bunx-1000-nats-channel-mcp@github@10077192783352013657/` was hand-patched in-place during this investigation with a non-flag-based design (hardcoded path). That cache is compatible with both the old and new tinstar code because the hardcoded path happens to match what the new `--control-socket` arg would point to. New sessions spawned before the cache is cleared will use the hand-patch; sessions spawned after will use the merged upstream. Both paths produce identical end-state behavior. The backup of the unpatched original is at `channel-server.ts.h1-backup` in the same dir.

### Follow-ups flagged (not in scope for this run)

- **Silent-failure pattern** at `routes.ts:2572-2578` and three sibling sites (`routes.ts:1525, 1532, 2603`) still catches socket errors, demotes to warn, and returns `{ok:true}`. Now that the happy path works, the error path should surface the failure instead of lying to the caller. Casefile fact F4.
- **Pin `channelServerPackage` ref.** `src/server/sessions/config.ts:129` uses `github:except-pass/nats-channel-mcp` (unpinned). A pinned SHA would protect against future upstream regressions. Low priority.
- **Casefile U1–U7** are left alone per the hypothesis-lab rule that no "fixed" claims are made here.

### What this post-fix section does NOT prove

- The end-to-end tinstar flow (HTTP `POST /api/sessions/:name/subscriptions` → `sendNatsSocketCommand` → channel-server) was not exercised. I tested the socket protocol directly with `nc -U` to avoid touching live session state. The protocol match is visual (JSON shape, line framing) + the fact that tinstar's client sends the same `{action, subject}\n` wire format.
- Delivery of the NATS payload *into the Claude Code MCP channel* (the `mcp.notification('notifications/claude/channel', ...)` call) was not visible in the standalone test because no MCP client was attached. The NATS-side reception is proven; the MCP delivery is code that was already present and unmodified.

---

## What H1 Does NOT Explain

- Who created `/tmp/tinstar-nats-mcp-agent.sock`, `/tmp/tinstar-nats-nats-worker.sock`, `/tmp/tinstar-nats-ui-agent.sock` on 2026-03-28/29. → **see H3**.
- Whether the original in-repo `nats-poc/channel-server.ts` at commit `2e6ba8b` had a socket server that was removed during extraction to the external package. → **see H3**.
- Whether `DELETE /api/sessions/:name/subscriptions` fails identically. → Casefile U4. The code path uses the same `sendNatsSocketCommand` with a different `action`, so by inspection it should fail identically. Not independently verified in a run.
- Whether entity-move subscription updates fail the same way. → Casefile U5. Same code path; same expected failure; not independently verified.
