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
from .models import Worktree, WorktreeCreateRequest, WorktreeDeleteRequest, Commit
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


class TestCommitFunctionality:
    """Tests for commit-related functionality."""

    def test_parse_git_log_output_empty(self, service):
        """Test parsing empty git log output."""
        result = service._parse_git_log_output("", "/fake/path")
        assert result == []

    def test_parse_git_log_output_single_commit(self, service):
        """Test parsing single commit from git log output."""
        # Mock the git commands for full hash and files changed
        with patch.object(service, '_run_git_command') as mock_git:
            mock_git.side_effect = [
                (True, "abc123def456789"),  # Full hash lookup
                (True, "file1.py\nfile2.js\n")  # Files changed
            ]
            
            git_output = "abc123|John Doe|2025-08-29 14:32:15 -0700|Add new feature"
            result = service._parse_git_log_output(git_output, "/fake/path")
            
            assert len(result) == 1
            commit = result[0]
            assert commit.hash == "abc123def456789"
            assert commit.author == "John Doe"
            assert commit.message == "Add new feature"
            assert commit.files_changed == 2
            assert commit.timestamp == "2025-08-29T14:32:15"

    def test_parse_git_log_output_multiple_commits(self, service):
        """Test parsing multiple commits from git log output."""
        with patch.object(service, '_run_git_command') as mock_git:
            # Mock responses for two commits
            mock_git.side_effect = [
                (True, "abc123def456789"), (True, "file1.py\n"),  # First commit
                (True, "def456abc789123"), (True, "file2.js\nfile3.css\nfile4.html\n")  # Second commit
            ]
            
            git_output = """abc123|John Doe|2025-08-29 14:32:15 -0700|Add new feature
def456|Jane Smith|2025-08-29 15:45:30 -0700|Fix bug in login"""
            
            result = service._parse_git_log_output(git_output, "/fake/path")
            
            assert len(result) == 2
            assert result[0].hash == "abc123def456789"
            assert result[0].author == "John Doe"
            assert result[0].files_changed == 1
            assert result[1].hash == "def456abc789123"
            assert result[1].author == "Jane Smith"
            assert result[1].files_changed == 3

    @patch('subprocess.run')
    def test_get_commits_for_worktree_success(self, mock_run, service, db):
        """Test getting commits for a worktree successfully."""
        # Setup test data
        db.create_project("test-project", "/fake/project/path", [])
        worktree = Worktree(
            name="test-worktree",
            project="test-project",
            path="/fake/worktree/path",
            branch="worktree/test-worktree",
            head="def456",
            detached=False,
            created_at=datetime.now().isoformat()
        )
        db.create_worktree(worktree)
        
        # Mock git commands
        mock_responses = [
            Mock(returncode=0, stdout="abc123\n", stderr=""),  # Project HEAD
            Mock(returncode=0, stdout="def456|Author|2025-08-29 14:32:15 -0700|Test commit\n", stderr="")  # Git log
        ]
        mock_run.side_effect = mock_responses
        
        # Mock path existence and git log parsing
        with patch('pathlib.Path.exists', return_value=True):
            with patch.object(service, '_parse_git_log_output') as mock_parse:
                mock_parse.return_value = [
                    Commit(
                        hash="def456789",
                        message="Test commit",
                        author="Author",
                        timestamp="2025-08-29T14:32:15",
                        files_changed=1
                    )
                ]
                
                result = service.get_commits_for_worktree("test-worktree", "test-project")
                
                assert len(result) == 1
                assert result[0].message == "Test commit"

    def test_get_commits_for_worktree_not_found(self, service, db):
        """Test getting commits for non-existent worktree."""
        result = service.get_commits_for_worktree("nonexistent", "test-project")
        assert result == []

    def test_get_commits_by_session_with_tinstar_term_name(self, service, db):
        """Test getting commits by tinstar_term_name."""
        # Setup test data
        db.create_project("test-project", "/fake/project/path", [])
        
        with patch.object(service, 'get_commits_for_worktree') as mock_get_commits:
            mock_get_commits.return_value = [
                Commit(
                    hash="abc123",
                    message="Test commit",
                    author="Author",
                    timestamp="2025-08-29T14:32:15",
                    files_changed=1
                )
            ]
            
            result = service.get_commits_by_session(tinstar_term_name="test-session")
            
            # Should return empty since no worktree matches the session name
            assert result == []

    def test_get_commits_by_session_no_params(self, service):
        """Test getting commits without session parameters."""
        result = service.get_commits_by_session()
        assert result == []


if __name__ == "__main__":
    pytest.main([__file__])