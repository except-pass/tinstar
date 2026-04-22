# 00 — Breakout room: messages published but not delivered to participants

**Bug ID:** breakout-room-no-delivery
**Opened:** 2026-04-09
**Reporter:** user (via quickfixes session)
**Repo branch at investigation time:** `V3.7.0` (HEAD `c83e977`)
**Server under test:** standalone tinstar on port 5273 (PID in `~/.config/tinstar/server.pid`)

---

## 1. Problem Narrative

A user observed that multiple running agent sessions in the local Tinstar workspace appear (according to the Tinstar dashboard and REST API) to be members of the same NATS breakout room, but they cannot exchange messages inside that room. Messages published to `tinstar.breakout.<room-name>` do not visibly arrive at any of the subscribed sessions as `<channel>` tags.

Why it is unexpected: breakout rooms are a documented Tinstar feature (see `docs/nats-agent-channels.md` and the new `Breakout Rooms` section in `~/.claude/skills/tinstar/SKILL.md`). The REST endpoint `POST /api/sessions/:name/subscriptions` returns HTTP 200 with `{ ok: true, data: { subscriptions: [...] } }` containing the breakout subject, `GET /api/sessions/:name/subscriptions` returns it back, and `/api/state` reports the same subscriptions on the session record — the entire visible surface claims the subscription is live.

Operational impact: every multi-agent coordination workflow that relies on ad-hoc breakout rooms (debugging huddles, cross-task collaboration channels, hand-off rooms) is silently non-functional. Agents invited into a room will not receive messages. Agents publishing into a room will see no replies. Pair-programming / critique / review flows that assume the breakout-room primitive behave as if they were single-agent sessions. The failure is silent from every visible surface, so operators have no on-screen signal that anything is wrong.

The failure mode is specifically for **hot-added** subscriptions (breakout rooms, any subject added after session spawn). Subscriptions supplied at session spawn time are unaffected — see Fact Pattern `F9`.

---

## 2. Fact Pattern

### F1 — Tinstar API accepts and persists breakout subscriptions for running sessions

Evidence: live `/api/state` query (2026-04-09, server on :5273):

```json
{
  "name": "otaui",
  "nats": {
    "enabled": true,
    "subscriptions": [
      "tinstar.work-space.cmsandbox.ota.ota-ui",
      "tinstar.work-space.cmsandbox.ota.ota-ui.otaui",
      "tinstar.breakout.harness",
      "tinstar.breakout.tinstar-improvement"
    ]
  }
}
```

The same two `tinstar.breakout.*` entries are present in the persisted session file `~/.config/tinstar/sessions/otaui/session.json` under `.nats.subscriptions`. `/api/state` and the on-disk session state agree.

### F2 — Same pattern on two other sessions

Evidence: `~/.config/tinstar/sessions/e2e/session.json`:
```json
{ "enabled": true, "subscriptions": [
  "tinstar.work-space.cmsandbox.dev.e2e-harness",
  "tinstar.work-space.cmsandbox.dev.e2e-harness.e2e",
  "tinstar.breakout.harness"
] }
```
and `~/.config/tinstar/sessions/quickfixes/session.json`:
```json
{ "enabled": true, "subscriptions": [
  "tinstar.work-space._._.tinstar-improvement",
  "tinstar.work-space._._.tinstar-improvement.quickfixes",
  "tinstar.breakout.tinstar-improvement"
] }
```

### F3 — Tinstar server log contains ENOENT on the hot-subscribe Unix socket

Evidence: `~/.config/tinstar/server.log`, 4 matching lines:
```
28615:2026-04-09T17:25:48.131Z [WARN] [nats] Failed to send subscribe to socket for otaui:       connect ENOENT /tmp/tinstar-nats-otaui.sock
28616:2026-04-09T17:26:08.623Z [WARN] [nats] Failed to send subscribe to socket for e2e:         connect ENOENT /tmp/tinstar-nats-e2e.sock
28620:2026-04-09T17:28:37.651Z [WARN] [nats] Failed to send subscribe to socket for otaui:       connect ENOENT /tmp/tinstar-nats-otaui.sock
28621:2026-04-09T17:28:37.661Z [WARN] [nats] Failed to send subscribe to socket for quickfixes:  connect ENOENT /tmp/tinstar-nats-quickfixes.sock
```
The timestamps line up with the time at which each session's breakout subscription was added. All four are emitted at log level `WARN`.

