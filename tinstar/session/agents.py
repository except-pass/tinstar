"""
Agent implementations for the Tinstar session management system.
"""
import asyncio
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


class Agent(ABC):
    """Abstract base class for agent implementations."""
    
    @abstractmethod
    def get_start_command(self, worktree_path: str, session_name: str, initial_prompt: Optional[str]) -> str:
        """Generate shell command to start agent in worktree."""
        pass
    
    @abstractmethod
    def get_response_keys(self, response: str) -> List[str]:
        """Get key sequences for notification responses."""
        pass
    
    @abstractmethod
    async def health_check(self, session_id: str, tmux_session_name: str) -> bool:
        """Check if agent process is running and responsive."""
        pass
    
    @abstractmethod
    def get_config(self) -> Dict[str, Any]:
        """Get agent-specific configuration."""
        pass


class ClaudeAgent(Agent):
    """Claude Code agent implementation."""
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {
            "command_template": "cd {worktree_path} && TINSTAR_TERM_NAME={session_name} claude",
            "health_check_interval": 30,
            "response_mappings": {
                "approve_once": ["Enter"],
                "approve_always": ["Down", "Enter"],
                "deny": ["Down", "Down", "Enter"]
            }
        }
    
    def get_start_command(self, worktree_path: str, session_name: str, initial_prompt: Optional[str]) -> str:
        """Generate command to start Claude in the worktree."""
        base_command = f"cd {worktree_path} && TINSTAR_TERM_NAME={session_name} claude"
        
        if initial_prompt:
            # Escape single quotes in the prompt and add as positional argument
            escaped_prompt = initial_prompt.replace("'", "'\"'\"'")
            base_command += f" '{escaped_prompt}'"
        
        return base_command
    
    def get_response_keys(self, response: str) -> List[str]:
        """Get key sequences for Claude notification responses."""
        mappings = self.config.get("response_mappings", {})
        return mappings.get(response, [])
    
    async def health_check(self, session_id: str, tmux_session_name: str) -> bool:
        """Check if Claude process is running in the tmux session."""
        try:
            # Check if tmux session exists
            cmd = ["tmux", "has-session", "-t", tmux_session_name]
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await process.wait()
            
            if process.returncode != 0:
                return False
            
            # Check if Claude process is running in the session
            cmd = ["tmux", "list-panes", "-t", tmux_session_name, "-F", "#{pane_current_command}"]
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, _ = await process.communicate()
            
            if process.returncode == 0:
                commands = stdout.decode().strip().split('\n')
                # Check if any pane is running claude-code or python (Claude runs on Python)
                for command in commands:
                    if 'claude' in command.lower() or 'python' in command.lower():
                        return True
            
            return False
            
        except Exception:
            return False
    
    def get_config(self) -> Dict[str, Any]:
        """Get Claude agent configuration."""
        return self.config.copy()


class AgentFactory:
    """Factory for creating agent instances."""
    
    _agents = {
        "claude": ClaudeAgent
    }
    
    @classmethod
    def create_agent(cls, agent_type: str, config: Optional[Dict[str, Any]] = None) -> Agent:
        """Create an agent instance by type."""
        if agent_type not in cls._agents:
            raise ValueError(f"Unknown agent type: {agent_type}")
        
        agent_class = cls._agents[agent_type]
        return agent_class(config)
    
    @classmethod
    def get_available_agents(cls) -> List[str]:
        """Get list of available agent types."""
        return list(cls._agents.keys())
    
    @classmethod
    def register_agent(cls, agent_type: str, agent_class: type):
        """Register a new agent type."""
        if not issubclass(agent_class, Agent):
            raise ValueError("Agent class must inherit from Agent")
        
        cls._agents[agent_type] = agent_class


class AgentManager:
    """Manager for agent lifecycle and operations."""
    
    def __init__(self):
        self.agents: Dict[str, Agent] = {}
    
    def get_agent(self, agent_type: str, config: Optional[Dict[str, Any]] = None) -> Agent:
        """Get or create agent instance."""
        if agent_type not in self.agents:
            self.agents[agent_type] = AgentFactory.create_agent(agent_type, config)
        
        return self.agents[agent_type]
    
    async def start_agent(self, agent_type: str, worktree_path: str, session_name: str, 
                         tmux_session_name: str, initial_prompt: Optional[str] = None) -> bool:
        """Start agent in tmux session."""
        try:
            agent = self.get_agent(agent_type)
            command = agent.get_start_command(worktree_path, session_name, initial_prompt)
            
            # Send command to tmux session
            cmd = ["tmux", "send-keys", "-t", tmux_session_name, command, "Enter"]
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            await process.wait()
            return process.returncode == 0
            
        except Exception:
            return False
    
    async def respond_to_notification(self, agent_type: str, tmux_session_name: str, response: str) -> bool:
        """Send notification response to agent."""
        try:
            agent = self.get_agent(agent_type)
            keys = agent.get_response_keys(response)
            
            if not keys:
                return False
            
            # Send key sequences to tmux session
            for key in keys:
                cmd = ["tmux", "send-keys", "-t", tmux_session_name, key]
                
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                
                await process.wait()
                
                if process.returncode != 0:
                    return False
                
                # Small delay between key presses for reliability
                await asyncio.sleep(0.1)
            
            return True
            
        except Exception:
            return False
    
    async def health_check_agent(self, agent_type: str, session_id: str, tmux_session_name: str) -> bool:
        """Check agent health."""
        try:
            agent = self.get_agent(agent_type)
            return await agent.health_check(session_id, tmux_session_name)
        except Exception:
            return False
    
    def get_agent_config(self, agent_type: str) -> Dict[str, Any]:
        """Get agent configuration."""
        try:
            agent = self.get_agent(agent_type)
            return agent.get_config()
        except Exception:
            return {}