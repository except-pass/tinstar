# Events

## Overview
Events capture Claude Code hook activities during agent sessions. The system ingests raw event records from Claude hooks, stores them for analysis, and provides specialized extraction for key event types like todo management and file operations. This enables session monitoring, productivity tracking, and agent behavior analysis.

## Data Contracts

### Entities
- Event (Base)
  - `session_id` (string, UUID from Claude session)
  - `timestamp` (ISO 8601)
  - `hook_event_name` (string: "PreToolUse", "PostToolUse", "Stop", etc.)
  - `transcript_path` (optional string, path to session transcript)
  - `tinstar_term_name` (optional string, terminal identifier from environment variable)
  - `tool_name` (optional string, e.g., "TodoWrite", "Edit", "Bash")
  - `tool_input` (optional object, tool parameters)
  - `tool_response` (optional any, tool output)
  - `message` (optional string, user or assistant message content)

- TodoEvent (specialized)
  - Inherits all Event fields
  - `type` ("new" | "update")
  - For PreToolUse: `tool_input.todos` (array of Todo objects)
  - For PostToolUse: `tool_response.oldTodos` and `tool_response.newTodos` (arrays of Todo objects)

- Todo
  - `id` (string, unique identifier)
  - `content` (string, task description)
  - `status` ("pending" | "in_progress" | "completed")
  - `priority` (optional string: "high" | "medium" | "low")

- FileEvent (specialized)
  - Inherits all Event fields
  - `file_path` (string, relative or absolute path)
  - `operation` ("write" | "edit" | "multiedit")
  - `lines_added` (optional number, from git diff)
  - `lines_removed` (optional number, from git diff)
  - `content_preview` (optional string, first 200 chars of changes)

### Data Contract Examples

**New Todo List Creation (PreToolUse):**
```json
{
  "session_id": "ceb0b060-578b-4638-a1cd-d445f4310f87",
  "transcript_path": "/home/ubuntu/.claude/projects/-home-ubuntu-repo-ctrltower/ceb0b060-578b-4638-a1cd-d445f4310f87.jsonl",
  "cwd": "/home/ubuntu/repo/ctrltower",
  "hook_event_name": "PreToolUse",
  "tool_name": "TodoWrite",
  "tool_input": {
    "todos": [
      {
        "content": "Analyze the current codebase structure and files",
        "status": "in_progress",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Review existing CLAUDE.md content",
        "status": "pending",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Update CLAUDE.md with current understanding of the codebase",
        "status": "pending",
        "priority": "high",
        "id": "3"
      }
    ]
  },
  "timestamp": "2025-07-19T11:57:14+00:00",
  "type": "PreToolUse"
}
```

**New Todo List Creation (PostToolUse with oldTodos=[] for new list):**
```json
{
  "session_id": "ceb0b060-578b-4638-a1cd-d445f4310f87",
  "transcript_path": "/home/ubuntu/.claude/projects/-home-ubuntu-repo-ctrltower/ceb0b060-578b-4638-a1cd-d445f4310f87.jsonl",
  "cwd": "/home/ubuntu/repo/ctrltower",
  "hook_event_name": "PostToolUse",
  "tool_name": "TodoWrite",
  "tool_input": {
    "todos": [
      {
        "content": "Analyze the current codebase structure and files",
        "status": "in_progress",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Review existing CLAUDE.md content",
        "status": "pending",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Update CLAUDE.md with current understanding of the codebase",
        "status": "pending",
        "priority": "high",
        "id": "3"
      }
    ]
  },
  "tool_response": {
    "oldTodos": [],
    "newTodos": [
      {
        "content": "Analyze the current codebase structure and files",
        "status": "in_progress",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Review existing CLAUDE.md content",
        "status": "pending",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Update CLAUDE.md with current understanding of the codebase",
        "status": "pending",
        "priority": "high",
        "id": "3"
      }
    ]
  },
  "timestamp": "2025-07-19T11:57:14+00:00",
  "type": "PostToolUse"
}
```

**Todo List Update (PostToolUse with status changes):**
```json
{
  "session_id": "ceb0b060-578b-4638-a1cd-d445f4310f87",
  "transcript_path": "/home/ubuntu/.claude/projects/-home-ubuntu-repo-ctrltower/ceb0b060-578b-4638-a1cd-d445f4310f87.jsonl",
  "cwd": "/home/ubuntu/repo/ctrltower",
  "hook_event_name": "PostToolUse",
  "tool_name": "TodoWrite",
  "tool_input": {
    "todos": [
      {
        "content": "Analyze the current codebase structure and files",
        "status": "completed",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Review existing CLAUDE.md content",
        "status": "in_progress",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Update CLAUDE.md with current understanding of the codebase",
        "status": "pending",
        "priority": "high",
        "id": "3"
      }
    ]
  },
  "tool_response": {
    "oldTodos": [
      {
        "content": "Analyze the current codebase structure and files",
        "status": "in_progress",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Review existing CLAUDE.md content",
        "status": "pending",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Update CLAUDE.md with current understanding of the codebase",
        "status": "pending",
        "priority": "high",
        "id": "3"
      }
    ],
    "newTodos": [
      {
        "content": "Analyze the current codebase structure and files",
        "status": "completed",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Review existing CLAUDE.md content",
        "status": "in_progress",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Update CLAUDE.md with current understanding of the codebase",
        "status": "pending",
        "priority": "high",
        "id": "3"
      }
    ]
  },
  "timestamp": "2025-07-19T11:57:31+00:00",
  "type": "PostToolUse"
}
```

