"""
Editor implementations for the Tinstar session management system.
"""
import asyncio
import os
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional


class Editor(ABC):
    """Abstract base class for editor implementations."""
    
    @abstractmethod
    def get_open_command(self, worktree_path: str, file_path: Optional[str] = None, 
                        line_number: Optional[int] = None) -> str:
        """Generate command to open file in editor."""
        pass
    
    @abstractmethod
    def supports_line_numbers(self) -> bool:
        """Check if editor supports jumping to specific line numbers."""
        pass
    
    @abstractmethod
    def get_config(self) -> Dict[str, Any]:
        """Get editor-specific configuration."""
        pass


class CursorEditor(Editor):
    """Cursor editor implementation."""
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {
            "command_template": "cursor {worktree_path}",
            "file_command_template": "cursor -a {file_path}",
            "file_with_line_template": "cursor -a {file_path}:{line_number}",
            "supports_line_numbers": True,
            "background": True
        }
    
    def get_open_command(self, worktree_path: str, file_path: Optional[str] = None, 
                        line_number: Optional[int] = None) -> str:
        """Generate command to open file in Cursor."""
        # First ensure the worktree is open in Cursor
        base_command = f"cursor {worktree_path}"
        
        if file_path:
            # Make file path absolute if it's relative
            if not os.path.isabs(file_path):
                file_path = os.path.join(worktree_path, file_path)
            
            if line_number and self.supports_line_numbers():
                # Open specific file at line number
                file_command = f"cursor -a {file_path}:{line_number}"
            else:
                # Open specific file
                file_command = f"cursor -a {file_path}"
            
            # Combine commands with && to ensure worktree opens first
            return f"{base_command} && {file_command}"
        else:
            # Just open the worktree
            return base_command
    
    def supports_line_numbers(self) -> bool:
        """Cursor supports line number navigation."""
        return self.config.get("supports_line_numbers", True)
    
    def get_config(self) -> Dict[str, Any]:
        """Get Cursor editor configuration."""
        return self.config.copy()


class VSCodeEditor(Editor):
    """Visual Studio Code editor implementation."""
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {
            "command_template": "code {worktree_path}",
            "file_command_template": "code {file_path}",
            "file_with_line_template": "code -g {file_path}:{line_number}",
            "supports_line_numbers": True,
            "background": True
        }
    
    def get_open_command(self, worktree_path: str, file_path: Optional[str] = None, 
                        line_number: Optional[int] = None) -> str:
        """Generate command to open file in VSCode."""
        if file_path:
            # Make file path absolute if it's relative
            if not os.path.isabs(file_path):
                file_path = os.path.join(worktree_path, file_path)
            
            if line_number and self.supports_line_numbers():
                # Open specific file at line number
                return f"code -g {file_path}:{line_number}"
            else:
                # Open specific file
                return f"code {file_path}"
        else:
            # Open the worktree
            return f"code {worktree_path}"
    
    def supports_line_numbers(self) -> bool:
        """VSCode supports line number navigation."""
        return self.config.get("supports_line_numbers", True)
    
    def get_config(self) -> Dict[str, Any]:
        """Get VSCode editor configuration."""
        return self.config.copy()


class NeoVimEditor(Editor):
    """Neovim editor implementation."""
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {
            "command_template": "nvim {file_path}",
            "file_with_line_template": "nvim +{line_number} {file_path}",
            "supports_line_numbers": True,
            "background": False,
            "terminal_based": True
        }
    
    def get_open_command(self, worktree_path: str, file_path: Optional[str] = None, 
                        line_number: Optional[int] = None) -> str:
        """Generate command to open file in Neovim."""
        if file_path:
            # Make file path absolute if it's relative
            if not os.path.isabs(file_path):
                file_path = os.path.join(worktree_path, file_path)
            
            if line_number and self.supports_line_numbers():
                # Open specific file at line number
                return f"cd {worktree_path} && nvim +{line_number} {file_path}"
            else:
                # Open specific file
                return f"cd {worktree_path} && nvim {file_path}"
        else:
            # Open directory in neovim
            return f"cd {worktree_path} && nvim ."
    
    def supports_line_numbers(self) -> bool:
        """Neovim supports line number navigation."""
        return self.config.get("supports_line_numbers", True)
    
    def get_config(self) -> Dict[str, Any]:
        """Get Neovim editor configuration."""
        return self.config.copy()


