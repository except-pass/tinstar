"""
Event ingestion and processing service.
"""
import json
import logging
import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .database import EventsDatabase
from .models import Event, EventFilter, EventResponse, FileEvent, TodoEvent


logger = logging.getLogger(__name__)


class EventProcessor:
    """Processes specialized event types."""
    
    @staticmethod
    def process_todo_event(event: Event) -> Optional[TodoEvent]:
        """Process TodoWrite events into TodoEvent objects."""
        if event.tool_name != 'TodoWrite':
            return None
        
        # Determine if this is a new todo list or update
        event_type = "new"
        if (event.hook_event_name == "PostToolUse" and 
            event.tool_response and 
            'oldTodos' in event.tool_response and
            event.tool_response['oldTodos']):
            event_type = "update"
        
        # Create TodoEvent by copying Event data and adding type
        event_data = event.model_dump()
        event_data['type'] = event_type
        todo_event = TodoEvent(**event_data)
        return todo_event
    
    @staticmethod
    def process_file_event(event: Event) -> Optional[FileEvent]:
        """Process file operation events into FileEvent objects."""
        file_tools = {'Write', 'Edit', 'MultiEdit', 'NotebookEdit'}
        if event.tool_name not in file_tools:
            return None
        
        if not event.tool_input:
            return None
        
        file_path = event.tool_input.get('file_path')
        if not file_path:
            return None
        
        # Map tool names to operations
        operation_map = {
            'Write': 'write',
            'Edit': 'edit', 
            'MultiEdit': 'multiedit',
            'NotebookEdit': 'edit'
        }
        operation = operation_map.get(event.tool_name, 'edit')
        
        # Try to get line changes from git if possible
        lines_added, lines_removed = EventProcessor._calculate_line_changes(file_path)
        
        # Get content preview
        content_preview = EventProcessor._get_content_preview(event)
        
        file_event = FileEvent(
            **event.model_dump(),
            file_path=file_path,
            operation=operation,
            lines_added=lines_added,
            lines_removed=lines_removed,
            content_preview=content_preview
        )
        return file_event
    
    @staticmethod
    def _calculate_line_changes(file_path: str) -> Tuple[Optional[int], Optional[int]]:
        """Calculate line changes using git diff."""
        try:
            # Check if we're in a git repository
            result = subprocess.run(
                ['git', 'rev-parse', '--git-dir'],
                capture_output=True,
                text=True,
                cwd=os.path.dirname(file_path) if os.path.dirname(file_path) else '.'
            )
            if result.returncode != 0:
                return None, None
            
            # Get numstat for the file
            result = subprocess.run(
                ['git', 'diff', '--numstat', 'HEAD', '--', file_path],
                capture_output=True,
                text=True,
                cwd=os.path.dirname(file_path) if os.path.dirname(file_path) else '.'
            )
            
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().split('\t')
                if len(lines) >= 2:
                    try:
                        added = int(lines[0]) if lines[0] != '-' else None
                        removed = int(lines[1]) if lines[1] != '-' else None
                        return added, removed
                    except ValueError:
                        pass
            
            # For untracked files, count total lines as added
            if os.path.exists(file_path):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        total_lines = sum(1 for _ in f)
                    return total_lines, None
                except (UnicodeDecodeError, IOError):
                    pass
            
        except Exception as e:
            logger.warning(f"Failed to calculate line changes for {file_path}: {e}")
        
        return None, None
    
    @staticmethod
    def _get_content_preview(event: Event) -> Optional[str]:
        """Get content preview from event data."""
        if not event.tool_input:
            return None
        
        # For Write operations, preview the content
        if event.tool_name == 'Write' and 'content' in event.tool_input:
            content = event.tool_input['content']
            return content[:200] if content else None
        
        # For Edit operations, preview the new_string
        if event.tool_name == 'Edit' and 'new_string' in event.tool_input:
            new_string = event.tool_input['new_string']
            return new_string[:200] if new_string else None
        
        # For MultiEdit operations, preview first edit
        if event.tool_name == 'MultiEdit' and 'edits' in event.tool_input:
            edits = event.tool_input['edits']
            if edits and len(edits) > 0 and 'new_string' in edits[0]:
                new_string = edits[0]['new_string']
                return new_string[:200] if new_string else None
        
        return None


class FailedEventLogger:
    """Handles logging of failed events."""
    
    def __init__(self, log_dir: Optional[Path] = None):
        if log_dir is None:
            tinstar_home = Path.home() / ".tinstar"
            tinstar_home.mkdir(exist_ok=True)
            log_dir = tinstar_home / "logs"
        
        log_dir.mkdir(exist_ok=True)
        self.log_file = log_dir / "failed-events.log"
        
        # Configure logger
        self.logger = logging.getLogger('tinstar.events.failed')
        if not self.logger.handlers:
            handler = logging.FileHandler(self.log_file)
            formatter = logging.Formatter(
                '%(asctime)s - %(levelname)s - %(message)s'
            )
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
            self.logger.setLevel(logging.ERROR)
    
    def log_failed_event(self, raw_data: Dict[str, Any], error: Exception):
        """Log a failed event with full payload."""
        self.logger.error(
            f"Failed to process event: {error}\n"
            f"Raw payload: {json.dumps(raw_data, indent=2)}"
        )


