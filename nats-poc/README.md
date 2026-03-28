# claude-nats-channel

An MCP channel server that bridges [NATS](https://nats.io) pub/sub into [Claude Code](https://claude.ai/code) sessions. Publish a message to a NATS subject and it arrives in your Claude session as a `<channel>` tag. Claude can publish back to any NATS subject using the built-in `reply` tool.

This is the primitive for building multi-agent systems where Claude agents communicate via NATS.

```
Publisher → NATS → channel server → <channel> tag → Claude acts → reply tool → NATS → next agent
```

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [NATS server](https://nats.io/download/) running locally (`nats-server`)
- [Claude Code](https://claude.ai/code) ≥ v2.1.80 with a claude.ai account (OAuth — not an API key)
- `nats` CLI (optional, for testing): [install](https://github.com/nats-io/natscli)

---

## Install

```bash
git clone <this-repo>
cd claude-nats-channel
bun install
```

---

## Quick Start

**1. Start NATS:**
```bash
nats-server
```

**2. Configure your Claude session** — create `.mcp.json` in your project directory:
```json
{
  "mcpServers": {
    "nats": {
      "command": "bun",
      "args": [
        "/path/to/claude-nats-channel/channel-server.ts",
        "--name", "my-agent",
        "--subscribe", "tinstar.agent.my-agent",
        "--instructions", "You are my-agent. When you receive a <channel> message, act on it and use the reply tool to publish results."
      ]
    }
  }
}
```

**3. Start Claude with channel support:**
```bash
claude --mcp-config .mcp.json --dangerously-load-development-channels server:nats
```

Confirm the dev channel prompt when asked. You'll see:
```
Listening for channel messages from: server:nats
```

**4. Send a message:**
```bash
nats pub tinstar.agent.my-agent "Hello, please respond."
```

Claude wakes up, processes the message, and can reply using the `reply` tool.

---

## CLI Reference

```
bun channel-server.ts [options]
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--name` | ✅ | — | Agent name, used in channel source attribute and default instructions |
| `--subscribe` | ✅ | — | Initial NATS subject to subscribe to |
| `--nats` | — | `nats://localhost:4222` | NATS server URL |
| `--instructions` | — | Auto-generated | Injected into Claude's system prompt. Tell Claude who it is, what the messages mean, and what to do with them. |

---

## The `reply` Tool

Claude can publish to any NATS subject using the `reply` MCP tool:

```
reply(to: "some.subject", text: "message content")
```

This is how agents forward work to other agents or signal completion.

---

## How Messages Arrive in Claude

Messages appear as `<channel>` tags in Claude's context:

```xml
<channel source="nats" subject="tinstar.agent.my-agent">
  your message content here
</channel>
```

The `subject` attribute tells Claude which subscription the message came from — useful when an agent subscribes to multiple subjects.

---

## Multi-Agent Chains

Each agent subscribes to its own subject. Agents are "introduced" by baking routing instructions into their `--instructions` string at startup.

**A1 knows about A2:**
```
--instructions "You are A1. When you finish your task, use the reply tool 
to publish the result to tinstar.agent.a2."
```

**A2 knows where to send completions:**
```
--instructions "You are A2. Process what arrives, then publish your 
result to tinstar.done.chain-001."
```

**Clawson (or any orchestrator) watches for completion:**
```bash
nats sub tinstar.done.chain-001
```

---

## Example: Intro Chain

Two agents introduce themselves in sequence. See [`examples/intro-chain/`](./examples/intro-chain/).

```bash
cd examples/intro-chain
./run.sh
```

Expected output (on the `tinstar.done.chain-001` subject):
```
Greetings! I am Countess Beets McGillicuddy, at your service.
```

---

## Known Limitations

| Issue | Workaround |
|---|---|
| **Tool approval prompts** | Claude asks permission before calling `reply`. Accept once and choose "don't ask again" for the session, or use `--dangerously-skip-permissions` in sandboxed environments. |
| **Fire-and-forget delivery** | If no subscriber is listening when a message is published, it's lost. Use [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) for durable delivery. |
| **Startup confirmation prompt** | `--dangerously-load-development-channels` requires one interactive confirmation. Automate with `echo 1 | claude ...` or add a `--yes` wrapper. |
| **Research preview** | Channels require Claude Code ≥ v2.1.80. The `--dangerously-load-development-channels` flag is for development only — approved channels use `--channels plugin:name@marketplace`. |
| **NATS server must be running** | Start `nats-server` before launching Claude sessions. |

---

## Architecture

```
┌─────────────────────────────────────────┐
│           Claude Code session            │
│                                          │
│  system prompt: <instructions>           │
│                                          │
│  ← <channel source="nats" subject="..."> │
│     message content                      │
│  </channel>                              │
│                                          │
│  → reply(to="...", text="...")  ─────────┼──→ NATS
└─────────────────────────────────────────┘     ↑
        ↑ notifications/claude/channel          │
        │                                       │
┌───────────────────────┐                       │
│  channel-server.ts    │                       │
│  (MCP subprocess)     │                       │
│                       │                       │
│  nc.subscribe(subj) ←─┼─── NATS ─────────────┘
│  mcp.notification()   │
│  reply tool handler   │
└───────────────────────┘
```

The channel server runs as a subprocess spawned by Claude Code via `.mcp.json`. It holds the NATS connection and bridges both directions. Claude Code never touches NATS directly.

---

## Roadmap

- [ ] Hot subscription management via Unix socket (add/remove subjects without restart)
- [ ] NATS JetStream support for durable delivery
- [ ] Multiple initial subjects (`--subscribe` repeated)
- [ ] Tinstar integration (lifecycle management, entity-hierarchy subjects)