class EditorFactory:
    """Factory for creating editor instances."""
    
    _editors = {
        "cursor": CursorEditor,
        "vscode": VSCodeEditor,
        "code": VSCodeEditor,  # Alias for VSCode
        "nvim": NeoVimEditor,
        "neovim": NeoVimEditor  # Alias for Neovim
    }
    
    @classmethod
    def create_editor(cls, editor_type: str, config: Optional[Dict[str, Any]] = None) -> Editor:
        """Create an editor instance by type."""
        if editor_type not in cls._editors:
            raise ValueError(f"Unknown editor type: {editor_type}")
        
        editor_class = cls._editors[editor_type]
        return editor_class(config)
    
    @classmethod
    def get_available_editors(cls) -> List[str]:
        """Get list of available editor types."""
        return list(cls._editors.keys())
    
    @classmethod
    def register_editor(cls, editor_type: str, editor_class: type):
        """Register a new editor type."""
        if not issubclass(editor_class, Editor):
            raise ValueError("Editor class must inherit from Editor")
        
        cls._editors[editor_type] = editor_class


class EditorManager:
    """Manager for editor operations."""
    
    def __init__(self):
        self.editors: Dict[str, Editor] = {}
    
    def get_editor(self, editor_type: str, config: Optional[Dict[str, Any]] = None) -> Editor:
        """Get or create editor instance."""
        if editor_type not in self.editors:
            self.editors[editor_type] = EditorFactory.create_editor(editor_type, config)
        
        return self.editors[editor_type]
    
    async def open_file(self, editor_type: str, worktree_path: str, file_path: Optional[str] = None,
                       line_number: Optional[int] = None) -> bool:
        """Open file in specified editor."""
        try:
            editor = self.get_editor(editor_type)
            command = editor.get_open_command(worktree_path, file_path, line_number)
            
            # Execute the command
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=worktree_path
            )
            
            # For terminal-based editors, wait for completion
            # For GUI editors, don't wait as they run in background
            editor_config = editor.get_config()
            if not editor_config.get("background", True):
                await process.wait()
                return process.returncode == 0
            else:
                # Give GUI editors a moment to start
                await asyncio.sleep(0.5)
                return True
            
        except Exception:
            return False
    
    async def open_worktree(self, editor_type: str, worktree_path: str) -> bool:
        """Open entire worktree in editor."""
        return await self.open_file(editor_type, worktree_path)
    
    def supports_line_numbers(self, editor_type: str) -> bool:
        """Check if editor supports line number navigation."""
        try:
            editor = self.get_editor(editor_type)
            return editor.supports_line_numbers()
        except Exception:
            return False
    
    def get_editor_config(self, editor_type: str) -> Dict[str, Any]:
        """Get editor configuration."""
        try:
            editor = self.get_editor(editor_type)
            return editor.get_config()
        except Exception:
            return {}
    
    def validate_file_path(self, worktree_path: str, file_path: str) -> bool:
        """Validate that file path is within worktree and exists."""
        try:
            worktree = Path(worktree_path).resolve()
            
            # Handle absolute and relative paths
            if os.path.isabs(file_path):
                file_full_path = Path(file_path).resolve()
            else:
                file_full_path = (worktree / file_path).resolve()
            
            # Check if file is within worktree
            try:
                file_full_path.relative_to(worktree)
            except ValueError:
                return False
            
            # Check if file exists
            return file_full_path.exists()
            
        except Exception:
            return False