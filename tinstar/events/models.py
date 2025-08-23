"""
Event models for the Tinstar events system.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field, field_validator
import uuid


class Todo(BaseModel):
    """Todo item within a todo list."""
    id: Optional[str] = None
    content: str
    status: str = Field(..., pattern="^(pending|in_progress|completed)$")
    priority: Optional[str] = Field(None, pattern="^(high|medium|low)$")
    
    def __init__(self, **data):
        # Auto-generate ID if not provided
        if 'id' not in data or data['id'] is None:
            data['id'] = str(uuid.uuid4())[:8]  # Short UUID for readability
        super().__init__(**data)


class Event(BaseModel):
    """Base event model for all Claude Code hook events."""
    session_id: str = Field(..., description="UUID from Claude session")
    timestamp: str = Field(..., description="ISO 8601 timestamp")
    hook_event_name: str = Field(..., description="Hook event type")
    transcript_path: Optional[str] = None
    tinstar_term_name: Optional[str] = None
    tool_name: Optional[str] = None
    tool_input: Optional[Dict[str, Any]] = None
    tool_response: Optional[Any] = None
    message: Optional[str] = None

    @field_validator('session_id')
    @classmethod
    def validate_session_id(cls, v):
        try:
            uuid.UUID(v)
            return v
        except ValueError:
            raise ValueError('session_id must be a valid UUID')

    @field_validator('timestamp')
    @classmethod
    def validate_timestamp(cls, v):
        try:
            datetime.fromisoformat(v.replace('Z', '+00:00'))
            return v
        except ValueError:
            raise ValueError('timestamp must be valid ISO 8601 format')

    @field_validator('hook_event_name')
    @classmethod
    def validate_hook_event_name(cls, v):
        allowed_events = {
            'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 
            'UserPrompt', 'UserPromptSubmit', 'Notification'
        }
        if v not in allowed_events:
            raise ValueError(f'hook_event_name must be one of: {allowed_events}')
        return v


class TodoEvent(Event):
    """Specialized event for TodoWrite tool usage."""
    type: str = Field(..., pattern="^(new|update)$")
    
    @property
    def todos_from_input(self) -> List[Todo]:
        """Extract todos from tool_input."""
        if not self.tool_input or 'todos' not in self.tool_input:
            return []
        return [Todo(**todo) for todo in self.tool_input['todos']]
    
    @property
    def old_todos(self) -> List[Todo]:
        """Extract old todos from tool_response (PostToolUse only)."""
        if not self.tool_response or 'oldTodos' not in self.tool_response:
            return []
        return [Todo(**todo) for todo in self.tool_response['oldTodos']]
    
    @property
    def new_todos(self) -> List[Todo]:
        """Extract new todos from tool_response (PostToolUse only)."""
        if not self.tool_response or 'newTodos' not in self.tool_response:
            return []
        return [Todo(**todo) for todo in self.tool_response['newTodos']]


class FileEvent(Event):
    """Specialized event for file operations."""
    file_path: str
    operation: str = Field(..., pattern="^(write|edit|multiedit)$")
    lines_added: Optional[int] = None
    lines_removed: Optional[int] = None
    content_preview: Optional[str] = None

    @field_validator('content_preview')
    @classmethod
    def validate_content_preview(cls, v):
        if v and len(v) > 200:
            return v[:200]
        return v


class EventFilter(BaseModel):
    """Filter parameters for event queries."""
    session_id: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    tinstar_term_name: Optional[str] = None
    event_type: Optional[str] = None

    @field_validator('start_time', 'end_time')
    @classmethod
    def validate_time_format(cls, v):
        if v:
            try:
                datetime.fromisoformat(v.replace('Z', '+00:00'))
                return v
            except ValueError:
                raise ValueError('time must be valid ISO 8601 format')
        return v


class EventResponse(BaseModel):
    """Standard response for event operations."""
    success: bool
    message: Optional[str] = None


class WebSocketMessage(BaseModel):
    """WebSocket message format for real-time event broadcasting."""
    type: str
    data: Union[Event, TodoEvent, FileEvent]