**Todo List Replacement (completely new set of todos):**
```json
{
  "session_id": "ceb0b060-578b-4638-a1cd-d445f4310f87",
  "transcript_path": "/home/ubuntu/.claude/projects/-home-ubuntu-repo-ctrltower/ceb0b060-578b-4638-a1cd-d445f4310f87.jsonl",
  "cwd": "/home/ubuntu/repo/ctrltower",
  "hook_event_name": "PostToolUse",
  "tool_name": "TodoWrite",
  "tool_input": {
    "todos": [
      {
        "content": "Investigate event type selector UI issue",
        "status": "in_progress",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Fix select all/none buttons functionality",
        "status": "pending",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Fix individual checkbox filtering",
        "status": "pending",
        "priority": "high",
        "id": "3"
      },
      {
        "content": "Test the fixes",
        "status": "pending",
        "priority": "medium",
        "id": "4"
      }
    ]
  },
  "tool_response": {
    "oldTodos": [
      {
        "content": "Analyze the current codebase structure and files",
        "status": "completed",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Review existing CLAUDE.md content",
        "status": "completed",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Update CLAUDE.md with current understanding of the codebase",
        "status": "completed",
        "priority": "high",
        "id": "3"
      }
    ],
    "newTodos": [
      {
        "content": "Investigate event type selector UI issue",
        "status": "in_progress",
        "priority": "high",
        "id": "1"
      },
      {
        "content": "Fix select all/none buttons functionality",
        "status": "pending",
        "priority": "high",
        "id": "2"
      },
      {
        "content": "Fix individual checkbox filtering",
        "status": "pending",
        "priority": "high",
        "id": "3"
      },
      {
        "content": "Test the fixes",
        "status": "pending",
        "priority": "medium",
        "id": "4"
      }
    ]
  },
  "timestamp": "2025-07-19T12:00:20+00:00",
  "type": "PostToolUse"
}
```

### API (HTTP)
- POST `/api/events/pre_tool_use`
  - Body: `Event` (raw hook data)
  - Response: `{ "success": true }`
- POST `/api/events/post_tool_use`
  - Body: `Event` (raw hook data)
  - Response: `{ "success": true }`
- POST `/api/events/todowrite`
  - Body: `Event` (raw hook data with TodoWrite tool)
  - Response: `{ "success": true }`
- POST `/api/events/notification`
  - Body: `Event` (raw hook data)
  - Response: `{ "success": true }`
- POST `/api/events/stop`
  - Body: `Event` (raw hook data)
  - Response: `{ "success": true }`
- POST `/api/events/subagent_stop`
  - Body: `Event` (raw hook data)
  - Response: `{ "success": true }`
- POST `/api/events/user_prompt`
  - Body: `Event` (raw hook data)
  - Response: `{ "success": true }`

- GET `/api/events/todos`
  - Query: `?session_id=<id>&start_time=<iso>&end_time=<iso>&tinstar_term_name=<name>`
  - Response: `TodoEvent[]`

- GET `/api/events/files`
  - Query: `?session_id=<id>&start_time=<iso>&end_time=<iso>&tinstar_term_name=<name>`
  - Response: `FileEvent[]`

- GET `/api/events`
  - Query: `?session_id=<id>&start_time=<iso>&end_time=<iso>&tinstar_term_name=<name>&type=<event_type>`
  - Response: `Event[]`

- POST `/api/events/clear`
  - Response: `{ "success": true, "message": "Database cleared" }`

- WebSocket `/api/events/ws`
  - Real-time event broadcasting
  - Message format: `{ "type": "<event_type>", "data": Event }`

### CLI (Typer)
- `tinstar events list --session <id> [--start <iso>] [--end <iso>] [--term <name>] [--type <type>]`
- `tinstar events todos --session <id> [--start <iso>] [--end <iso>] [--term <name>]`
- `tinstar events files --session <id> [--start <iso>] [--end <iso>] [--term <name>]`
- `tinstar events clear --confirm`

## Logic

### Event Ingestion
- Accept raw hook payloads via POST endpoints
- Validate basic schema (session_id, timestamp required)
- Store complete raw event in main events table
- For specialized events (TodoWrite, file operations), also extract to specialized tables
- Broadcast to WebSocket clients for real-time monitoring
- Log failed events to separate file with full payload for debugging