### F4 — The server handler catches this error and still returns HTTP 200 ok

Evidence: `src/server/api/routes.ts` lines 2572–2578:
```ts
try {
  await sendNatsSocketCommand(name, { action: 'subscribe', subject })
} catch (err) {
  log.warn('nats', `Failed to send subscribe to socket for ${name}: ${(err as Error).message}`)
}
}
json(res, { ok: true, data: { subscriptions: subs } })
```
The session file is updated (line 2569 `updateSession(sessDir, name, { nats: { ...session.nats, subscriptions: subs } })`) *before* the socket command is attempted. The socket failure is caught and demoted to a warn log. The response body is identical whether the socket command succeeds or fails.

### F5 — `sendNatsSocketCommand` expects a per-session Unix socket at a fixed path

Evidence: `src/server/api/routes.ts` lines 108–129:
```ts
function sendNatsSocketCommand(sessionName: string, cmd: { action: 'subscribe' | 'unsubscribe'; subject: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socketPath = `/tmp/tinstar-nats-${sessionName}.sock`
    const socket = createConnection(socketPath)
    ...
```
The path is hard-coded to `/tmp/tinstar-nats-<sessionName>.sock`. There is no fallback or alternative transport.

### F6 — No Unix socket exists for any currently running NATS-enabled session

Evidence: directory listing:
```
$ ls -la /tmp/tinstar-nats-*.sock
srwxrwxr-x 1 ubuntu ubuntu 0 Mar 29 14:47 /tmp/tinstar-nats-mcp-agent.sock
srwxrwxr-x 1 ubuntu ubuntu 0 Mar 28 17:26 /tmp/tinstar-nats-nats-worker.sock
srwxrwxr-x 1 ubuntu ubuntu 0 Mar 28 18:06 /tmp/tinstar-nats-ui-agent.sock
```

Currently-live NATS-enabled sessions per `/api/state`:
```
S3reorg costallocation e2e fleetOTA impersonate obs otaui quickfixes standaloneOTA
```

The intersection of the two sets is empty. None of the 9 running NATS-enabled sessions has a socket file. The 3 socket files that exist belong to session names (`mcp-agent`, `nats-worker`, `ui-agent`) not present in `/api/state`, and are dated Mar 28–29, which predates the oldest currently-running channel-server process (`e2e`, spawned Apr 8).

### F7 — Running channel-server processes were spawned with only the initial subscribes; no evidence of any post-spawn subscribe

Evidence: `ps` / `pgrep -af nats-channel` (excerpt):
```
1992717 bun x github:except-pass/nats-channel-mcp --name otaui \
        --subscribe tinstar.work-space.cmsandbox.ota.ota-ui \
        --subscribe tinstar.work-space.cmsandbox.ota.ota-ui.otaui

2404816 bun x github:except-pass/nats-channel-mcp --name e2e \
        --subscribe tinstar.work-space.cmsandbox.dev.e2e-harness \
        --subscribe tinstar.work-space.cmsandbox.dev.e2e-harness.e2e

2112330 bun x github:except-pass/nats-channel-mcp --name quickfixes \
        --subscribe tinstar.work-space._._.tinstar-improvement \
        --subscribe tinstar.work-space._._.tinstar-improvement.quickfixes
```
Each process has only two `--subscribe` arguments — the hierarchical task broadcast and the session's direct inbox. None of the processes has any `tinstar.breakout.*` argument on its command line. The process command line is immutable after spawn.

### F8 — The multi-agent CLI template does not pass a socket path or supply a subscribe-management channel

