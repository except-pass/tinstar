"""
Configuration management for the Tinstar system.
"""
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .session.agents import AgentFactory
from .session.editors import EditorFactory


class TinstarConfig:
    """Configuration manager for Tinstar system."""
    
    def __init__(self, config_path: Optional[Path] = None):
        if config_path is None:
            tinstar_home = Path.home() / ".tinstar"
            tinstar_home.mkdir(exist_ok=True)
            config_path = tinstar_home / "config.json"
        
        self.config_path = Path(config_path)
        self._config = self._load_config()
    
    def _get_default_config(self) -> Dict[str, Any]:
        """Get default configuration."""
        return {
            # System-level configuration
            "database": {
                "url": "sqlite:///tinstar.db"
            },
            "server": {
                "host": "localhost",
                "port": 3002
            },
            "workdir": "~/.tinstar",
            "logs": {
                "level": "info"
            },
            # Agent configuration
            "agents": {
                "claude": {
                    "command_template": "cd {worktree_path} && TINSTAR_TERM_NAME={session_name} claude",
                    "health_check_interval": 30,
                    "response_mappings": {
                        "approve_once": ["Enter"],
                        "approve_always": ["Down", "Enter"],
                        "deny": ["Down", "Down", "Enter"]
                    }
                }
            },
            # Editor configuration
            "editors": {
                "cursor": {
                    "command_template": "cursor {worktree_path} && cursor -a {file_path}:{line_number}",
                    "supports_line_numbers": True,
                    "background": True
                },
                "vscode": {
                    "command_template": "code -g {file_path}:{line_number}",
                    "supports_line_numbers": True,
                    "background": True
                },
                "nvim": {
                    "command_template": "cd {worktree_path} && nvim +{line_number} {file_path}",
                    "supports_line_numbers": True,
                    "background": False,
                    "terminal_based": True
                }
            },
            # Defaults
            "defaults": {
                "agent": "claude",
                "editor": "cursor"
            },
            # Session configuration
            "session": {
                "timeout_hours": 24,
                "max_peek_lines": 1000,
                "health_check_interval": 300,  # 5 minutes
                "auto_cleanup_stopped": True,
                "naming_theme": "old_west",
                "auto_cleanup": True
            },
            # Worktree configuration
            "worktree": {
                "base_path": "~/.tinstar/worktrees",
                "branch_prefix": "worktree/"
            },
            # Logging configuration
            "logging": {
                "terminal_logs_enabled": True,
                "log_retention_days": 30,
                "max_log_file_size_mb": 100
            }
        }
    
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from file or create default."""
        if self.config_path.exists():
            try:
                with open(self.config_path, 'r') as f:
                    config = json.load(f)
                
                # Merge with defaults to ensure all keys exist
                default_config = self._get_default_config()
                return self._merge_config(default_config, config)
                
            except (json.JSONDecodeError, IOError) as e:
                print(f"Warning: Could not load config from {self.config_path}: {e}")
                return self._get_default_config()
        else:
            # Create default config file
            default_config = self._get_default_config()
            self._save_config(default_config)
            return default_config
    
    def _merge_config(self, default: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
        """Recursively merge user config with defaults."""
        result = default.copy()
        
        for key, value in user.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = self._merge_config(result[key], value)
            else:
                result[key] = value
        
        return result
    
    def _save_config(self, config: Dict[str, Any]):
        """Save configuration to file."""
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.config_path, 'w') as f:
                json.dump(config, f, indent=2)
        except IOError as e:
            print(f"Warning: Could not save config to {self.config_path}: {e}")
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get configuration value by key (supports dot notation)."""
        keys = key.split('.')
        value = self._config
        
        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default
        
        return value
    
    def set(self, key: str, value: Any):
        """Set configuration value by key (supports dot notation)."""
        keys = key.split('.')
        config = self._config
        
        # Navigate to the parent of the target key
        for k in keys[:-1]:
            if k not in config:
                config[k] = {}
            config = config[k]
        
        # Set the value
        config[keys[-1]] = value
        self._save_config(self._config)
    
    def get_default_agent(self) -> str:
        """Get default agent type."""
        return self.get("defaults.agent", "claude")
    
    def get_default_editor(self) -> str:
        """Get default editor type."""
        return self.get("defaults.editor", "cursor")
    
    def get_agent_config(self, agent_type: str) -> Dict[str, Any]:
        """Get configuration for specific agent type."""
        return self.get(f"agents.{agent_type}", {})
    
    def get_editor_config(self, editor_type: str) -> Dict[str, Any]:
        """Get configuration for specific editor type."""
        return self.get(f"editors.{editor_type}", {})
    
    def add_agent(self, agent_type: str, config: Dict[str, Any]):
        """Add or update agent configuration."""
        self.set(f"agents.{agent_type}", config)
    
    def add_editor(self, editor_type: str, config: Dict[str, Any]):
        """Add or update editor configuration."""
        self.set(f"editors.{editor_type}", config)
    
    def get_session_timeout_hours(self) -> int:
        """Get session timeout in hours."""
        return self.get("session.timeout_hours", 24)
    
    def get_max_peek_lines(self) -> int:
        """Get maximum lines for peek operation."""
        return self.get("session.max_peek_lines", 1000)
    
    def get_health_check_interval(self) -> int:
        """Get health check interval in seconds."""
        return self.get("session.health_check_interval", 300)
    
    def get_worktree_base_path(self) -> str:
        """Get base path for worktrees."""
        path = self.get("worktree.base_path", "~/.tinstar/worktrees")
        return os.path.expanduser(path)
    
    def get_worktree_branch_prefix(self) -> str:
        """Get branch prefix for worktrees."""
        return self.get("worktree.branch_prefix", "worktree/")
    
    def is_terminal_logging_enabled(self) -> bool:
        """Check if terminal logging is enabled."""
        return self.get("logging.terminal_logs_enabled", True)
    
    def get_log_retention_days(self) -> int:
        """Get log retention period in days."""
        return self.get("logging.log_retention_days", 30)
    
    def get_max_log_file_size_mb(self) -> int:
        """Get maximum log file size in MB."""
        return self.get("logging.max_log_file_size_mb", 100)
    
    # System-level configuration methods
    def get_database_url(self) -> str:
        """Get database URL."""
        return self.get("database.url", "sqlite:///tinstar.db")
    
    def get_server_host(self) -> str:
        """Get server host."""
        return self.get("server.host", "localhost")
    
    def get_server_port(self) -> int:
        """Get server port."""
        return self.get("server.port", 3002)
    
    def get_workdir(self) -> str:
        """Get workdir path."""
        path = self.get("workdir", "~/.tinstar")
        return os.path.expanduser(path)
    
    def get_log_level(self) -> str:
        """Get log level."""
        return self.get("logs.level", "info")
    
    def get_session_naming_theme(self) -> str:
        """Get session naming theme."""
        return self.get("session.naming_theme", "old_west")
    
    def is_session_auto_cleanup_enabled(self) -> bool:
        """Check if session auto cleanup is enabled."""
        return self.get("session.auto_cleanup", True)
    
    def get_server_base_url(self) -> str:
        """Get the base URL for the server."""
        host = self.get_server_host()
        port = self.get_server_port()
        return f"http://{host}:{port}"
    
    def get_events_api_url(self, endpoint: str) -> str:
        """Get the full URL for an events API endpoint."""
        base_url = self.get_server_base_url()
        # Ensure endpoint starts with /
        if not endpoint.startswith('/'):
            endpoint = '/' + endpoint
        return f"{base_url}/api/events{endpoint}"
    
    def validate_config(self) -> Dict[str, str]:
        """Validate configuration and return any errors."""
        errors = {}
        
        # Validate agent configurations
        agents = self.get("agents", {})
        for agent_type, agent_config in agents.items():
            if not isinstance(agent_config, dict):
                errors[f"agents.{agent_type}"] = "Agent config must be a dictionary"
                continue
            
            if "command_template" not in agent_config:
                errors[f"agents.{agent_type}.command_template"] = "Missing required command_template"
        
        # Validate editor configurations
        editors = self.get("editors", {})
        for editor_type, editor_config in editors.items():
            if not isinstance(editor_config, dict):
                errors[f"editors.{editor_type}"] = "Editor config must be a dictionary"
                continue
        
        # Validate default agent exists
        default_agent = self.get_default_agent()
        if default_agent not in agents:
            errors["defaults.agent"] = f"Default agent '{default_agent}' not found in agents configuration"
        
        # Validate default editor exists
        default_editor = self.get_default_editor()
        if default_editor not in editors:
            errors["defaults.editor"] = f"Default editor '{default_editor}' not found in editors configuration"
        
        # Validate numeric values
        timeout_hours = self.get_session_timeout_hours()
        if not isinstance(timeout_hours, int) or timeout_hours <= 0:
            errors["session.timeout_hours"] = "Must be a positive integer"
        
        max_peek_lines = self.get_max_peek_lines()
        if not isinstance(max_peek_lines, int) or max_peek_lines <= 0:
            errors["session.max_peek_lines"] = "Must be a positive integer"
        
        return errors
    
    def reload(self):
        """Reload configuration from file."""
        self._config = self._load_config()
    
    def export_config(self) -> Dict[str, Any]:
        """Export current configuration."""
        return self._config.copy()
    
    def import_config(self, config: Dict[str, Any]):
        """Import configuration from dictionary."""
        default_config = self._get_default_config()
        self._config = self._merge_config(default_config, config)
        self._save_config(self._config)


# Global configuration instance
_config = None


def get_config() -> TinstarConfig:
    """Get global configuration instance."""
    global _config
    if _config is None:
        _config = TinstarConfig()
    return _config


def reload_config():
    """Reload global configuration."""
    global _config
    if _config is not None:
        _config.reload()
