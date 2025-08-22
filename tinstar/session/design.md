
# Session

## Overview

Session management provides tmux-based terminal session orchestration for Claude Code agents. Each session runs in an isolated worktree with dedicated terminal environment, enabling parallel agent operations across multiple projects. The system manages session lifecycle, agent communication, and editor integration through a unified API.

## Data Contracts

### Entities

- Session
  - `id` (string, UUID)
  - `name` (string, old west themed auto-generated name)
  - `project` (string, project name from Projects module)
  - `worktree_name` (string, equals session_id)
  - `worktree_path` (string, absolute path to session worktree)
  - `tmux_session_name` (string, tmux session identifier)
  - `status` ("active" | "stopped" | "error")
  - `created_at` (ISO 8601 timestamp)
  - `last_activity` (ISO 8601 timestamp)
  - `agent_type` (string, currently only "claude")
  - `initial_prompt` (optional string, starting prompt for agent)

- Agent
  - `type` (string, agent implementation identifier - currently only "claude")
  - `config` (Dict[str, Any], agent-specific configuration)
  - `command_template` (string, shell command template for starting agent)

- Editor
  - `type` (string, editor identifier - currently only "cursor")
  - `command_template` (string, shell command template for opening files)
  - `config` (Dict[str, Any], editor-specific configuration)

- SessionPeek
  - `session_id` (string, UUID)
  - `lines` (List[string], terminal output lines)
  - `timestamp` (ISO 8601, when peek was captured)
  - `line_count` (number, total lines returned)

- NotificationType
  - `"info"` - General information message
  - `"warning"` - Warning that requires attention
  - `"error"` - Error notification
  - `"security_prompt"` - Security approval required
  - `"permission_request"` - Permission request from agent
  - `"task_completion"` - Task or operation completed
  - `"user_input_required"` - Agent waiting for user input
  - `"system_status"` - System status update

- NotificationResponse
  - `"approve_once"` - Approve this notification instance
  - `"approve_always"` - Approve this notification type always for session
  - `"deny"` - Deny/reject this notification

### API (HTTP)

- GET `/api/sessions`
  - Response: `{ "sessions": Session[] }`
  - Returns all active sessions with metadata

- POST `/api/sessions`
  - Body: `{ "project": string, "initial_prompt"?: string, "agent_type"?: string }`
  - Response: `{ "session": Session }`
  - Creates new session with auto-generated UUID and old west themed name
  - Creates worktree via Worktrees module using session_id as worktree name

- GET `/api/sessions/{session_id}`
  - Response: `{ "session": Session }`
  - Returns specific session details

- DELETE `/api/sessions/{session_id}`
  - Response: `{ "success": true }`
  - Terminates session and removes worktree via Worktrees module

- GET `/api/sessions/{session_id}/peek`
  - Query: `?lines=<number>` (default: 50, max: 1000)
  - Response: `{ "peek": SessionPeek }`
  - Returns last N lines of terminal output

- POST `/api/sessions/{session_id}/send`
  - Body: `{ "text": string }`
  - Response: `{ "success": true }`
  - Sends text input to session terminal

- POST `/api/sessions/{session_id}/editor`
  - Body: `{ "file_path": string, "line_number"?: number }`
  - Response: `{ "success": true, "command": string }`
  - Opens file in configured editor, optionally at specific line

- POST `/api/sessions/{session_id}/respond`
  - Body: `{ "response": NotificationResponse }`
  - Response: `{ "success": true, "delivered": boolean }`
  - Responds to agent notification with specified action

### CLI (Typer)

- `tinstar session list` - List all active sessions
- `tinstar session create <project_path> [--prompt TEXT] [--agent TEXT]` - Create new session
- `tinstar session peek <session_id> [--lines INT]` - View session output
- `tinstar session send <session_id> <text>` - Send text to session
- `tinstar session stop <session_id>` - Terminate session
- `tinstar session editor <session_id> <file_path> [--line INT]` - Open file in editor
- `tinstar session respond <session_id> <response>` - Respond to agent notification

## Logic

### Session Lifecycle