Evidence: `~/.config/tinstar/config.json` `cliTemplates[1]`:
```json
{
  "name": "Claude (multi-agent)",
  "startCmd": "claude --effort high --dangerously-skip-permissions --dangerously-load-development-channels server:nats --session-id {sessionId} -- {prompt}",
  "resumeCmd": "claude --effort high --dangerously-skip-permissions --dangerously-load-development-channels server:nats --resume {sessionId}",
  "icon": "⚡",
  "adapter": "claude"
}
```
The template invokes `claude --dangerously-load-development-channels server:nats`. There is no `--socket`, `--control`, `tinstar-*` flag, or anything else referencing `/tmp/tinstar-nats-<name>.sock`. The tinstar server is not the process spawning the channel-server; it is a sibling consumer of NATS that relies on a convention (`/tmp/tinstar-nats-<name>.sock`) the spawned channel server does not participate in.

### F9 — Spawn-time subscriptions DO work (non-trivial counter-example)

Evidence (live in this very investigation session):
- `quickfixes` was spawned with `--subscribe tinstar.work-space._._.tinstar-improvement.quickfixes`.
- A NATS reply from `otaui` addressed to `tinstar.work-space._._.tinstar-improvement.quickfixes` arrived in the `quickfixes` session as a `<channel source="nats" subject="tinstar.work-space._._.tinstar-improvement.quickfixes">` tag at approximately 2026-04-09 17:38 local time.
- Earlier, `quickfixes` published a reply to `tinstar.work-space.cmsandbox.ota.ota-ui.otaui` via the `reply` MCP tool; `otaui` received it and acknowledged it.

Both directions of the initial (spawn-time) subscription paths work. The failure is specific to subjects added after spawn.

### F10 — The NATS server itself is functional and accepts publishes to the breakout subject

Evidence:
```
$ nats --server=nats://localhost:4222 pub tinstar.breakout.harness '{...probe...}'
13:42:29 Published 69 bytes to "tinstar.breakout.harness"
pub exit=0
```
NATS accepted the publish with exit code 0. (This does not demonstrate delivery to any subscriber — see Known Unknowns `U3`.)

### F11 — Active NATS client connections from the nats-channel-mcp processes to nats-server:4222 are established

Evidence: `lsof -i :4222`:
```
bun  1992807  13u  IPv6 TCP ip6-localhost:40564->ip6-localhost:4222 (ESTABLISHED)  # otaui
bun  2076078  13u  IPv6 TCP ip6-localhost:56592->ip6-localhost:4222 (ESTABLISHED)  # s3reorg
bun  2099412  13u  IPv4 TCP localhost:42396->localhost:4222 (ESTABLISHED)          # pm
bun  2112349  13u  IPv4 TCP localhost:40544->localhost:4222 (ESTABLISHED)          # quickfixes
```
All nats-channel-mcp processes maintain active TCP connections to nats-server. NATS-layer connectivity is not broken.

---

## 3. Affected Cohort

- All currently-running NATS-enabled sessions in this workspace whose `nats.subscriptions` list on disk contains an entry that was **added via `POST /api/sessions/:name/subscriptions` after spawn**. Confirmed for:
  - `otaui` (2 post-spawn entries: `tinstar.breakout.harness`, `tinstar.breakout.tinstar-improvement`)
  - `e2e`   (1 post-spawn entry: `tinstar.breakout.harness`)
  - `quickfixes` (1 post-spawn entry: `tinstar.breakout.tinstar-improvement`)
- Generalizes to: every session spawned with `cliTemplate: "Claude (multi-agent)"` on this tinstar build (`V3.7.0 @ c83e977`), because the CLI template + server code path do not provide a socket for post-spawn subscribe commands.

## 4. Counter-Examples (Non-Repro Cohort)

