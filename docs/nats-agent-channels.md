# NATS Agent Channels

Managed agents communicate through Project/Worktree-scoped NATS subjects.

## Subject scheme

```text
tinstar.<space>.<project>.<worktree>           # Worktree broadcast
tinstar.<space>.<project>.<worktree>.<session> # direct session inbox
tinstar.room.<room-id>                          # ad-hoc breakout room
```

Tokens are lowercased and sanitized to letters, digits, `_`, and `-`. Missing
scope positions are represented by `_`.

A session with both Project and Worktree scope subscribes to its Worktree
broadcast and direct inbox. Project-only and Unscoped sessions subscribe only
to their direct inbox; Tinstar does not grant a Project-wide or Space-wide
wildcard implicitly.

## Scope inheritance

New sessions derive their NATS path from the same Project/Worktree scope used
by the dashboard hierarchy. A hand spawned from another session inherits the
parent's complete scope by default. If a run is moved to another scope through
`PATCH /api/widgets/:id/scope`, Tinstar updates its persisted subscriptions and
hot-applies the add/remove diff to the running channel server.

## Sending

Use the managed `reply` tool from inside an agent session:

```text
reply(to="tinstar.<space>.<project>.<worktree>", text="Status check")
reply(to="tinstar.<space>.<project>.<worktree>.<session>", text="Question")
```

The Tinstar router authenticates the sender, resolves live recipients, records
accepted delivery obligations durably, then returns an accepted, partial, or
error receipt. Raw publication to the private router subject is not a supported
send path.

## Subscription management

Subscriptions are persisted with the session and hot-managed over the channel
server's Unix control socket.

```text
POST   /api/sessions/:name/subscriptions
DELETE /api/sessions/:name/subscriptions
GET    /api/sessions/:name/subscriptions
```

The POST and DELETE bodies are `{ "subject": "..." }`. Use these endpoints for
explicit rooms or specialist channels; ordinary Project/Worktree subscriptions
are automatic.

## Breakout rooms

Breakout rooms are independent of organizational scope:

```text
tinstar.room.<room-id>
```

They require no registration. A room exists as soon as a participant subscribes
or publishes to it. Spawned hands use a breakout room for their parent-child
link when available, with the parent's direct subject as the fallback.

## Runtime requirement

Tinstar's launcher starts the configured `nats.channelServerPackage` using
`nats.bunPath`. The first managed MCP process for a session owns its real NATS
subscriptions and Unix control socket. Native Codex children inherit the
parent’s required MCP descriptor, so later processes become reply-only
followers: they retain the authenticated `reply` path, but receive a private
random sink subscription instead of the parent’s topics and never bind the
parent’s control socket. This keeps inbound delivery and hot subscription
management single-owner. The owner generation lives in the private per-session
config directory and records the root MCP host, launcher, and a dedicated
supervisor before that supervisor starts the channel server. Only that root MCP
host may recover inbound ownership after an owner gap; an inherited child MCP
remains reply-only even if it relaunches first. A private startup gate records a
detached process group before it execs Bun, so the group remains authoritative
if `bun x` forks the runtime and its wrapper leader is hard-killed. An atomically
published transition lease serializes owner publication, supervisor registration and channel spawn,
stale-owner recovery, and lifecycle reaping. The lease carries a process birth
identity, so a hard-killed transition holder can be recovered without trusting a
reused PID. Unsupported or malformed protocol records fail closed rather than
being reclaimed by an older Tinstar. A hard-killed launcher or supervisor therefore cannot leave an
unrecorded subscriber, including during startup: lifecycle reaping either observes the
published generation or runs before that generation can publish. Reconnect and
restart signal the complete channel process group, leave reply-only followers
running, invalidate any late supervisor, and remove the retired generation
before a replacement can start.

The sink is a compatibility measure for the current channel server, which
requires at least one subscription at startup. A native upstream reply-only
mode can replace it without changing Tinstar's ownership contract.

The checked-in CI gate runs this boundary against the exact pinned
`nats-channel-mcp` runtime. The real-Codex proof needs a credentialed, isolated
Codex home and is opt-in:

```bash
TINSTAR_NATIVE_CODEX_HOME=/path/to/isolated/codex-home \
  TINSTAR_REQUIRE_NATIVE_CODEX_BOUNDARY=1 \
  npx vitest run src/server/providers/__tests__/codex-child-router-nats.integration.test.ts
```

The requirement flag makes missing Codex credentials or CLI fail instead of
skip. A protected CI job can use it once non-interactive credentials exist; the
public unit-test job cannot safely manufacture them.

Run `tinstar doctor` when NATS appears healthy at the broker but an agent's
managed `reply` tool is missing; an absent or misconfigured Bun executable is a
common cause.
