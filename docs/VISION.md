# Tinstar Vision

A real-time collaborative canvas where teams manage AI agent workflows. Technical, non-technical, and management personas all see the same work through different widgets. Like VS Code is language-agnostic, Tinstar is agent-agnostic.

## Pillars

### Multi-user collaboration
Same canvas, multiple users, real-time. The event bus and document store are already designed around broadcast — SSE pushes every state change to all connected clients. The path forward is multi-user identity, permissions, and shared cursor presence. State is server-authoritative; clients are projections.

### Persona-driven widgets
The widget model is the abstraction layer between raw agent work and human understanding. Technical users see terminals, file diffs, and JSONL transcripts. Managers see throughput, cost, and team activity. Same underlying data (runs, sessions, git diffs, transcripts), different projections. Don't build three products — build one composable widget system where personas are just default widget presets.

### Agent agnosticism
Today it's Claude Code and Codex. The abstraction is a plugin/adapter that implements: session lifecycle (start, stop, resume), transcript parsing (how to read logs), status detection (running vs idle vs blocked), and file tracking (what changed). Everything agent-specific lives behind this interface. The process-tree detection we just built proves the direction — it works for both Claude and Codex because it targets OS-level signals (child PIDs), not agent internals. The hook removal proves the inverse — agent-specific hooks were fragile and got ripped out.

## Decision guardrails

When facing a design choice, prefer:

- **Agent-agnostic OS signals over agent-specific hooks or APIs** — process trees, file modification times, and transcript file formats are stable across agent versions. Agent-internal hooks break on upgrades.
- **Composable widgets over purpose-built views** — a "manager dashboard" is a widget layout, not a separate page. Every view is a canvas arrangement.
- **Observable artifacts over agent cooperation** — assume the agent doesn't know Tinstar exists. Derive everything from what the agent leaves behind: transcripts, files, processes, git state.
- **Server-authoritative state over client-local state** — collaboration requires a single source of truth. Widget layouts can be local; session state, run data, and file tracking cannot.
- **Extraction over integration** — when you find agent-specific logic in core code, extract it into an adapter. Don't add more.