- **Spawn-time subscriptions on the same sessions.** The two entries each session was spawned with (`tinstar.work-space.<hierarchy>` and `tinstar.work-space.<hierarchy>.<session>`) are delivered correctly — see F9. These entries travelled via `--subscribe` CLI args, not via the runtime subscribe socket. Trusted as a counter-example because F9 shows live bidirectional message flow during this same investigation using only spawn-time subscriptions.
- **NATS server (`nats-server` on :4222).** Publishes are accepted (F10), client TCP connections from nats-channel-mcp processes to nats-server are ESTABLISHED (F11). No evidence of NATS-layer failure.
- **Tinstar REST API.** All three subscription endpoints return successful responses and persist state correctly (F1, F2, F4). The bug is that the success is misleading, not that the endpoint returns errors.

## 5. Temporal Context

- **Socket file dates** (F6): the three sockets present in `/tmp/` are dated 2026-03-28 17:26, 2026-03-28 18:06, 2026-03-29 14:47. Their names (`mcp-agent`, `nats-worker`, `ui-agent`) do not correspond to any currently live session.
- **Oldest currently-running channel-server process:** the `e2e` nats-channel-mcp (PID 2404846) was spawned on 2026-04-08. All nine running channel-server processes were spawned on or after 2026-04-08. None of them created a socket at the expected path.
- **Relevant recent commits on `V3.7.0`:**
  - `c83e977` feat(spawn): allow repo and worktreePath overrides for hands
  - `9451b23` feat(runs): track parentId in service registry for hand lineage
  - `b7a658e` feat(hands): parent-child coordination model + dev channel auto-accept
  - `a6ae393` chore: default CLI template to Claude (multi-agent)
- **Earlier history (separate repo or earlier tree) referenced by older log:**
  - `d43bb67` feat(nats): add Claude (multi-agent) template with channels flag
  - `7fa1304` feat(nats-channel-mcp): publish traffic events for monitoring
  - `9c38fa7` feat: NATS agent channels integration for Tinstar sessions
- **What did not change (as far as this investigation established):** the text of `src/server/api/routes.ts` `sendNatsSocketCommand` (the socket path and the 5-second timeout) — it still hard-codes `/tmp/tinstar-nats-${sessionName}.sock` at V3.7.0 HEAD.
- Neither the git log scan nor the server log bounded *when* the convention first stopped being honored by the channel-server side. See Known Unknowns `U1`.

## 6. Environment + Access Context

- **Environment:** local developer machine, Linux 6.8.0-1047-aws, bash, user `ubuntu`.
- **Target:** standalone tinstar on port 5273 (`npx tinstar`, not dev server). Detection: `lsof -i :5273`. Per `~/.claude/skills/tinstar/SKILL.md`, standalone is the preferred mode.
- **Tinstar server PID:** written to `~/.config/tinstar/server.pid`. Log at `~/.config/tinstar/server.log`.
- **NATS server:** `nats-server` on `localhost:4222` (loopback IPv4 and IPv6). CLI: `nats` at `/home/ubuntu/.local/bin/nats`.
- **Repo working copy:** `/home/ubuntu/repo/tinstar`, branch `V3.7.0`, HEAD `c83e977` (dirty: see `git status` for in-flight UI work unrelated to this bug).
- **Skills to load for follow-up work:** `tinstar` (API surface), `superpowers:systematic-debugging` (hypothesis workflow), `bug-hypothesis-lab` (optional, for formal hypothesis tracking).
- **Credentials:** none required. All surfaces are local (loopback HTTP on :5273, loopback NATS on :4222, Unix sockets in `/tmp/`). No secrets referenced.

## 7. Constraints / Guardrails

- **Do not kill or restart running sessions** (`otaui`, `e2e`, `quickfixes`, etc.) without coordinating with the operator. Each has active in-flight work and a restart would lose conversation state.
- **Do not restart the tinstar server** without coordinating. Per user guidance (memory `feedback_dev_server.md`), the user runs standalone on :5273, not the dev server on :5280. Restart via `kill $(lsof -t -i :5273); sleep 1; npx tinstar --no-open &` per the tinstar SKILL, and only if necessary.
- **Destructive file operations forbidden** on `~/.config/tinstar/`, `~/.config/tinstar/sessions/*`, and `/tmp/tinstar-nats-*.sock`. Read-only investigation only.
- **Do not modify** `src/server/api/routes.ts`, `~/.config/tinstar/config.json`, or the session files during the diagnostic phase.
- **Publishing to `tinstar.breakout.*`** is allowed with a clearly-labelled probe subject/payload; probes sent so far use `{"from":"quickfixes-probe", ...}`. Keep probes idempotent and well-labelled.

