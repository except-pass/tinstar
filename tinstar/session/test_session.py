"""
Basic tests for the Tinstar session management system.
"""
import pytest
import asyncio
import tempfile
import shutil
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from .database import SessionDatabase
from .service import SessionService
from .models import Session, SessionCreateRequest
from .config import SessionConfig


class TestSessionDatabase:
    """Test session database operations."""
    
    def setup_method(self):
        """Set up test database."""
        self.temp_dir = Path(tempfile.mkdtemp())
        self.db_path = self.temp_dir / "test.db"
        self.db = SessionDatabase(self.db_path)
    
    def teardown_method(self):
        """Clean up test database."""
        self.db.close()
        shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def test_create_session(self):
        """Test creating a session."""
        session_id = str(uuid.uuid4())
        session = Session(
            id=session_id,
            name="test-saloon",
            project="test-project",
            worktree_name=session_id,
            worktree_path="/tmp/test-worktree",
            tmux_session_name=f"tinstar-{session_id}",
            status="active",
            created_at="2023-01-01T00:00:00",
            last_activity="2023-01-01T00:00:00",
            agent_type="claude"
        )
        
        result_id = self.db.create_session(session)
        assert result_id == session.id
        
        # Retrieve and verify
        retrieved = self.db.get_session(session.id)
        assert retrieved is not None
        assert retrieved.name == session.name
        assert retrieved.project == session.project
    
    def test_list_sessions(self):
        """Test listing sessions."""
        # Create multiple sessions
        sessions = []
        for i in range(3):
            session_id = str(uuid.uuid4())
            session = Session(
                id=session_id,
                name=f"test-saloon-{i}",
                project="test-project",
                worktree_name=session_id,
                worktree_path=f"/tmp/test-worktree-{i}",
                tmux_session_name=f"tinstar-{session_id}",
                status="active",
                created_at="2023-01-01T00:00:00",
                last_activity="2023-01-01T00:00:00",
                agent_type="claude"
            )
            sessions.append(session)
            self.db.create_session(session)
        
        # List all sessions
        all_sessions = self.db.list_sessions()
        assert len(all_sessions) == 3
        
        # List by project
        project_sessions = self.db.list_sessions(project="test-project")
        assert len(project_sessions) == 3
        
        # List by non-existent project
        empty_sessions = self.db.list_sessions(project="non-existent")
        assert len(empty_sessions) == 0
    
    def test_update_session_status(self):
        """Test updating session status."""
        session_id = str(uuid.uuid4())
        session = Session(
            id=session_id,
            name="test-saloon",
            project="test-project",
            worktree_name=session_id,
            worktree_path="/tmp/test-worktree",
            tmux_session_name=f"tinstar-{session_id}",
            status="active",
            created_at="2023-01-01T00:00:00",
            last_activity="2023-01-01T00:00:00",
            agent_type="claude"
        )
        
        self.db.create_session(session)
        
        # Update status
        updated = self.db.update_session_status(session.id, "stopped")
        assert updated is True
        
        # Verify update
        retrieved = self.db.get_session(session.id)
        assert retrieved.status == "stopped"
    
    def test_delete_session(self):
        """Test deleting a session."""
        session_id = str(uuid.uuid4())
        session = Session(
            id=session_id,
            name="test-saloon",
            project="test-project",
            worktree_name=session_id,
            worktree_path="/tmp/test-worktree",
            tmux_session_name=f"tinstar-{session_id}",
            status="active",
            created_at="2023-01-01T00:00:00",
            last_activity="2023-01-01T00:00:00",
            agent_type="claude"
        )
        
        self.db.create_session(session)
        
        # Delete session
        deleted = self.db.delete_session(session.id)
        assert deleted is True
        
        # Verify deletion
        retrieved = self.db.get_session(session.id)
        assert retrieved is None


class TestSessionConfig:
    """Test session configuration."""
    
    def setup_method(self):
        """Set up test configuration."""
        self.temp_dir = Path(tempfile.mkdtemp())
        self.config_path = self.temp_dir / "test_config.json"
        self.config = SessionConfig(self.config_path)
    
    def teardown_method(self):
        """Clean up test configuration."""
        shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def test_default_config(self):
        """Test default configuration values."""
        assert self.config.get_default_agent() == "claude"
        assert self.config.get_default_editor() == "cursor"
        assert self.config.get_session_timeout_hours() == 24
        assert self.config.get_max_peek_lines() == 1000
    
    def test_get_set_config(self):
        """Test getting and setting configuration values."""
        # Test setting and getting simple value
        self.config.set("test.value", "hello")
        assert self.config.get("test.value") == "hello"
        
        # Test nested values
        self.config.set("nested.deep.value", 42)
        assert self.config.get("nested.deep.value") == 42
        
        # Test default values
        assert self.config.get("non.existent.key", "default") == "default"
    
    def test_agent_config(self):
        """Test agent configuration."""
        claude_config = self.config.get_agent_config("claude")
        assert isinstance(claude_config, dict)
        assert "command_template" in claude_config
        
        # Test non-existent agent
        empty_config = self.config.get_agent_config("non-existent")
        assert empty_config == {}
    
    def test_editor_config(self):
        """Test editor configuration."""
        cursor_config = self.config.get_editor_config("cursor")
        assert isinstance(cursor_config, dict)
        assert "command_template" in cursor_config
        
        # Test non-existent editor
        empty_config = self.config.get_editor_config("non-existent")
        assert empty_config == {}


