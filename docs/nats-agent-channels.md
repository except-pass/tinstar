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
send path. Worktree broadcasts and breakout rooms deliver to their other live
subscribers, never back to the authenticated sender. An explicitly addressed
self-DM remains valid.

Managed Claude sessions disable Claude's native `ListAgents` and `SendMessage`
tools while NATS is enabled. Claude's native peer registry is user-global, not
scoped to a Tinstar run, so it is not a safe fallback for hand communication.
Use the managed `reply` tool and its durable receipt instead.

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

The channel server is launched from the configured
`nats.channelServerPackage` using `nats.bunPath`. Run `tinstar doctor` when NATS
appears healthy at the broker but an agent's managed `reply` tool is missing;
an absent or misconfigured Bun executable is a common cause.