## 8. Repro Prerequisites

1. Tinstar standalone server running on :5273 (`lsof -i :5273` shows a LISTEN).
2. NATS server running on :4222 (`lsof -i :4222` shows bound).
3. At least one session created with `cliTemplate: "Claude (multi-agent)"` and `nats.enabled: true`. Verify via `curl -s "$TINSTAR_URL/api/state" | jq '.sessions[] | select(.nats.enabled) | .name'`.
4. The session's nats-channel-mcp subprocess is actually running — confirm via `pgrep -af "nats-channel-mcp --name <session>"`.
5. No `/tmp/tinstar-nats-<sessionName>.sock` exists for the target session — confirm via `ls -la /tmp/tinstar-nats-*.sock`.
6. Repro step: `curl -s -X POST "$TINSTAR_URL/api/sessions/<name>/subscriptions" -H "Content-Type: application/json" -d '{"subject": "tinstar.breakout.probe-<timestamp>"}'`. Expected (buggy) outcome: API returns `{ok:true, ...}`, `server.log` gains a `WARN [nats] Failed to send subscribe to socket for <name>: connect ENOENT ...` line, and `pgrep -af nats-channel-mcp` shows the same process args as before (no post-spawn subscription).
7. Secondary repro: publish to `tinstar.breakout.probe-<timestamp>` from another tool (`nats pub ...` or another agent's `reply` tool). The subscribed session's conversation does not acquire a `<channel>` tag for the message.

## 9. Known Unknowns

- **U1.** When (which commit, which version) did the `/tmp/tinstar-nats-<name>.sock` convention stop being honored by the channel-server process? The three stale sockets dated 2026-03-28/29 prove *something* was creating them at that time; current running channel-servers do not. Need to cross-reference the 2026-03-28/29 session spawn command with the 2026-04-08 spawn command to see what changed (cli-template, nats-channel-mcp version, Claude version, or the --dangerously-load-development-channels wire protocol).
- **U2.** Is the socket creation responsibility supposed to live in (a) the `nats-channel-mcp` third-party package, (b) the Claude Code `--dangerously-load-development-channels server:nats` glue, or (c) tinstar itself (i.e. tinstar should create a sidecar process per session)? The current code in `routes.ts:108` is a client only — it never tries to create, bind, or own the socket. No evidence was found during this investigation of who is *supposed* to create it.
- **U3.** Does the probe publish in F10 reach *any* subscriber, or is it swallowed at the server because no client is subscribed? A definitive check requires a known-good subscriber at the time of publish (e.g. a concurrent `nats sub "tinstar.breakout.harness"`), which was not performed.
- **U4.** Does `DELETE /api/sessions/:name/subscriptions` fail the same way? The same `sendNatsSocketCommand` path with `action: 'unsubscribe'` is used (`routes.ts:2603`) and would hit the same missing socket, but the ENOENT pattern was not exercised in the log excerpt captured during this investigation.
- **U5.** Does the bug affect *non-breakout* post-spawn subscriptions (e.g. `tinstar.chain.*`, `tinstar.done.*`, entity-move cascades described in `docs/nats-agent-channels.md`)? The code path is identical, but no in-the-wild evidence was captured.
- **U6.** Do the 3 stale socket files in `/tmp/` represent a process that crashed without cleaning up, or sockets from a previous channel-server implementation that did participate in the protocol? Process-level forensics not performed.
- **U7.** Were the sessions `otaui`, `e2e`, `quickfixes` themselves aware of the breakout room at the application level (i.e. did their conversation histories ever acquire a `<channel>` tag from the breakout subject)? Not inspected; the channel-server process CLI args (F7) prove the subscription was never registered at the NATS layer, which is sufficient to establish non-delivery without inspecting conversation logs.