1. **Session Creation**
   - Generate UUID and old west themed name (e.g., "deadwood-saloon", "tombstone-ranch")
   - Create worktree via Worktrees module: `POST /worktrees` with `{project, name: session_id}`
   - Initialize tmux session with unique name in worktree directory
   - Set environment variable `TINSTAR_TERM_NAME={session_name}` for Events integration
   - Start agent process with initial prompt
   - Record session metadata in database
   - Set up terminal logging for peek functionality

2. **Session Management**
   - Track session health via tmux session status
   - Monitor agent process and restart if needed
   - Update last_activity timestamp on interactions
   - Handle session cleanup on termination

3. **Worktree Isolation**
   - Each session creates a worktree via the Worktrees module
   - Worktree name: session_id (UUID)
   - Worktree branch: `worktree/{session_id}`
   - Files copied based on project's `unignore_paths` configuration
   - Changes made in worktree don't affect main project until explicitly merged

### Agent Implementation

Currently supports Claude as the only agent implementation:

- **start_command**: Generates shell command to start Claude in worktree with initial prompt
- **respond_to_notification**: Translates notification responses to appropriate key sequences  
- **health_check**: Verifies Claude process is running and responsive

**Claude Agent**:
- Start command: `cd {worktree_path} && TINSTAR_TERM_NAME={session_name} claude '{initial_prompt}'`
- Response key sequences:
  - `approve_once`: ENTER
  - `approve_always`: DOWN, ENTER  
  - `deny`: DOWN, DOWN, ENTER

### Editor Implementation

Currently supports Cursor as the only editor implementation:

- **open_command**: Generates shell command to open file in Cursor, optionally at specific line
- **supports_line_numbers**: Cursor supports jumping to specific line numbers
- **config**: Cursor-specific configuration and command templates

**Cursor Editor**:
- Open worktree: `cursor {worktree_path}`
- Open file: `cursor {worktree_path} && cursor -a {file_path}`
- Open file at line: `cursor {worktree_path} && cursor -a {file_path}:{line_number}`

### Terminal Management

- Use tmux for session persistence and logging
- Session naming: `tinstar-{session_id}`
- Capture terminal output to log file for peek functionality
- Handle tmux session cleanup on termination
- Support sending keyboard input and commands

### Notification Response System

The notification response system handles structured responses to agent prompts and notifications:

1. **Response Types**: Three standard responses based on termbridge reference implementation
   - `approve_once`: Accept this notification instance only
   - `approve_always`: Accept this notification type for the entire session
   - `deny`: Reject this notification

2. **Security Integration**: Handle security prompts for worktree access
3. **Session Policies**: Track approve_always decisions for consistent behavior

**Response Processing Flow**:
1. API receives notification response from user or automation
2. Agent-specific response handler translates to appropriate key sequences
3. Key sequences sent to tmux session via send-keys
4. Response delivery tracked and logged
5. Session policies updated if approve_always selected

**Integration with Events System**:
- Session sets `TINSTAR_TERM_NAME={session_name}` environment variable
- All Claude Code events automatically tagged with session name for tracking
- Notification responses logged to events database with session context
- Policy changes tracked for audit purposes
- Failed response delivery logged with error details

### Storage

- SQLite database: `~/.tinstar/db/tinstar.db` (shared with Projects, Events, Worktrees modules)
- Tables:
  - `sessions` (id, name, project, worktree_name, worktree_path, tmux_session_name, status, created_at, last_activity, agent_type, initial_prompt)
  - `session_logs` (session_id, timestamp, log_line, line_number)
- Worktree directories: `~/.tinstar/worktrees/{session_id}/` (managed by Worktrees module)
- Terminal logs: `~/.tinstar/logs/{session_id}.log`

### Configuration

```json
{
  "agents": {
    "claude": {
      "command_template": "cd {worktree_path} && claude-code --session-prompt '{initial_prompt}'",
      "health_check_interval": 30
    }
  },
  "editors": {
    "cursor": {
      "command_template": "cursor {worktree_path} && cursor -a {file_path}:{line_number}",
      "supports_line_numbers": true
    }
  },
  "agent": "claude",
  "editor": "cursor",
  "session_timeout_hours": 24,
  "max_peek_lines": 1000
}
```

