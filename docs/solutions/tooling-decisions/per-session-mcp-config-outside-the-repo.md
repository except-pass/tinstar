---
title: Give a session its MCP/channel config via --mcp-config, not a repo .mcp.json
date: 2026-07-06
category: docs/solutions/tooling-decisions
module: sessions
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "Generating a per-session Claude Code MCP or NATS-channel config from the backend"
  - "Tempted to write a generated .mcp.json into a session's git workspace"
  - "Using --dangerously-load-development-channels server:<name> and deciding where its server is defined"
  - "Building the claude launch command by interpolating a template that ends in ' -- {prompt}'"
tags: [claude-code, mcp-config, dev-channels, nats, session-launch, command-building]
---

# Give a session its MCP/channel config via --mcp-config, not a repo .mcp.json

## Context

Tinstar gives each multi-agent session a NATS channel with Claude Code's
`--dangerously-load-development-channels server:nats` flag, which needs an MCP
server named `nats` defined somewhere Claude will read. The original design wrote
that definition into a `.mcp.json` in the session's **git workspace** and relied
on Claude's current-working-directory lookup — because an older Claude Code build
would only resolve the dev-channels server from a CWD `.mcp.json` or user scope,
and reported `no MCP server configured with that name` when the server was passed
via `--mcp-config`.

That constraint drove four bad properties: a generated file landing in the user's
repo, clobbering a project's own `.mcp.json` (the writer replaced the whole file
with no merge), no cleanup on stop, and an elaborate byte-identical-`${VAR}`/tmux-
env-injection dance whose only purpose was to keep the shared in-repo file from
churning across concurrent sessions.

## Guidance

**As of Claude Code 2.1.201, the dev-channels resolver reads its named server from
`--mcp-config <file>`.** So generate the per-session config into the session's own
config dir (outside any git tree) and launch with `--mcp-config <path>`. The file
is now private and per-session, so it can carry literal per-session values
directly — no `${VAR}` env-token indirection, no churn-avoidance machinery.

Verified empirically (the resolver behavior is undocumented, so don't trust a memory
of it — re-probe). Use a filesystem side-effect the resolver can't hide: point the
server's `command` at something that touches a flag file, then check the flag.

```bash
# server def whose command leaves a trace when the resolver actually launches it
{ "mcpServers": { "nats": { "command": "bash",
  "args": ["-c", "touch /tmp/spawned; sleep 20"] } } }

# nats defined ONLY via --mcp-config, --strict-mcp-config so nothing leaks from CWD
( cd empty-dir && claude -p "ok" --dangerously-skip-permissions \
    --strict-mcp-config --mcp-config /path/to/that.json \
    --dangerously-load-development-channels server:nats )
# → /tmp/spawned exists ⇒ the resolver read the server from --mcp-config
```

Two composition facts also verified this way:

- **Non-strict `--mcp-config` coexists with a project's own CWD `.mcp.json`** — a
  differently-named project server and the injected one both load. So you do NOT
  need `--strict-mcp-config` in production; a project keeps its own MCP servers.
- **On a same-name collision, `--mcp-config` wins over the CWD `.mcp.json`.** This
  is what makes stale, old-design `.mcp.json` files left in previously-used repos
  functionally inert — the injected config takes precedence.

**Related pitfall — command assembly.** The launch command is built by
interpolating a template that ends in ` -- {prompt}`, then inserting option flags
(`--mcp-config`, `--append-system-prompt`, `--model`) before that separator. Do
**not** re-scan `indexOf(' -- ')` per flag: a session-name-derived `--mcp-config`
path (breakout sessions are named from unvalidated user strings and can contain
spaces) or a prompt/persona that itself contains `' -- '` will be mistaken for the
real separator and corrupt the command. Split the prompt tail off **once**, splice
all pre-prompt flags into the head as a single bundle, then reattach the tail.

## Why This Matters

Coupling the config's *location* to the tool's resolver quirk is what created every
downstream smell. Moving it to `--mcp-config` dissolves all four at once: nothing is
written into the user's repo, a project's real `.mcp.json` is never clobbered, there
is no orphaned file to clean up on stop, and the per-session file needs no
byte-identical/`${VAR}` machinery. It also fixed a real bug: a session with the
dev-channels flag but no reachable `.mcp.json` (e.g. a blank project) aborted at
launch **before** consuming its trailing `-- {prompt}`, so the user's prompt was
silently lost. Keeping the flag and the file coupled (strip the flag when no config
is provisioned; inject `--mcp-config` when it is) closes that class.

## When to Apply

- Any backend-generated, per-session Claude Code MCP config — reach for a
  per-session file + `--mcp-config`, not a file in the workspace.
- Before relying on where a `--dangerously-load-development-channels` server is
  read from: re-probe on the current CLI version; the behavior is undocumented and
  has already changed once.
- Whenever inserting option flags into a launch command whose values can contain
  `' -- '` — split once, don't re-scan.

## Examples

Before (in-repo, env-token indirection):

```
<workspace>/.mcp.json   # in the git tree; clobbers a project's own; never cleaned
  args: [..., --name, ${TINSTAR_SESSION_NAME}, --topics-file, ${TINSTAR_NATS_TOPICS_FILE}, ...]
claude ... --dangerously-load-development-channels server:nats -- {prompt}
```

After (per-session file, literals, explicit path):

```
<sessionsDir>/<name>/nats-mcp.json   # outside git; private; literal args
  args: [..., --name, <sessionName>, --topics-file, <topicsPath>, --control-socket, <socketPath>]
claude ... --dangerously-load-development-channels server:nats --mcp-config <that path> -- {prompt}
```

## Related

- Convention: [Agent skills must derive the backend URL from TINSTAR_DASHBOARD_URL](../conventions/agent-skill-backend-url-env-var.md) — the same env-injection surface; its injected-vars inventory was updated when the NATS env vars stopped being injected.
- `generateNatsMcpConfig` and `buildAgentCommand` in `src/server/sessions/backends/tmux.ts`.
- The historical CWD-only design and PoC live in `docs/nats-agent-channels.md` (with a shipped-implementation note pointing here).
- Shipped in PR #105.
