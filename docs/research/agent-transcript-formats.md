# Agent Transcript Format Comparison

Research comparing Claude Code and Codex JSONL transcript formats. Used to inform the transcript adapter design.

## File Location

| Agent | Path Pattern |
|-------|-------------|
| Claude Code | `~/.claude/projects/<encoded-workdir>/<conversation-id>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl` |

Claude scopes transcripts per-project (workdir encoded as `/foo/bar` → `-foo-bar`). Codex uses a flat date tree with session ID in the filename.

## Top-Level Entry Types

| Claude Code | Codex |
|------------|-------|
| `assistant` — model output (text + tool_use blocks) | `response_item` — model output (message, function_call, reasoning) |
| `user` — user messages + tool results | `event_msg` — events (user_message, agent_message, task_started, task_complete, token_count) |
| `progress` — hook execution events | `turn_context` — per-turn metadata (cwd, model, policy) |
| `system` — system prompts | `session_meta` — session-level metadata (cwd, model, version) |
| `queue-operation` — queued user messages | `compacted` — context compaction with replacement history |
| `file-history-snapshot` — file state snapshots | |

## Status Detection Signals

**Claude Code:** Inferred from the last conversation entry:
- Last entry is `assistant` with `tool_use` blocks → `running` (tool pending)
- Last entry is `assistant` with text-only → `idle`
- Last entry is `user` → `running` (model thinking)
- Ambiguity: tool_use pending could mean executing OR waiting for permission → resolved with process-tree check

**Codex:** Explicit lifecycle events:
- `event_msg` with `payload.type: 'task_started'` → `running`
- `event_msg` with `payload.type: 'task_complete'` → `idle` (includes `last_agent_message`)
- No ambiguity — the log explicitly says when a turn ends

## User/Agent Messages

**Claude Code:**
- User: `type: 'user'`, `message.content` is string or array of content blocks
- Agent: `type: 'assistant'`, `message.content` array with `type: 'text'` blocks
- Tool calls: `type: 'assistant'`, content block `type: 'tool_use'` with `name` and `input`
- Tool results: `type: 'user'`, content block `type: 'tool_result'` with `content`

**Codex:**
- User: `event_msg` with `payload.type: 'user_message'`, `payload.message` is string
- Agent: `event_msg` with `payload.type: 'agent_message'`, `payload.message` is string
- Tool calls: `response_item` with `payload.type: 'function_call'`, `payload.name` and `payload.arguments`
- Tool results: `response_item` with `payload.type: 'function_call_output'`, `payload.output`
- File edits: `response_item` with `payload.type: 'custom_tool_call'`, `payload.name: 'apply_patch'`

## Adapter Interface (Proposed)

Each agent backend needs to implement:

1. **`findTranscript(workdir, sessionId)`** — locate the JSONL file given a workspace path and session ID
2. **`readStatus(transcriptPath)`** — derive running/idle from the transcript tail
3. **`parseRecapEntries(transcriptPath, offset)`** — extract user prompts and agent responses for the recap panel

The process-tree check (no children = blocked on input) works for both agents and is agent-agnostic.
