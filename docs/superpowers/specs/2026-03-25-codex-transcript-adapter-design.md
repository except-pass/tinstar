# Codex Transcript Adapter

## Problem

The status watcher currently only parses Claude Code JSONL transcripts. Codex sessions fall back to process-tree detection only — no JSONL-based status, no recap entries. We need a Codex adapter that finds and parses Codex logs.

## Discovery Challenge

Unlike Claude (which accepts `--session-id` at start), Codex assigns its own session ID. Tinstar can't control the JSONL filename. Discovery must work after the fact.

## Design

### Transcript Discovery

Find the Codex JSONL file belonging to a Tinstar session by cross-referencing terminal output with log content.

**Algorithm (runs in status watcher poll loop):**

1. **Cache hit** — if we already have a cached transcript path for this session, check it's still being written to (mtime recent). If stale, clear cache and proceed to step 2.

2. **Narrow candidates** — list `~/.codex/sessions/YYYY/MM/DD/*.jsonl` starting from the session's creation date through today. Read first line of each (`session_meta`) and filter to those whose `payload.cwd` matches `session.workspace.path`.

3. **Text match** — for each candidate (most recent first):
   - Tail 8KB from the file, extract `event_msg:agent_message` text
   - Capture ~200 lines from the tmux pane (`tmux capture-pane -S -200`)
   - If any agent message text appears in the tmux capture → match found

4. **Cache and use** — store the matched path in an in-memory `Map<sessionName, transcriptPath>`. All subsequent polls read this file directly.

5. **No match** — fall back to process-tree detection (existing behavior).

**Self-healing:** if the cached file stops being modified but process-tree says the agent is running, clear the cache. Next tick rediscovers (handles Codex restart into a new file).

### Status Parsing

Once we have the JSONL file, derive status from Codex's explicit lifecycle events:

- `event_msg` with `payload.type: 'task_started'` → `running`
- `event_msg` with `payload.type: 'task_complete'` → `idle`

Scan backwards from file tail (same `readTail` approach as Claude parser). These events are unambiguous — no need for the process-tree permission-check heuristic for Codex.

### Recap Entries

Extract user prompts and agent responses for the recap panel:

- User: `event_msg` with `payload.type: 'user_message'` → `payload.message`
- Agent: `event_msg` with `payload.type: 'task_complete'` → `payload.last_agent_message`

Group into turns the same way the Claude parser does.

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/server/sessions/codex-transcript.ts` | **New.** Discovery function, status parser, recap parser |
| `src/server/sessions/status-watcher.ts` | Wire `adapter === 'codex'` branch to use codex transcript functions |
| `src/server/sessions/transcript-parser.ts` | Extract shared `readTail` utility if needed |

## What Stays the Same

- Process-tree detection remains as universal fallback
- Claude adapter unchanged
- CLI templates, session model, UI unchanged
- `generic` adapter stays process-tree-only (for unknown agents)

## Verified

Discovery algorithm tested live against the sitehistory Codex session:
- Correct file matched via cwd + text comparison
- Wrong file correctly rejected (no text overlap)
- Agent message "I've isolated the regression" found in both JSONL tail and tmux pane
