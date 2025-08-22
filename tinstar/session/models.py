"""
Session models for the Tinstar session management system.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional
from enum import Enum
from pydantic import BaseModel, Field, field_validator
import uuid
import re


class Session(BaseModel):
    """Session entity model."""
    id: str = Field(..., description="UUID session identifier")
    name: str = Field(..., description="Old west themed auto-generated name")
    project: str = Field(..., description="Project name from Projects module")
    worktree_name: str = Field(..., description="Worktree name, equals session_id")
    worktree_path: str = Field(..., description="Absolute path to session worktree")
    tmux_session_name: str = Field(..., description="Tmux session identifier")
    status: str = Field(..., pattern="^(active|stopped|error)$")
    created_at: str = Field(..., description="ISO 8601 timestamp")
    last_activity: str = Field(..., description="ISO 8601 timestamp")
    agent_type: str = Field(default="claude", description="Agent implementation identifier")
    initial_prompt: Optional[str] = Field(None, description="Starting prompt for agent")

    @field_validator('id')
    @classmethod
    def validate_id(cls, v):
        try:
            uuid.UUID(v)
            return v
        except ValueError:
            raise ValueError('id must be a valid UUID')

    @field_validator('created_at', 'last_activity')
    @classmethod
    def validate_timestamp(cls, v):
        try:
            datetime.fromisoformat(v.replace('Z', '+00:00'))
            return v
        except ValueError:
            raise ValueError('timestamp must be valid ISO 8601 format')

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        if not re.match(r'^[a-zA-Z0-9_-]+$', v):
            raise ValueError('Session name must contain only alphanumeric characters, hyphens, and underscores')
        return v


class Agent(BaseModel):
    """Agent configuration model."""
    type: str = Field(..., description="Agent implementation identifier")
    config: Dict[str, Any] = Field(default_factory=dict, description="Agent-specific configuration")
    command_template: str = Field(..., description="Shell command template for starting agent")


class Editor(BaseModel):
    """Editor configuration model."""
    type: str = Field(..., description="Editor identifier")
    command_template: str = Field(..., description="Shell command template for opening files")
    config: Dict[str, Any] = Field(default_factory=dict, description="Editor-specific configuration")


class SessionPeek(BaseModel):
    """Session terminal output peek model."""
    session_id: str = Field(..., description="UUID session identifier")
    lines: List[str] = Field(..., description="Terminal output lines")
    timestamp: str = Field(..., description="ISO 8601 timestamp when peek was captured")
    line_count: int = Field(..., description="Total lines returned")

    @field_validator('session_id')
    @classmethod
    def validate_session_id(cls, v):
        try:
            uuid.UUID(v)
            return v
        except ValueError:
            raise ValueError('session_id must be a valid UUID')


class NotificationType(str, Enum):
    """Notification type enumeration."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    SECURITY_PROMPT = "security_prompt"
    PERMISSION_REQUEST = "permission_request"
    TASK_COMPLETION = "task_completion"
    USER_INPUT_REQUIRED = "user_input_required"
    SYSTEM_STATUS = "system_status"


class NotificationResponse(str, Enum):
    """Notification response enumeration."""
    APPROVE_ONCE = "approve_once"
    APPROVE_ALWAYS = "approve_always"
    DENY = "deny"


class SessionCreateRequest(BaseModel):
    """Request model for creating a new session."""
    project: str = Field(..., description="Project name")
    initial_prompt: Optional[str] = Field(None, description="Starting prompt for agent")
    agent_type: Optional[str] = Field("claude", description="Agent type to use")


class SessionResponse(BaseModel):
    """Standard response for session operations."""
    success: bool
    message: Optional[str] = None
    session: Optional[Session] = None
    sessions: Optional[List[Session]] = None


class SessionPeekRequest(BaseModel):
    """Request model for session peek."""
    lines: int = Field(default=50, ge=1, le=1000, description="Number of lines to return")


class SessionSendRequest(BaseModel):
    """Request model for sending text to session."""
    text: str = Field(..., description="Text to send to session terminal")


class SessionEditorRequest(BaseModel):
    """Request model for opening file in editor."""
    file_path: str = Field(..., description="File path to open")
    line_number: Optional[int] = Field(None, ge=1, description="Line number to jump to")


class SessionRespondRequest(BaseModel):
    """Request model for responding to notifications."""
    response: str = Field(..., pattern="^(approve_once|approve_always|deny)$")