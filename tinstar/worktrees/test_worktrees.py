"""
Tests for the Tinstar worktrees system.
"""
import os
import tempfile
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from .database import WorktreeDatabase
from .models import Worktree, WorktreeCreateRequest, WorktreeDeleteRequest
from .service import WorktreeService


@pytest.fixture
def temp_dir():
    """Create a temporary directory for tests."""
    temp_dir = tempfile.mkdtemp()
    yield Path(temp_dir)
    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.fixture
def db(temp_dir):
    """Create a test database."""
    db_path = temp_dir / "test.db"
    return WorktreeDatabase(db_path)


@pytest.fixture
def service(db, temp_dir):
    """Create a test service with mocked base directory."""
    service = WorktreeService(db)
    service.base_dir = temp_dir / "worktrees"
    service.base_dir.mkdir(exist_ok=True)
    return service


@pytest.fixture
def git_repo(temp_dir):
    """Create a test git repository."""
    repo_path = temp_dir / "test-repo"
    repo_path.mkdir()
    
    # Initialize git repo
    subprocess.run(["git", "init"], cwd=repo_path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo_path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo_path, check=True)
    
    # Create initial commit
    (repo_path / "README.md").write_text("# Test Project")
    subprocess.run(["git", "add", "README.md"], cwd=repo_path, check=True)
    subprocess.run(["git", "commit", "-m", "Initial commit"], cwd=repo_path, check=True)
    
    return repo_path


class TestWorktreeDatabase:
    """Test the worktree database operations."""
    
    def test_init_database(self, db):
        """Test database initialization."""
        with db.get_connection() as conn:
            # Check if tables exist
            cursor = conn.execute("""
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name IN ('worktrees', 'projects')
            """)
            tables = [row[0] for row in cursor.fetchall()]
            assert 'worktrees' in tables
            assert 'projects' in tables
    
    def test_create_and_get_worktree(self, db):
        """Test creating and retrieving a worktree."""
        # Setup test project
        with db.get_connection() as conn:
            conn.execute("""
                INSERT INTO projects (name, path, unignore_paths)
                VALUES (?, ?, ?)
            """, ("test-project", "/path/to/project", "[]"))
        
        worktree = Worktree(
            name="test-worktree",
            project="test-project",
            path="/path/to/worktree",
            branch="worktree/test-worktree",
            head="abc123",
            detached=False,
            created_at=datetime.now().isoformat()
        )
        
        db.create_worktree(worktree)
        retrieved = db.get_worktree("test-worktree", "test-project")
        
        assert retrieved is not None
        assert retrieved.name == worktree.name
        assert retrieved.project == worktree.project
        assert retrieved.path == worktree.path
        assert retrieved.branch == worktree.branch
    
    def test_list_worktrees(self, db):
        """Test listing worktrees for a project."""
        # Setup test project
        with db.get_connection() as conn:
            conn.execute("""
                INSERT INTO projects (name, path, unignore_paths)
                VALUES (?, ?, ?)
            """, ("test-project", "/path/to/project", "[]"))
        
        # Create multiple worktrees
        for i in range(3):
            worktree = Worktree(
                name=f"worktree-{i}",
                project="test-project",
                path=f"/path/to/worktree-{i}",
                branch=f"worktree/worktree-{i}",
                head=f"abc{i}23",
                detached=False,
                created_at=datetime.now().isoformat()
            )
            db.create_worktree(worktree)
        
        worktrees = db.list_worktrees("test-project")
        assert len(worktrees) == 3
        assert all(w.project == "test-project" for w in worktrees)
    
    def test_delete_worktree(self, db):
        """Test deleting a worktree."""
        # Setup test project
        with db.get_connection() as conn:
            conn.execute("""
                INSERT INTO projects (name, path, unignore_paths)
                VALUES (?, ?, ?)
            """, ("test-project", "/path/to/project", "[]"))
        
        worktree = Worktree(
            name="test-worktree",
            project="test-project",
            path="/path/to/worktree",
            branch="worktree/test-worktree",
            head="abc123",
            detached=False,
            created_at=datetime.now().isoformat()
        )
        
        db.create_worktree(worktree)
        assert db.get_worktree("test-worktree", "test-project") is not None
        
        deleted = db.delete_worktree("test-worktree", "test-project")
        assert deleted is True
        assert db.get_worktree("test-worktree", "test-project") is None