### Validation Rules

- Session names must be unique across active sessions
- Project paths must exist and be readable
- File paths for editor opening must be relative to worktree
- Line numbers must be positive integers
- Session IDs must be valid UUIDs
- Peek line counts must be between 1 and configured maximum
- Agent types must be configured in settings
- Editor types must be configured in settings

## Tests

- Create session
  - Given: valid project path and optional prompt
  - When: POST `/api/sessions`
  - Then: session created with UUID, old west name; worktree initialized; tmux session started; agent process running

- Session isolation
  - Given: multiple sessions for same project
  - When: sessions created simultaneously
  - Then: each gets separate worktree; changes in one don't affect others

- Peek terminal output
  - Given: active session with terminal activity
  - When: GET `/api/sessions/{id}/peek?lines=10`
  - Then: returns last 10 lines of terminal output with timestamps

- Send text to session
  - Given: active session
  - When: POST `/api/sessions/{id}/send` with `{"text": "ls -la"}`
  - Then: command executed in session terminal; output captured for peek

- Send notification with auto-approval
  - Given: active session with pending security prompt
  - When: POST `/api/sessions/{id}/notify` with `{"message": "Approve worktree access", "type": "security_prompt", "action": "auto_approve"}`
  - Then: ENTER key sent to session; security prompt approved; response logged

- Send notification with custom action
  - Given: active session waiting for input
  - When: POST `/api/sessions/{id}/notify` with `{"message": "DOWN ENTER", "type": "user_input_required", "action": "send_keys"}`
  - Then: DOWN then ENTER keys sent; session proceeds; action logged

- Open file in editor
  - Given: active session and valid file path
  - When: POST `/api/sessions/{id}/editor` with file path
  - Then: editor command executed; file opened in new window

- Session termination
  - Given: active session
  - When: DELETE `/api/sessions/{id}`
  - Then: tmux session killed; worktree removed via Worktrees module; database updated

- Agent health monitoring
  - Given: session with stopped agent process
  - When: health check runs
  - Then: agent restarted; session status updated

- Old west naming
  - Given: multiple session creation requests
  - When: sessions created
  - Then: each gets unique old west themed name (deadwood-saloon, tombstone-ranch, etc.)

- Configuration loading
  - Given: custom agent and editor configurations
  - When: session uses non-default types
  - Then: correct command templates applied; custom config respected

- Session persistence
  - Given: tmux session restart
  - When: tinstar service restarts
  - Then: existing sessions detected and tracked; state synchronized

- Invalid operations
  - Given: non-existent session ID
  - When: any session operation attempted
  - Then: returns 404 with appropriate error message

- Concurrent access
  - Given: multiple clients accessing same session
  - When: simultaneous peek and send operations
  - Then: operations complete without conflicts; consistent state maintained

- Notification delivery tracking
  - Given: session with agent that may be unresponsive
  - When: notification sent with action
  - Then: delivery status tracked; timeout handled gracefully; failure logged

- Security policy enforcement
  - Given: session with auto_approve_always policy for security prompts
  - When: new security prompt appears
  - Then: automatically approved without user intervention; policy logged

## Definition of Done

- Session creation with worktree isolation and tmux management implemented
- Agent implementation with Claude support functional
- Editor implementation with Cursor support working
- HTTP API endpoints for all session operations implemented
- Terminal output capturing and peek functionality operational
- Session persistence and health monitoring implemented
- Old west themed session naming system functional
- Configuration system for agents and editors implemented
- Comprehensive error handling and validation implemented
- CLI commands for session management implemented
- Notification response system with typed messages and automated actions implemented
- Security prompt handling with policy enforcement implemented
- Notification delivery tracking and error logging implemented
- Integration with Projects module for project management working
- Integration with Worktrees module for isolation working
- Integration with Events module via TINSTAR_TERM_NAME tagging working
- Database schema added to shared tinstar.db initialization
- Tests cover all scenarios including concurrent access and error conditions
- Session cleanup and resource management working correctly  