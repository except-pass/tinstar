"""
Project models for the Tinstar projects system.
"""
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator
from pathlib import Path


class Project(BaseModel):
    """Project entity representing a local git repository."""
    name: str = Field(..., description="Unique project name (slug-safe)")
    path: str = Field(..., description="Absolute path to project directory")
    created_at: str = Field(..., description="ISO 8601 timestamp")
    default_branch: Optional[str] = Field(None, description="Default git branch")
    unignore_paths: List[str] = Field(default_factory=list, description="Relative paths to copy to worktrees")

    @field_validator('name')
    @classmethod
    def validate_name(cls, v):
        if not v or len(v) == 0:
            raise ValueError('name cannot be empty')
        # Slug-safe validation: alphanumeric, hyphens, underscores
        if not all(c.isalnum() or c in '-_' for c in v):
            raise ValueError('name must be slug-safe (alphanumeric, hyphens, underscores only)')
        return v

    @field_validator('path')
    @classmethod
    def validate_path(cls, v):
        if not v:
            raise ValueError('path cannot be empty')
        if not Path(v).is_absolute():
            raise ValueError('path must be absolute')
        return v

    @field_validator('created_at')
    @classmethod
    def validate_created_at(cls, v):
        try:
            datetime.fromisoformat(v.replace('Z', '+00:00'))
            return v
        except ValueError:
            raise ValueError('created_at must be valid ISO 8601 format')

    @field_validator('unignore_paths')
    @classmethod
    def validate_unignore_paths(cls, v):
        if not isinstance(v, list):
            raise ValueError('unignore_paths must be a list')
        
        for path_str in v:
            if not isinstance(path_str, str):
                raise ValueError('unignore_paths entries must be strings')
            
            # Must be relative
            if Path(path_str).is_absolute():
                raise ValueError(f'unignore_paths entry "{path_str}" must be relative')
            
            # Check for path traversal after normalization
            normalized = Path(path_str).as_posix()
            if normalized.startswith('../') or '/../' in normalized or normalized == '..':
                raise ValueError(f'unignore_paths entry "{path_str}" cannot escape project root')
        
        return v


class CreateProjectRequest(BaseModel):
    """Request model for creating a new project."""
    path: str = Field(..., description="Absolute path to project directory")
    name: Optional[str] = Field(None, description="Project name (derived from path if omitted)")
    unignore_paths: List[str] = Field(default_factory=list, description="Paths to copy to worktrees")


class UpdateProjectRequest(BaseModel):
    """Request model for updating project settings."""
    unignore_paths: Optional[List[str]] = Field(None, description="Update unignore paths")


class ProjectResponse(BaseModel):
    """Standard response wrapper for project operations."""
    success: bool = True
    message: Optional[str] = None
    project: Optional[Project] = None
    projects: Optional[List[Project]] = None