class TestWorktreeService:
    """Test the worktree service operations."""
    
    def test_list_empty(self, service, db):
        """Test listing when no worktrees exist."""
        # Setup test project
        with db.get_connection() as conn:
            conn.execute("""
                INSERT INTO projects (name, path, unignore_paths)
                VALUES (?, ?, ?)
            """, ("test-project", "/path/to/project", "[]"))
        
        worktrees = service.list_worktrees("test-project")
        assert worktrees == []
    
    def test_list_nonexistent_project(self, service):
        """Test listing worktrees for non-existent project."""
        with pytest.raises(ValueError, match="Project not found"):
            service.list_worktrees("nonexistent")
    
    @patch('subprocess.run')
    def test_get_current_branch(self, mock_run, service):
        """Test getting current branch."""
        # Mock successful git branch --show-current
        mock_run.return_value = Mock(returncode=0, stdout="main\n", stderr="")
        
        branch = service._get_current_branch("/path/to/repo")
        assert branch == "main"
        
        # Mock failure, fallback to symbolic-ref
        mock_run.side_effect = [
            Mock(returncode=1, stdout="", stderr="not a git repository"),
            Mock(returncode=0, stdout="refs/heads/develop\n", stderr="")
        ]
        
        branch = service._get_current_branch("/path/to/repo")
        assert branch == "develop"
    
    def test_create_worktree_validation_errors(self, service):
        """Test worktree creation validation errors."""
        # Non-existent project
        request = WorktreeCreateRequest(project="nonexistent", name="test")
        with pytest.raises(ValueError, match="Project not found"):
            service.create_worktree(request)
    
    @patch('subprocess.run')
    def test_create_worktree_detached_head(self, mock_run, service, db):
        """Test worktree creation from detached HEAD."""
        # Setup test project
        with db.get_connection() as conn:
            conn.execute("""
                INSERT INTO projects (name, path, unignore_paths)
                VALUES (?, ?, ?)
            """, ("test-project", "/path/to/project", "[]"))
        
        # Mock detached HEAD scenario
        mock_run.side_effect = [
            Mock(returncode=1, stdout="", stderr=""),  # git branch --show-current fails
            Mock(returncode=1, stdout="", stderr="")   # git symbolic-ref HEAD fails
        ]
        
        request = WorktreeCreateRequest(project="test-project", name="test")
        with pytest.raises(ValueError, match="Cannot create worktree from detached HEAD"):
            service.create_worktree(request)
    
    def test_delete_nonexistent_worktree(self, service, db):
        """Test deleting non-existent worktree."""
        # Setup test project
        with db.get_connection() as conn:
            conn.execute("""
                INSERT INTO projects (name, path, unignore_paths)
                VALUES (?, ?, ?)
            """, ("test-project", "/path/to/project", "[]"))
        
        request = WorktreeDeleteRequest(project="test-project", name="nonexistent")
        with pytest.raises(ValueError, match="Worktree not found"):
            service.delete_worktree(request)
    
    @patch('subprocess.run')
    def test_delete_with_uncommitted_changes(self, mock_run, service, db, temp_dir):
        """Test deleting worktree with uncommitted changes."""
        # Setup test project and worktree
        with db.get_connection() as conn:
            conn.execute("""
                INSERT INTO projects (name, path, unignore_paths)
                VALUES (?, ?, ?)
            """, ("test-project", "/path/to/project", "[]"))
        
        worktree_path = temp_dir / "worktrees" / "test"
        worktree_path.mkdir(parents=True)
        
        worktree = Worktree(
            name="test",
            project="test-project",
            path=str(worktree_path),
            branch="worktree/test",
            head="abc123",
            detached=False,
            created_at=datetime.now().isoformat()
        )
        db.create_worktree(worktree)
        
        # Mock git status showing changes
        mock_run.return_value = Mock(returncode=0, stdout="M  file.txt\n", stderr="")
        
        request = WorktreeDeleteRequest(project="test-project", name="test", force=False)
        with pytest.raises(ValueError, match="uncommitted changes"):
            service.delete_worktree(request)


if __name__ == "__main__":
    pytest.main([__file__])