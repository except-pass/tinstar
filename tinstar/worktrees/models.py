"""
Worktree models for the Tinstar worktrees system.
"""
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator
import re


class Worktree(BaseModel):
    """Worktree entity model."""
    name: str = Field(..., description="Unique worktree name per project")
    project: str = Field(..., description="Project name from Projects module")
    path: str = Field(..., description="Absolute path to worktree directory")
    branch: str = Field(..., description="Git branch name, format: worktree/{name}")
    head: Optional[str] = Field(None, description="Current commit SHA")
    detached: bool = Field(False, description="True if HEAD is detached")
    created_at: str = Field(..., description="ISO 8601 timestamp")

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        """Validate worktree name for directory and git branch compatibility."""
        if not re.match(r'^[a-zA-Z0-9_-]+$', v):
            raise ValueError('Worktree name must contain only alphanumeric characters, hyphens, and underscores')
        if len(v) < 1 or len(v) > 100:
            raise ValueError('Worktree name must be between 1 and 100 characters')
        return v

    @field_validator('created_at')
    @classmethod
    def validate_timestamp(cls, v):
        try:
            datetime.fromisoformat(v.replace('Z', '+00:00'))
            return v
        except ValueError:
            raise ValueError('created_at must be valid ISO 8601 format')


class WorktreeCreateRequest(BaseModel):
    """Request model for creating a new worktree."""
    project: str = Field(..., description="Project name")
    name: str = Field(..., description="Worktree name")

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        if not re.match(r'^[a-zA-Z0-9_-]+$', v):
            raise ValueError('Worktree name must contain only alphanumeric characters, hyphens, and underscores')
        if len(v) < 1 or len(v) > 100:
            raise ValueError('Worktree name must be between 1 and 100 characters')
        return v


class WorktreeResponse(BaseModel):
    """Standard response for worktree operations."""
    success: bool
    message: Optional[str] = None
    worktree: Optional[Worktree] = None
    worktrees: Optional[List[Worktree]] = None


class WorktreeDeleteRequest(BaseModel):
    """Request model for deleting a worktree."""
    project: str = Field(..., description="Project name")
    name: str = Field(..., description="Worktree name")
    force: bool = Field(False, description="Force deletion even with uncommitted changes")


class WorktreeListRequest(BaseModel):
    """Request model for listing worktrees."""
    project: str = Field(..., description="Project name to filter by")


class Commit(BaseModel):
    """Git commit model for timeline integration."""
    hash: str = Field(..., description="Full commit SHA")
    message: str = Field(..., description="Commit message")
    author: str = Field(..., description="Commit author name")
    timestamp: str = Field(..., description="ISO 8601 commit timestamp")
    files_changed: int = Field(..., description="Number of files changed in commit")


class CommitResponse(BaseModel):
    """Response model for commit queries."""
    success: bool
    commits: List[Commit] = Field(default_factory=list)
    message: Optional[str] = None