class TestSessionService:
    """Test session service operations."""
    
    def setup_method(self):
        """Set up test service."""
        self.temp_dir = Path(tempfile.mkdtemp())
        self.db_path = self.temp_dir / "test.db"
        self.db = SessionDatabase(self.db_path)
        self.service = SessionService(db=self.db)
    
    def teardown_method(self):
        """Clean up test service."""
        self.db.close()
        shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def test_old_west_name_generation(self):
        """Test old west name generation."""
        name1 = self.service._generate_old_west_name()
        name2 = self.service._generate_old_west_name()
        
        # Names should be different (high probability)
        assert name1 != name2
        
        # Names should contain a hyphen
        assert "-" in name1
        assert "-" in name2
    
    def test_unique_name_generation(self):
        """Test unique name generation."""
        # Create a session with a specific name
        session_id = str(uuid.uuid4())
        session = Session(
            id=session_id,
            name="test-saloon",
            project="test-project",
            worktree_name=session_id,
            worktree_path="/tmp/test-worktree",
            tmux_session_name=f"tinstar-{session_id}",
            status="active",
            created_at="2023-01-01T00:00:00",
            last_activity="2023-01-01T00:00:00",
            agent_type="claude"
        )
        self.db.create_session(session)
        
        # Ensure unique name generation
        unique_name = self.service._ensure_unique_name("test-saloon")
        assert unique_name != "test-saloon"
        assert unique_name.startswith("test-saloon-")
    
    def test_validate_session_creation(self):
        """Test session creation validation."""
        # Test valid inputs
        self.service.validate_session_creation("valid-project", "claude")
        
        # Test empty project
        with pytest.raises(ValueError, match="Project name cannot be empty"):
            self.service.validate_session_creation("", "claude")
        
        # Test whitespace-only project
        with pytest.raises(ValueError, match="Project name cannot be empty"):
            self.service.validate_session_creation("   ", "claude")
    
    def test_create_session_validation_error(self):
        """Test create session with validation errors."""
        import asyncio
        
        async def test_async():
            with pytest.raises(ValueError):
                await self.service.create_session("", "test prompt", "claude")
        
        # Run the async test
        try:
            asyncio.run(test_async())
        except ValueError:
            # This is expected
            pass
    
    def test_get_session(self):
        """Test getting session by ID."""
        # Test non-existent session
        session = self.service.get_session("non-existent")
        assert session is None
        
        # Create and retrieve session
        session_id = str(uuid.uuid4())
        test_session = Session(
            id=session_id,
            name="test-saloon",
            project="test-project",
            worktree_name=session_id,
            worktree_path="/tmp/test-worktree",
            tmux_session_name=f"tinstar-{session_id}",
            status="active",
            created_at="2023-01-01T00:00:00",
            last_activity="2023-01-01T00:00:00",
            agent_type="claude"
        )
        self.db.create_session(test_session)
        
        retrieved = self.service.get_session(test_session.id)
        assert retrieved is not None
        assert retrieved.id == test_session.id
        assert retrieved.name == test_session.name
    
    def test_list_sessions(self):
        """Test listing sessions."""
        # Test empty list
        sessions = self.service.list_sessions()
        assert len(sessions) == 0
        
        # Create test sessions
        for i in range(3):
            session_id = str(uuid.uuid4())
            session = Session(
                id=session_id,
                name=f"test-saloon-{i}",
                project="test-project",
                worktree_name=session_id,
                worktree_path=f"/tmp/test-worktree-{i}",
                tmux_session_name=f"tinstar-{session_id}",
                status="active",
                created_at="2023-01-01T00:00:00",
                last_activity="2023-01-01T00:00:00",
                agent_type="claude"
            )
            self.db.create_session(session)
        
        # Test listing all sessions
        all_sessions = self.service.list_sessions()
        assert len(all_sessions) == 3
        
        # Test filtering by project
        project_sessions = self.service.list_sessions(project="test-project")
        assert len(project_sessions) == 3


if __name__ == "__main__":
    pytest.main([__file__])