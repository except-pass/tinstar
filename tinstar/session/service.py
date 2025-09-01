"""
Session service for managing session lifecycle, terminal management, and agent orchestration.
"""
import asyncio
import os
import base64
import random
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .database import SessionDatabase
from .models import Session, SessionPeek
from ..config import get_config
from .agents import AgentManager
from .editors import EditorManager
from ..worktrees.service import WorktreeService
from ..worktrees.models import WorktreeCreateRequest, WorktreeDeleteRequest
from ..events.websocket import websocket_manager


class SessionService:
    """Core service for session management."""
    
    def __init__(self, db: Optional[SessionDatabase] = None):
        self.db = db or SessionDatabase()
        self.config = get_config()
        self.agent_manager = AgentManager()
        self.editor_manager = EditorManager()
        self.worktree_service = WorktreeService()
    
    def validate_session_creation(self, project: str, agent_type: str) -> None:
        """Validate session creation parameters."""
        if not project or not project.strip():
            raise ValueError("Project name cannot be empty")
        
        # Validate agent type
        available_agents = self.agent_manager.agents.keys() if self.agent_manager.agents else ["claude"]
        if agent_type not in available_agents and agent_type != "claude":
            raise ValueError(f"Unknown agent type '{agent_type}'. Available: {list(available_agents)}")
        
        # Check if project exists
        from ..projects.service import ProjectService
        project_service = ProjectService()
        if not project_service.get_project(project):
            # Get list of available projects to show in error
            available_projects = project_service.list_projects()
            
            error_msg = f"❌ Project '{project}' not found.\n\n"
            
            if available_projects:
                error_msg += "📋 Available projects:\n"
                for proj in available_projects:
                    error_msg += f"  • {proj.name} ({proj.path})\n"
                error_msg += f"\n💡 Use an existing project or register a new one:\n"
            else:
                error_msg += "📋 No projects registered yet.\n\n💡 Register a project first:\n"
            
            error_msg += f"   tinstar project register <path> --name {project}\n"
            error_msg += f"   tinstar project register /path/to/your/repo\n\n"
            error_msg += f"📚 View all projects: tinstar project list"
            
            raise ValueError(error_msg)
    
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

                # Begin streaming terminal output
                await self._setup_terminal_stream(session)
                
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
        try:
            request = WorktreeCreateRequest(
                project=project,
                name=worktree_name
            )
            worktree = self.worktree_service.create_worktree(request)
            return Path(worktree.path)
        except Exception as e:
            raise ValueError(f"Failed to create worktree: {e}")
    
    async def _create_tmux_session(self, session: Session):
        """Create and configure tmux session."""
        # Create new tmux session
        cmd = [
            "tmux", "-L", "tinstar", "-f", str(Path(__file__).resolve().parents[2] / "tmux.tinstar.conf"),
            "new-session", "-d", "-s", session.tmux_session_name,
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
            "tmux", "-L", "tinstar", "send-keys", "-t", session.tmux_session_name,
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
            
            # Give the agent a moment to initialize
            await asyncio.sleep(2)
                
        except Exception as e:
            raise RuntimeError(f"Error starting agent: {e}")

    async def _setup_terminal_stream(self, session: Session) -> None:
        """Configure tmux pipe and start streaming terminal data."""
        try:
            fifo_dir = Path("/tmp/tinstar_fifos")
            fifo_dir.mkdir(parents=True, exist_ok=True)
            fifo_path = fifo_dir / f"{session.id}.fifo"
            if fifo_path.exists():
                fifo_path.unlink()
            os.mkfifo(fifo_path)

            cmd = [
                "tmux", "-L", "tinstar", "pipe-pane", "-t", session.tmux_session_name,
                f"cat > {fifo_path}"
            ]
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await process.wait()

            asyncio.create_task(self._stream_terminal_data(session.id, fifo_path))
            await websocket_manager.broadcast("terminal_cleared", {"sessionId": session.id})
        except Exception as e:
            raise RuntimeError(f"Failed to setup terminal stream: {e}")

    async def _stream_terminal_data(self, session_id: str, fifo_path: Path) -> None:
        """Read raw byte chunks from FIFO and broadcast as terminal_data events."""
        loop = asyncio.get_event_loop()
        while True:
            try:
                with open(fifo_path, "rb") as fifo:
                    while True:
                        chunk = await loop.run_in_executor(None, fifo.read, 1024)
                        if not chunk:
                            await asyncio.sleep(0.05)
                            continue
                        data = base64.b64encode(chunk).decode("ascii")
                        await websocket_manager.broadcast(
                            "terminal_data", {"sessionId": session_id, "data": data}
                        )
            except FileNotFoundError:
                break
            except Exception:
                await asyncio.sleep(0.1)
    
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
            "tmux", "-L", "tinstar", "capture-pane", "-t", session.tmux_session_name,
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
        
        # Send text literally, then press Enter
        try:
            send_literal_cmd = [
                "tmux", "-L", "tinstar", "send-keys", "-t", session.tmux_session_name, "-l", text
            ]
            process1 = await asyncio.create_subprocess_exec(
                *send_literal_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await process1.wait()

            send_enter_cmd = [
                "tmux", "-L", "tinstar", "send-keys", "-t", session.tmux_session_name, "Enter"
            ]
            process2 = await asyncio.create_subprocess_exec(
                *send_enter_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await process2.wait()

            return process1.returncode == 0 and process2.returncode == 0
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
    
    async def terminate_session(self, session_id: str) -> Tuple[bool, Optional[str]]:
        """Terminate session and cleanup resources. Returns (success, worktree_error)."""
        session = self.db.get_session(session_id)
        if not session:
            return False, None
        
        # Kill tmux session
        cmd = ["tmux", "-L", "tinstar", "kill-session", "-t", session.tmux_session_name]
        
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            await process.wait()
        except Exception:
            pass
        
        # Remove worktree via service, but don't block termination on failure
        worktree_error: Optional[str] = None
        try:
            await self._remove_worktree(session.worktree_name)
        except Exception as e:
            worktree_error = str(e)
        
        # Update database
        self.db.update_session_status(session_id, "stopped")
        
        return True, worktree_error
    
    async def _remove_worktree(self, worktree_name: str):
        """Remove worktree via the WorktreeService module. Raises on failure."""
        # We need the associated project to delete the worktree correctly
        session = self.db.get_session(worktree_name)  # worktree name equals session id
        if not session:
            raise ValueError(f"Session {worktree_name} not found for worktree removal")
        request = WorktreeDeleteRequest(
            project=session.project,
            name=worktree_name,
            force=True
        )
        deleted = self.worktree_service.delete_worktree(request)
        if not deleted:
            raise RuntimeError("Failed to delete worktree via WorktreeService")
    
    async def health_check(self, session_id: str) -> bool:
        """Check if session and agent are healthy."""
        try:
            session = self.db.get_session(session_id)
            if not session:
                return False
            
            # Check tmux session health first
            cmd = ["tmux", "-L", "tinstar", "has-session", "-t", session.tmux_session_name]
            
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