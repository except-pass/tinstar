"""
Session service for managing session lifecycle, terminal management, and agent orchestration.
"""
import asyncio
import os
import random
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .database import SessionDatabase
from .models import Session, SessionPeek
from .config import get_config
from .agents import AgentManager
from .editors import EditorManager


class SessionService:
    """Core service for session management."""
    
    def __init__(self, db: Optional[SessionDatabase] = None):
        self.db = db or SessionDatabase()
        self.config = get_config()
        self.agent_manager = AgentManager()
        self.editor_manager = EditorManager()
    
    def validate_session_creation(self, project: str, agent_type: str) -> None:
        """Validate session creation parameters."""
        if not project or not project.strip():
            raise ValueError("Project name cannot be empty")
        
        # Validate agent type
        available_agents = self.agent_manager.agents.keys() if self.agent_manager.agents else ["claude"]
        if agent_type not in available_agents and agent_type != "claude":
            raise ValueError(f"Unknown agent type '{agent_type}'. Available: {list(available_agents)}")
        
        # Check if project exists (this would integrate with Projects module)
        # For now, assume project validation is done elsewhere
    
    def _generate_old_west_name(self) -> str:
        """Generate old west themed session name."""
        adjectives = [
            "dusty", "blazing", "wild", "rusty", "golden", "silver", "iron", "copper",
            "deadwood", "tombstone", "prairie", "canyon", "mesa", "ridge", "valley",
            "sunset", "sunrise", "midnight", "dawn", "thunder", "lightning", "storm"
        ]
        
        nouns = [
            "saloon", "ranch", "gulch", "creek", "trail", "pass", "mine", "claim",
            "depot", "station", "outpost", "fort", "camp", "settlement", "crossing",
            "junction", "hollow", "bluff", "butte", "canyon", "corral", "stable"
        ]
        
        adjective = random.choice(adjectives)
        noun = random.choice(nouns)
        return f"{adjective}-{noun}"
    
    def _ensure_unique_name(self, base_name: str) -> str:
        """Ensure session name is unique."""
        name = base_name
        counter = 1
        
        while self.db.get_session_by_name(name):
            name = f"{base_name}-{counter}"
            counter += 1
        
        return name
    
    async def create_session(self, project: str, initial_prompt: Optional[str] = None, 
                           agent_type: str = "claude") -> Session:
        """Create a new session with worktree and tmux setup."""
        try:
            # Validate inputs
            self.validate_session_creation(project, agent_type)
            
            session_id = str(uuid.uuid4())
            base_name = self._generate_old_west_name()
            session_name = self._ensure_unique_name(base_name)
            
            # Create worktree via worktrees module
            worktree_path = await self._create_worktree(project, session_id)
            
            # Generate tmux session name
            tmux_session_name = f"tinstar-{session_id}"
            
            # Create session object
            session = Session(
                id=session_id,
                name=session_name,
                project=project,
                worktree_name=session_id,
                worktree_path=str(worktree_path),
                tmux_session_name=tmux_session_name,
                status="active",
                created_at=datetime.now().isoformat(),
                last_activity=datetime.now().isoformat(),
                agent_type=agent_type,
                initial_prompt=initial_prompt
            )
            
            # Store in database
            self.db.create_session(session)
            
            try:
                # Initialize tmux session
                await self._create_tmux_session(session)
                
                # Start agent process
                await self._start_agent(session)
                
            except Exception as e:
                # Cleanup on failure
                self.db.delete_session(session_id)
                await self._remove_worktree(session.worktree_name)
                raise RuntimeError(f"Failed to initialize session: {e}")
            
            return session
            
        except Exception as e:
            if isinstance(e, (ValueError, RuntimeError)):
                raise
            else:
                raise RuntimeError(f"Unexpected error creating session: {e}")
    
    async def _create_worktree(self, project: str, worktree_name: str) -> Path:
        """Create worktree via worktrees module."""
        # This would integrate with the worktrees module
        # For now, simulate the worktree creation
        worktree_path = Path.home() / ".tinstar" / "worktrees" / worktree_name
        worktree_path.mkdir(parents=True, exist_ok=True)
        return worktree_path
    
    async def _create_tmux_session(self, session: Session):
        """Create and configure tmux session."""
        # Create new tmux session
        cmd = [
            "tmux", "new-session", "-d", "-s", session.tmux_session_name,
            "-c", session.worktree_path
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        await process.wait()
        
        # Set environment variable for events integration
        env_cmd = [
            "tmux", "send-keys", "-t", session.tmux_session_name,
            f"export TINSTAR_TERM_NAME={session.name}", "Enter"
        ]
        
        process = await asyncio.create_subprocess_exec(
            *env_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        await process.wait()
    
    async def _start_agent(self, session: Session):
        """Start agent process in tmux session."""
        try:
            success = await self.agent_manager.start_agent(
                session.agent_type,
                session.worktree_path,
                session.name,
                session.tmux_session_name,
                session.initial_prompt
            )
            
            if not success:
                raise RuntimeError(f"Failed to start {session.agent_type} agent")
                
        except Exception as e:
            raise RuntimeError(f"Error starting agent: {e}")
    
    def get_session(self, session_id: str) -> Optional[Session]:
        """Get session by ID."""
        return self.db.get_session(session_id)
    
    def list_sessions(self, project: Optional[str] = None) -> List[Session]:
        """List all sessions, optionally filtered by project."""
        return self.db.list_sessions(project=project, status="active")
    
    async def peek_session(self, session_id: str, lines: int = 50) -> Optional[SessionPeek]:
        """Get recent terminal output from session."""
        session = self.db.get_session(session_id)
        if not session:
            return None
        
        # Capture tmux session output
        cmd = [
            "tmux", "capture-pane", "-t", session.tmux_session_name,
            "-p", "-S", f"-{lines}"
        ]
        
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await process.communicate()
            
            if process.returncode == 0:
                output_lines = stdout.decode().splitlines()
                
                # Store logs in database
                for i, line in enumerate(output_lines):
                    self.db.store_session_log(session_id, line, i + 1)
                
                return SessionPeek(
                    session_id=session_id,
                    lines=output_lines,
                    timestamp=datetime.now().isoformat(),
                    line_count=len(output_lines)
                )
        except Exception:
            pass
        
        return None
    
    async def send_to_session(self, session_id: str, text: str) -> bool:
        """Send text input to session terminal."""
        session = self.db.get_session(session_id)
        if not session:
            return False
        
        # Update last activity
        self.db.update_session_activity(session_id)
        
        # Send text to tmux session
        cmd = ["tmux", "send-keys", "-t", session.tmux_session_name, text, "Enter"]
        
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            await process.wait()
            return process.returncode == 0
        except Exception:
            return False
    
    async def open_in_editor(self, session_id: str, file_path: str, line_number: Optional[int] = None) -> bool:
        """Open file in configured editor."""
        try:
            session = self.db.get_session(session_id)
            if not session:
                raise ValueError(f"Session {session_id} not found")
            
            # Validate file path is within worktree
            if not self.editor_manager.validate_file_path(session.worktree_path, file_path):
                raise ValueError(f"File path '{file_path}' is not valid or not within worktree")
            
            editor_type = self.config.get_default_editor()
            
            return await self.editor_manager.open_file(
                editor_type,
                session.worktree_path,
                file_path,
                line_number
            )
            
        except Exception as e:
            if isinstance(e, ValueError):
                raise
            else:
                raise RuntimeError(f"Error opening file in editor: {e}")
    
    async def respond_to_notification(self, session_id: str, response: str) -> bool:
        """Respond to agent notification with appropriate key sequences."""
        try:
            session = self.db.get_session(session_id)
            if not session:
                raise ValueError(f"Session {session_id} not found")
            
            # Validate response type
            valid_responses = ["approve_once", "approve_always", "deny"]
            if response not in valid_responses:
                raise ValueError(f"Invalid response '{response}'. Must be one of: {valid_responses}")
            
            # Use agent manager to send response
            success = await self.agent_manager.respond_to_notification(
                session.agent_type,
                session.tmux_session_name,
                response
            )
            
            if success:
                # Store policy if approve_always
                if response == "approve_always":
                    self.db.store_session_policy(session_id, "security_prompt", response)
                
                # Update last activity
                self.db.update_session_activity(session_id)
            
            return success
            
        except Exception as e:
            if isinstance(e, ValueError):
                raise
            else:
                raise RuntimeError(f"Error responding to notification: {e}")
    
    async def terminate_session(self, session_id: str) -> bool:
        """Terminate session and cleanup resources."""
        session = self.db.get_session(session_id)
        if not session:
            return False
        
        # Kill tmux session
        cmd = ["tmux", "kill-session", "-t", session.tmux_session_name]
        
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            await process.wait()
        except Exception:
            pass
        
        # Remove worktree (would integrate with worktrees module)
        await self._remove_worktree(session.worktree_name)
        
        # Update database
        self.db.update_session_status(session_id, "stopped")
        
        return True
    
    async def _remove_worktree(self, worktree_name: str):
        """Remove worktree via worktrees module."""
        # This would integrate with the worktrees module
        # For now, simulate worktree removal
        worktree_path = Path.home() / ".tinstar" / "worktrees" / worktree_name
        if worktree_path.exists():
            import shutil
            shutil.rmtree(worktree_path, ignore_errors=True)
    
    async def health_check(self, session_id: str) -> bool:
        """Check if session and agent are healthy."""
        try:
            session = self.db.get_session(session_id)
            if not session:
                return False
            
            # Check tmux session health first
            cmd = ["tmux", "has-session", "-t", session.tmux_session_name]
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            await process.wait()
            
            if process.returncode != 0:
                self.db.update_session_status(session_id, "error")
                return False
            
            # Check agent health
            agent_healthy = await self.agent_manager.health_check_agent(
                session.agent_type,
                session_id,
                session.tmux_session_name
            )
            
            if agent_healthy:
                self.db.update_session_activity(session_id)
                return True
            else:
                self.db.update_session_status(session_id, "error")
                return False
                
        except Exception:
            self.db.update_session_status(session_id, "error")
            return False