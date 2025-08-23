"""
Projects service with validation and business logic.
"""
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from .database import ProjectsDatabase
from .models import Project, CreateProjectRequest, UpdateProjectRequest


class ProjectValidationError(Exception):
    """Exception raised when project validation fails."""
    pass


class ProjectService:
    """Service for managing projects with validation and business logic."""
    
    def __init__(self, database: Optional[ProjectsDatabase] = None):
        self.database = database or ProjectsDatabase()
    
    def list_projects(self) -> List[Project]:
        """List all projects ordered by created_at."""
        return self.database.list_projects()
    
    def get_project(self, name: str) -> Optional[Project]:
        """Get a project by name."""
        return self.database.get_project(name)
    
    def create_project(self, request: CreateProjectRequest) -> Project:
        """Create a new project with validation."""
        # Normalize and validate path
        path = self._validate_and_normalize_path(request.path)
        
        # Validate git repository
        self._validate_git_repository(path)
        
        # Generate name if not provided
        name = request.name
        if not name:
            name = self._derive_name_from_path(path)
        
        # Validate name is unique
        if self.database.project_exists_by_name(name):
            raise ProjectValidationError(f"Project name '{name}' already exists")
        
        # Validate path is unique
        if self.database.project_exists_by_path(path):
            raise ProjectValidationError(f"Project path '{path}' is already registered")
        
        # Validate unignore paths
        validated_unignore_paths = self._validate_unignore_paths(request.unignore_paths)
        
        # Detect default branch
        default_branch = self._detect_default_branch(path)
        
        # Create project
        project = Project(
            name=name,
            path=path,
            created_at=datetime.now().isoformat(),
            default_branch=default_branch,
            unignore_paths=validated_unignore_paths
        )
        
        return self.database.create_project(project)
    
    def update_project(self, name: str, request: UpdateProjectRequest) -> Optional[Project]:
        """Update a project's settings."""
        # Check if project exists
        existing = self.database.get_project(name)
        if not existing:
            return None
        
        updates = {}
        
        # Validate and update unignore paths if provided
        if request.unignore_paths is not None:
            updates['unignore_paths'] = self._validate_unignore_paths(request.unignore_paths)
        
        return self.database.update_project(name, updates)
    
    def delete_project(self, name: str) -> bool:
        """Delete a project by name."""
        return self.database.delete_project(name)
    
    def copy_unignore_paths(self, project_name: str, destination_path: Path) -> None:
        """Copy unignore_paths from project to destination directory."""
        project = self.database.get_project(project_name)
        if not project:
            raise ValueError(f"Project '{project_name}' not found")
        
        project_path = Path(project.path)
        
        for rel_path_str in project.unignore_paths:
            source_path = project_path / rel_path_str
            dest_path = destination_path / rel_path_str
            
            try:
                if source_path.is_file():
                    # Copy file with metadata
                    dest_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_path, dest_path)
                elif source_path.is_dir():
                    # Copy directory recursively
                    dest_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(source_path, dest_path, dirs_exist_ok=True)
                # Missing entries are skipped silently as per design
            except (OSError, PermissionError) as e:
                # Log error but continue with other paths
                print(f"Warning: Failed to copy {rel_path_str}: {e}")
    
    def _validate_and_normalize_path(self, path_str: str) -> str:
        """Validate and normalize a project path."""
        if not path_str:
            raise ProjectValidationError("path cannot be empty")
        
        path = Path(path_str)
        
        # Must be absolute
        if not path.is_absolute():
            raise ProjectValidationError("path must be absolute")
        
        # Must exist
        if not path.exists():
            raise ProjectValidationError(f"path does not exist: {path_str}")
        
        # Must be a directory
        if not path.is_dir():
            raise ProjectValidationError(f"path is not a directory: {path_str}")
        
        # Resolve symlinks and normalize
        try:
            normalized = str(path.resolve())
        except (OSError, RuntimeError) as e:
            raise ProjectValidationError(f"failed to normalize path: {e}")
        
        return normalized
    
    def _validate_git_repository(self, path: str) -> None:
        """Validate that path contains a valid git repository."""
        path_obj = Path(path)
        
        # Check for .git directory
        git_dir = path_obj / ".git"
        if not git_dir.exists():
            raise ProjectValidationError("not a git repository (no .git directory)")
        
        try:
            # Test git repository validity
            result = subprocess.run(
                ['git', 'rev-parse', '--git-common-dir'],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode != 0:
                raise ProjectValidationError("not a valid git repository")
            
            # Ensure it's not a bare repository
            result = subprocess.run(
                ['git', 'rev-parse', '--is-bare-repository'],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0 and result.stdout.strip() == 'true':
                raise ProjectValidationError("bare repositories are not supported")
            
            # Verify git-dir matches git-common-dir (not a worktree)
            result_common = subprocess.run(
                ['git', 'rev-parse', '--git-common-dir'],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=10
            )
            result_git = subprocess.run(
                ['git', 'rev-parse', '--git-dir'],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if (result_common.returncode == 0 and result_git.returncode == 0):
                common_dir = result_common.stdout.strip()
                git_dir = result_git.stdout.strip()
                if common_dir != git_dir:
                    raise ProjectValidationError("path appears to be a git worktree, not a main repository")
        
        except subprocess.TimeoutExpired:
            raise ProjectValidationError("git command timed out")
        except (subprocess.CalledProcessError, OSError) as e:
            raise ProjectValidationError(f"git validation failed: {e}")
    
    def _derive_name_from_path(self, path: str) -> str:
        """Derive project name from path (last segment)."""
        name = Path(path).name
        # Make it slug-safe
        name = ''.join(c if c.isalnum() or c in '-_' else '_' for c in name)
        if not name:
            name = "project"
        
        # Ensure uniqueness by appending number if needed
        base_name = name
        counter = 1
        while self.database.project_exists_by_name(name):
            name = f"{base_name}_{counter}"
            counter += 1
        
        return name
    
    def _validate_unignore_paths(self, paths: List[str]) -> List[str]:
        """Validate unignore_paths entries."""
        if not isinstance(paths, list):
            raise ProjectValidationError("unignore_paths must be a list")
        
        validated = []
        for path_str in paths:
            if not isinstance(path_str, str):
                raise ProjectValidationError("unignore_paths entries must be strings")
            
            # Must be relative
            path = Path(path_str)
            if path.is_absolute():
                raise ProjectValidationError(f"unignore_paths entry '{path_str}' must be relative")
            
            # Check for path traversal after normalization
            try:
                normalized = path.as_posix()
                if normalized.startswith('../') or '/../' in normalized or normalized == '..':
                    raise ProjectValidationError(f"unignore_paths entry '{path_str}' cannot escape project root")
            except (OSError, ValueError):
                raise ProjectValidationError(f"unignore_paths entry '{path_str}' is invalid")
            
            validated.append(normalized)
        
        return validated
    
    def _detect_default_branch(self, path: str) -> Optional[str]:
        """Detect the default branch of the git repository."""
        try:
            # Try to get the default branch from origin/HEAD
            result = subprocess.run(
                ['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0:
                # Extract branch name from refs/remotes/origin/branch_name
                ref = result.stdout.strip()
                if ref.startswith('refs/remotes/origin/'):
                    return ref[len('refs/remotes/origin/'):]
            
            # Fallback: try to get current branch
            result = subprocess.run(
                ['git', 'branch', '--show-current'],
                cwd=path,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
            
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
            pass
        
        # Unable to determine default branch
        return None