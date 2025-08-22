# Tinstar Events System

The Events system captures and processes Claude Code hook activities during agent sessions, providing comprehensive event tracking, specialized processing for TodoWrite and file operations, and real-time monitoring capabilities.

## Features

- ✅ **Event Ingestion**: Capture all Claude Code hook events with validation
- ✅ **Specialized Processing**: Extract TodoWrite and file operation events into dedicated storage
- ✅ **Real-time Broadcasting**: WebSocket support for live event streaming
- ✅ **Flexible Querying**: Filter events by session, time range, terminal name, and event type
- ✅ **CLI Interface**: Rich command-line tools for event management and analysis
- ✅ **Database Storage**: SQLite backend with optimized indexing and retention policies
- ✅ **Error Handling**: Comprehensive error logging and failed event recovery

## Architecture

The system follows tinstar's layered architecture:
```
HTTP API → Service Layer → Database Layer
    ↓
WebSocket Broadcasting
    ↓  
CLI Interface
```

### Core Components

- **Models** (`models.py`): Pydantic models for events, todos, and files
- **Database** (`database.py`): SQLite operations with connection management
- **Service** (`service.py`): Event ingestion, processing, and specialized extraction
- **API** (`api.py`): FastAPI endpoints for all hook types and queries
- **WebSocket** (`websocket.py`): Real-time event broadcasting
- **CLI** (`cli.py`): Typer-based command interface

## Quick Start

### 1. Run the Example
```bash
python3.11 -m tinstar.events.example
```

### 2. Use CLI Commands
```bash
# View event statistics
python3.11 -m tinstar.events.cli stats

# List recent events
python3.11 -m tinstar.events.cli list --limit 10

# View todo events for a session
python3.11 -m tinstar.events.cli todos --session abc123

# View file operations
python3.11 -m tinstar.events.cli files --limit 5
```

### 3. Start the API Server
```bash
python3.11 -m tinstar.events.server
```

## API Endpoints

### Event Ingestion
- `POST /api/events/pre_tool_use` - PreToolUse hook events
- `POST /api/events/post_tool_use` - PostToolUse hook events  
- `POST /api/events/todowrite` - TodoWrite tool events
- `POST /api/events/notification` - Notification events
- `POST /api/events/stop` - Stop events
- `POST /api/events/subagent_stop` - SubagentStop events
- `POST /api/events/user_prompt` - UserPrompt events

### Queries
- `GET /api/events` - Query events with filtering
- `GET /api/events/todos` - Query todo events
- `GET /api/events/files` - Query file events
- `POST /api/events/clear` - Clear all events

### Real-time
- `WebSocket /api/events/ws` - Real-time event streaming

## Data Models

### Event (Base)
```python
{
  "session_id": "uuid",
  "timestamp": "2025-08-13T01:18:56.123456",
  "hook_event_name": "PreToolUse",
  "tool_name": "TodoWrite",
  "tool_input": {...},
  "tool_response": {...},
  "tinstar_term_name": "tinstar-demo"
}
```

### TodoEvent
```python
{
  ...Event fields...,
  "type": "new|update",
  "todos_from_input": [...],
  "old_todos": [...],
  "new_todos": [...]
}
```

### FileEvent
```python
{
  ...Event fields...,
  "file_path": "/path/to/file.py",
  "operation": "write|edit|multiedit",
  "lines_added": 10,
  "lines_removed": 5,
  "content_preview": "def test():"
}
```

## Database Schema

### Tables
- **events**: Raw event storage with full hook payloads
- **todos**: Specialized todo tracking with status transitions
- **files**: File operation tracking with line change statistics

### Indexes
Optimized indexes on `session_id`, `timestamp`, and `tinstar_term_name` for fast queries.

## Testing

Run the comprehensive test suite:
```bash
pytest tinstar/events/test_events.py -v
```

The tests cover:
- Model validation and serialization
- Database operations and queries
- Event processing and specialized extraction
- Service ingestion with error handling
- WebSocket functionality
- CLI command behavior

## Integration

The Events system integrates with:
- **Session Management**: Track events per session
- **WebSocket Clients**: Real-time event monitoring
- **CLI Tools**: Event analysis and management
- **Hook System**: Direct Claude Code integration

## Configuration

Events are stored in `~/.tinstar/db/events.db` with logs in `~/.tinstar/logs/failed-events.log`.

Default retention is 30 days with configurable cleanup policies.

## Performance

- Thread-safe database connections with WAL mode
- Efficient indexing for sub-second query response
- Streaming WebSocket broadcasts for real-time updates
- Minimal memory footprint with on-demand processing