### Hook Integration
- Each Claude hook type maps to specific endpoint (`/events/pre_tool_use`, etc.)
- Session ID mapping: update session registry when session_id + tinstar_term_name seen
- Handle both pre and post tool use events for complete tool lifecycle tracking
- Special handling for TodoWrite events (extract todo arrays)
- File operation events (Write, Edit, MultiEdit) aggregate into FileEvent table

### Specialized Event Processing
TodoWrite Events:
- **PreToolUse events**: Extract `tool_input.todos` array directly
- **PostToolUse events**: Extract both `tool_response.oldTodos` and `tool_response.newTodos` arrays
- **New todo list detection**: `tool_response.oldTodos` is empty array `[]`
- **Todo list updates**: Compare `oldTodos` vs `newTodos` to detect status changes, additions, or removals
- **Todo list replacement**: Completely different todo sets (different IDs/content) between old and new
- Store individual todos with session_id, timestamp, tinstar_term_name, todo_id, content, status, priority
- Track todo lifecycle transitions: pending → in_progress → completed

File Events:
- Detect file operation tools: Write, Edit, MultiEdit, NotebookEdit
- Extract file path from tool_input
- Calculate line changes using git diff when possible
- Store preview of changes (first 200 chars)
- Group related operations by session and time window

### Validation Rules
- `session_id` must be valid UUID format
- `timestamp` must be valid ISO 8601
- `hook_event_name` must be from allowed set
- Query time ranges: `start_time` ≤ `end_time`, both optional
- Query filtering by `tinstar_term_name` to isolate specific terminal sessions
- File paths sanitized to prevent directory traversal
- WebSocket connections authenticated via session validation

### Storage
- SQLite in `~/.tinstar/db/events.db`
- Tables:
  - `events` (id, session_id, timestamp, hook_event_name, tinstar_term_name, raw_data TEXT as JSON)
  - `todos` (id, session_id, timestamp, tinstar_term_name, type, todo_id, content, status, priority)
  - `files` (id, session_id, timestamp, tinstar_term_name, file_path, operation, lines_added, lines_removed, content_preview)
- Indexes on session_id, timestamp, tinstar_term_name for fast queries
- Retention policy: configurable, default 30 days

### Real-time Broadcasting
- WebSocket endpoint for live event streams
- Connection manager tracks active clients
- Error handling for disconnected clients
- Event filtering by session_id or event type
- Graceful degradation if WebSocket fails (events still stored)

## Tests

- Ingest basic event
  - Given: valid Event payload with required fields
  - When: POST `/events/pre_tool_use`
  - Then: event stored in database; WebSocket clients notified; returns success

- Handle malformed event
  - Given: invalid JSON or missing required fields
  - When: POST to any events endpoint
  - Then: returns 422 validation error; failed event logged to file; no database changes

- Extract TodoWrite event
  - Given: PreToolUse event with tool_name="TodoWrite" and todos array
  - When: event ingested
  - Then: stored in both events and todos tables; type="new"; todos extracted correctly

- Extract todo update
  - Given: TodoWrite event with old_todos and new_todos arrays
  - When: event ingested
  - Then: type="update"; both arrays stored; old/new todo comparison available

- Extract file operation
  - Given: PostToolUse event with tool_name="Edit" and file_path
  - When: event ingested
  - Then: stored in events and files tables; operation="edit"; file_path extracted

- Query todos by session
  - Given: multiple TodoWrite events for different sessions
  - When: GET `/events/todos?session_id=abc123`
  - Then: returns only todos for specified session, ordered by timestamp

- Query with time range
  - Given: events spanning multiple days
  - When: GET `/events?start_time=2025-01-01T00:00:00Z&end_time=2025-01-02T00:00:00Z`
  - Then: returns only events within time range

- WebSocket broadcasting
  - Given: active WebSocket client connected
  - When: new event ingested
  - Then: client receives real-time event notification with correct format

- Failed event logging
  - Given: event ingestion fails due to database error
  - When: error occurs
  - Then: complete event payload logged to failed-events.log; error details captured

- Session ID mapping
  - Given: event contains both session_id and tinstar_term_name
  - When: event processed
  - Then: session registry updated with session mapping

- Database cleanup
  - Given: events older than retention period
  - When: cleanup job runs
  - Then: old events deleted; recent events preserved

## Definition of Done
- HTTP API endpoints implemented for all Claude hook types per reference implementation
- Event ingestion with validation, storage, and error logging functional
- Specialized extraction for TodoWrite and file operation events working
- WebSocket real-time broadcasting implemented with connection management
- SQLite schema with proper indexing and retention policies created
- Query endpoints with filtering by session, time range, term name functional
- CLI commands for event management and querying implemented
- Comprehensive error handling and failed event logging operational
- Tests cover all scenarios including edge cases and error conditions
- Integration with existing tinstar session patterns maintained
- Session ID mapping integration working correctly