class EventIngestionService:
    """Main service for event ingestion and processing."""
    
    def __init__(self, database: Optional[EventsDatabase] = None):
        self.database = database or EventsDatabase()
        self.processor = EventProcessor()
        self.failed_logger = FailedEventLogger()
        self._websocket_callbacks: List[callable] = []
    
    def add_websocket_callback(self, callback: callable):
        """Add callback for WebSocket broadcasting."""
        self._websocket_callbacks.append(callback)
    
    def remove_websocket_callback(self, callback: callable):
        """Remove WebSocket callback."""
        if callback in self._websocket_callbacks:
            self._websocket_callbacks.remove(callback)
    
    def _broadcast_event(self, event_type: str, event_data: Any):
        """Broadcast event to WebSocket clients."""
        import asyncio
        
        for callback in self._websocket_callbacks:
            try:
                # Handle both sync and async callbacks
                if asyncio.iscoroutinefunction(callback):
                    # For async callbacks, create a task but don't await
                    # This prevents blocking the main event processing
                    try:
                        loop = asyncio.get_event_loop()
                        if loop.is_running():
                            # Create task without awaiting to avoid blocking
                            loop.create_task(callback(event_type, event_data))
                        else:
                            # If no loop is running, we can't handle async callbacks
                            logger.debug("No running event loop, skipping async callback")
                    except RuntimeError:
                        # No event loop, can't handle async callbacks
                        logger.debug("No event loop available, skipping async callback")
                else:
                    # Synchronous callback
                    callback(event_type, event_data)
            except Exception as e:
                logger.warning(f"WebSocket callback failed: {e}")
    
    def ingest_event(self, raw_data: Dict[str, Any]) -> EventResponse:
        """Ingest and process a raw event."""
        try:
            # Validate and create base event
            event = Event(**raw_data)
            
            # Store in main events table
            event_id = self.database.store_event(event)
            
            # Process specialized events
            self._process_specialized_events(event)
            
            # Broadcast to WebSocket clients
            self._broadcast_event("event", event)
            
            logger.info(f"Successfully ingested event {event_id} for session {event.session_id}")
            return EventResponse(success=True)
            
        except Exception as e:
            logger.error(f"Failed to ingest event: {e}")
            self.failed_logger.log_failed_event(raw_data, e)
            return EventResponse(success=False, message=str(e))
    
    def _process_specialized_events(self, event: Event):
        """Process specialized event types."""
        # Process TodoWrite events
        todo_event = self.processor.process_todo_event(event)
        if todo_event:
            logger.debug(f"Detected TodoWrite event: {event.hook_event_name} for session {event.session_id[:8]}...")
            self._store_todo_event(todo_event)
            self._broadcast_event("todo", todo_event)
        
        # Process file operation events  
        file_event = self.processor.process_file_event(event)
        if file_event:
            self._store_file_event(file_event)
            self._broadcast_event("file", file_event)
    
    def _store_todo_event(self, todo_event: TodoEvent):
        """Store todos from a TodoEvent."""
        logger.info(f"Processing TodoEvent: type={todo_event.type}, hook={todo_event.hook_event_name}, session={todo_event.session_id[:8]}...")
        
        # For PreToolUse events, store todos from tool_input
        if todo_event.hook_event_name == "PreToolUse":
            todos = todo_event.todos_from_input
            if todos:
                logger.info(f"Storing {len(todos)} todo(s) from PreToolUse event:")
                for i, todo in enumerate(todos, 1):
                    logger.info(f"  [{i}] {todo.status}: {todo.content[:60]}{'...' if len(todo.content) > 60 else ''} (id: {todo.id})")
                
                self.database.store_todo_events(
                    todo_event.session_id,
                    todo_event.timestamp,
                    todo_event.tinstar_term_name,
                    todo_event.type,
                    [todo.model_dump() for todo in todos]
                )
            else:
                logger.debug("PreToolUse TodoEvent had no todos in tool_input")
        
        # For PostToolUse events, store both old and new todos if present
        elif todo_event.hook_event_name == "PostToolUse":
            new_todos = todo_event.new_todos
            old_todos = todo_event.old_todos
            
            if new_todos:
                logger.info(f"Storing {len(new_todos)} todo(s) from PostToolUse event (had {len(old_todos)} old todos):")
                for i, todo in enumerate(new_todos, 1):
                    logger.info(f"  [{i}] {todo.status}: {todo.content[:60]}{'...' if len(todo.content) > 60 else ''} (id: {todo.id})")
                
                self.database.store_todo_events(
                    todo_event.session_id,
                    todo_event.timestamp,
                    todo_event.tinstar_term_name,
                    todo_event.type,
                    [todo.model_dump() for todo in new_todos]
                )
            else:
                logger.debug("PostToolUse TodoEvent had no new todos in tool_response")
    
    def _store_file_event(self, file_event: FileEvent):
        """Store a file event."""
        self.database.store_file_event(
            file_event.session_id,
            file_event.timestamp,
            file_event.tinstar_term_name,
            file_event.file_path,
            file_event.operation,
            file_event.lines_added,
            file_event.lines_removed,
            file_event.content_preview
        )
    
    def query_events(self, filter_params: EventFilter) -> List[Dict[str, Any]]:
        """Query events with filtering."""
        return self.database.query_events(filter_params)
    
    def query_todos(self, filter_params: EventFilter) -> List[Dict[str, Any]]:
        """Query todo events with filtering."""
        return self.database.query_todos(filter_params)
    
    def query_files(self, filter_params: EventFilter) -> List[Dict[str, Any]]:
        """Query file events with filtering."""
        return self.database.query_files(filter_params)
    
    def clear_events(self) -> Dict[str, Any]:
        """Clear all events from database."""
        counts = self.database.clear_events()
        return {
            "success": True,
            "message": f"Deleted {counts['events']} events, {counts['todos']} todos, {counts['files']} files"
        }