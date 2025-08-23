"""
Comprehensive tests for the Tinstar events system.
"""
import json
import pytest
import tempfile
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

from .database import EventsDatabase
from .models import Event, EventFilter, Todo, TodoEvent, FileEvent
from .service import EventIngestionService, EventProcessor


class TestEventModels:
    """Test event model validation and functionality."""
    
    def test_event_validation_valid(self):
        """Test valid event creation."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PreToolUse",
            tool_name="TodoWrite"
        )
        assert event.session_id
        assert event.timestamp
        assert event.hook_event_name == "PreToolUse"
    
    def test_event_validation_invalid_session_id(self):
        """Test invalid session ID validation."""
        with pytest.raises(ValueError, match="session_id must be a valid UUID"):
            Event(
                session_id="invalid-uuid",
                timestamp=datetime.now().isoformat(),
                hook_event_name="PreToolUse"
            )
    
    def test_event_validation_invalid_timestamp(self):
        """Test invalid timestamp validation."""
        with pytest.raises(ValueError, match="timestamp must be valid ISO 8601"):
            Event(
                session_id=str(uuid.uuid4()),
                timestamp="invalid-timestamp",
                hook_event_name="PreToolUse"
            )
    
    def test_event_validation_invalid_hook_event_name(self):
        """Test invalid hook event name validation."""
        with pytest.raises(ValueError, match="hook_event_name must be one of"):
            Event(
                session_id=str(uuid.uuid4()),
                timestamp=datetime.now().isoformat(),
                hook_event_name="InvalidEvent"
            )
    
    def test_event_validation_user_prompt_submit(self):
        """Test UserPromptSubmit hook event name validation."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="UserPromptSubmit"
        )
        assert event.hook_event_name == "UserPromptSubmit"
    
    def test_todo_auto_id_generation(self):
        """Test Todo auto-generates ID when not provided."""
        todo = Todo(content="Test todo", status="pending")
        assert todo.id is not None
        assert len(todo.id) == 8  # Short UUID format
        
        # Test explicit ID is preserved
        todo_with_id = Todo(id="explicit123", content="Test todo", status="pending")
        assert todo_with_id.id == "explicit123"
    
    def test_todo_event_properties(self):
        """Test TodoEvent property extraction."""
        session_id = str(uuid.uuid4())
        timestamp = datetime.now().isoformat()
        
        # Test PreToolUse event
        pre_event = TodoEvent(
            session_id=session_id,
            timestamp=timestamp,
            hook_event_name="PreToolUse",
            tool_name="TodoWrite",
            tool_input={
                "todos": [
                    {"id": "1", "content": "Test todo", "status": "pending"}
                ]
            },
            type="new"
        )
        
        todos = pre_event.todos_from_input
        assert len(todos) == 1
        assert todos[0].id == "1"
        assert todos[0].content == "Test todo"
        assert todos[0].status == "pending"
        
        # Test PostToolUse event
        post_event = TodoEvent(
            session_id=session_id,
            timestamp=timestamp,
            hook_event_name="PostToolUse",
            tool_name="TodoWrite",
            tool_response={
                "oldTodos": [
                    {"id": "1", "content": "Test todo", "status": "pending"}
                ],
                "newTodos": [
                    {"id": "1", "content": "Test todo", "status": "completed"}
                ]
            },
            type="update"
        )
        
        old_todos = post_event.old_todos
        new_todos = post_event.new_todos
        assert len(old_todos) == 1
        assert len(new_todos) == 1
        assert old_todos[0].status == "pending"
        assert new_todos[0].status == "completed"
    
    def test_file_event_validation(self):
        """Test FileEvent validation."""
        file_event = FileEvent(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PostToolUse",
            file_path="/path/to/file.py",
            operation="edit",
            lines_added=10,
            lines_removed=5,
            content_preview="def test():\n    pass"
        )
        
        assert file_event.file_path == "/path/to/file.py"
        assert file_event.operation == "edit"
        assert file_event.lines_added == 10
        assert file_event.lines_removed == 5
    
    def test_file_event_content_preview_truncation(self):
        """Test content preview truncation."""
        long_content = "x" * 250
        
        file_event = FileEvent(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PostToolUse",
            file_path="/path/to/file.py",
            operation="write",
            content_preview=long_content
        )
        
        assert len(file_event.content_preview) == 200


class TestEventsDatabase:
    """Test database operations."""
    
    @pytest.fixture
    def temp_db(self):
        """Create temporary database for testing."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = Path(f.name)
        
        db = EventsDatabase(db_path)
        yield db
        db.close()
        db_path.unlink()
    
    def test_store_event(self, temp_db):
        """Test storing an event."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PreToolUse",
            tool_name="TodoWrite"
        )
        
        event_id = temp_db.store_event(event)
        assert event_id > 0
    
    def test_store_todo_events(self, temp_db):
        """Test storing todo events."""
        session_id = str(uuid.uuid4())
        timestamp = datetime.now().isoformat()
        
        todos = [
            {"id": "1", "content": "Test todo 1", "status": "pending"},
            {"id": "2", "content": "Test todo 2", "status": "in_progress"}
        ]
        
        temp_db.store_todo_events(session_id, timestamp, None, "new", todos)
        
        # Query todos back
        filter_params = EventFilter(session_id=session_id)
        stored_todos = temp_db.query_todos(filter_params)
        
        assert len(stored_todos) == 2
        assert stored_todos[0]['todo_id'] == "1"
        assert stored_todos[1]['todo_id'] == "2"
    
    def test_store_file_event(self, temp_db):
        """Test storing file events."""
        session_id = str(uuid.uuid4())
        timestamp = datetime.now().isoformat()
        
        temp_db.store_file_event(
            session_id, timestamp, None, "/path/to/file.py",
            "edit", 10, 5, "def test():"
        )
        
        # Query files back
        filter_params = EventFilter(session_id=session_id)
        stored_files = temp_db.query_files(filter_params)
        
        assert len(stored_files) == 1
        assert stored_files[0]['file_path'] == "/path/to/file.py"
        assert stored_files[0]['operation'] == "edit"
        assert stored_files[0]['lines_added'] == 10
    
    def test_query_events_filtering(self, temp_db):
        """Test event querying with filters."""
        session_id_1 = str(uuid.uuid4())
        session_id_2 = str(uuid.uuid4())
        base_time = datetime.now()
        
        # Create events for different sessions and times
        events = [
            Event(
                session_id=session_id_1,
                timestamp=base_time.isoformat(),
                hook_event_name="PreToolUse",
                tinstar_term_name="term1"
            ),
            Event(
                session_id=session_id_2,
                timestamp=(base_time + timedelta(minutes=1)).isoformat(),
                hook_event_name="PostToolUse",
                tinstar_term_name="term2"
            )
        ]
        
        for event in events:
            temp_db.store_event(event)
        
        # Test session filtering
        filter_params = EventFilter(session_id=session_id_1)
        results = temp_db.query_events(filter_params)
        assert len(results) == 1
        assert results[0]['session_id'] == session_id_1
        
        # Test terminal name filtering
        filter_params = EventFilter(tinstar_term_name="term2")
        results = temp_db.query_events(filter_params)
        assert len(results) == 1
        assert results[0]['tinstar_term_name'] == "term2"
    
    def test_clear_events(self, temp_db):
        """Test clearing all events."""
        # Add some test data
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PreToolUse"
        )
        temp_db.store_event(event)
        
        # Clear events
        counts = temp_db.clear_events()
        assert counts['events'] == 1
        
        # Verify no events remain
        filter_params = EventFilter()
        results = temp_db.query_events(filter_params)
        assert len(results) == 0


class TestEventProcessor:
    """Test event processing logic."""
    
    def test_process_todo_event_new(self):
        """Test processing new todo list event."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PostToolUse",
            tool_name="TodoWrite",
            tool_input={
                "todos": [{"id": "1", "content": "Test", "status": "pending"}]
            },
            tool_response={
                "oldTodos": [],
                "newTodos": [{"id": "1", "content": "Test", "status": "pending"}]
            }
        )
        
        todo_event = EventProcessor.process_todo_event(event)
        assert todo_event is not None
        assert todo_event.type == "new"
        assert len(todo_event.new_todos) == 1
    
    def test_process_todo_event_update(self):
        """Test processing todo list update event."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PostToolUse",
            tool_name="TodoWrite",
            tool_response={
                "oldTodos": [{"id": "1", "content": "Test", "status": "pending"}],
                "newTodos": [{"id": "1", "content": "Test", "status": "completed"}]
            }
        )
        
        todo_event = EventProcessor.process_todo_event(event)
        assert todo_event is not None
        assert todo_event.type == "update"
        assert len(todo_event.old_todos) == 1
        assert len(todo_event.new_todos) == 1
    
    def test_process_file_event(self):
        """Test processing file operation events."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PostToolUse",
            tool_name="Edit",
            tool_input={
                "file_path": "/path/to/file.py",
                "old_string": "old code",
                "new_string": "new code"
            }
        )
        
        file_event = EventProcessor.process_file_event(event)
        assert file_event is not None
        assert file_event.file_path == "/path/to/file.py"
        assert file_event.operation == "edit"
    
    def test_process_non_todo_event(self):
        """Test processing non-TodoWrite events."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PreToolUse",
            tool_name="Read"
        )
        
        todo_event = EventProcessor.process_todo_event(event)
        assert todo_event is None
    
    def test_get_content_preview_write(self):
        """Test content preview extraction for Write operations."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PostToolUse",
            tool_name="Write",
            tool_input={
                "file_path": "/test.py",
                "content": "def test():\n    pass\n    return True"
            }
        )
        
        preview = EventProcessor._get_content_preview(event)
        assert preview == "def test():\n    pass\n    return True"
    
    def test_get_content_preview_edit(self):
        """Test content preview extraction for Edit operations."""
        event = Event(
            session_id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            hook_event_name="PostToolUse",
            tool_name="Edit",
            tool_input={
                "file_path": "/test.py",
                "old_string": "old",
                "new_string": "new implementation"
            }
        )
        
        preview = EventProcessor._get_content_preview(event)
        assert preview == "new implementation"


class TestEventIngestionService:
    """Test event ingestion service."""
    
    @pytest.fixture
    def temp_service(self):
        """Create service with temporary database."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = Path(f.name)
        
        db = EventsDatabase(db_path)
        service = EventIngestionService(db)
        yield service
        db.close()
        db_path.unlink()
    
    def test_ingest_basic_event(self, temp_service):
        """Test ingesting a basic event."""
        raw_data = {
            "session_id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "hook_event_name": "PreToolUse",
            "tool_name": "Read"
        }
        
        response = temp_service.ingest_event(raw_data)
        assert response.success is True
    
    def test_ingest_malformed_event(self, temp_service):
        """Test ingesting malformed event data."""
        raw_data = {
            "session_id": "invalid-uuid",
            "timestamp": "invalid-timestamp",
            "hook_event_name": "InvalidEvent"
        }
        
        response = temp_service.ingest_event(raw_data)
        assert response.success is False
        assert "session_id must be a valid UUID" in response.message
    
    def test_ingest_todo_event(self, temp_service):
        """Test ingesting TodoWrite events."""
        raw_data = {
            "session_id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "hook_event_name": "PreToolUse",
            "tool_name": "TodoWrite",
            "tool_input": {
                "todos": [
                    {"id": "1", "content": "Test todo", "status": "pending"}
                ]
            }
        }
        
        response = temp_service.ingest_event(raw_data)
        assert response.success is True
        
        # Verify todo was stored
        filter_params = EventFilter(session_id=raw_data["session_id"])
        todos = temp_service.query_todos(filter_params)
        assert len(todos) == 1
        assert todos[0]['todo_id'] == "1"
    
    def test_todo_logging(self, temp_service, caplog):
        """Test that todo processing generates appropriate log messages."""
        import logging
        caplog.set_level(logging.INFO)
        
        raw_data = {
            "session_id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "hook_event_name": "PreToolUse",
            "tool_name": "TodoWrite",
            "tool_input": {
                "todos": [
                    {"content": "Short todo", "status": "pending"},
                    {"content": "This is a very long todo that should be truncated in the log output", "status": "in_progress"}
                ]
            }
        }
        
        response = temp_service.ingest_event(raw_data)
        assert response.success is True
        
        # Check that appropriate log messages were generated
        log_messages = [record.message for record in caplog.records if record.levelno >= logging.INFO]
        
        # Should have processing message
        processing_logs = [msg for msg in log_messages if "Processing TodoEvent" in msg]
        assert len(processing_logs) == 1
        assert "type=new, hook=PreToolUse" in processing_logs[0]
        
        # Should have storage message
        storage_logs = [msg for msg in log_messages if "Storing" in msg and "todo(s) from PreToolUse" in msg]
        assert len(storage_logs) == 1
        assert "Storing 2 todo(s)" in storage_logs[0]
        
        # Should have individual todo messages
        todo_logs = [msg for msg in log_messages if msg.strip().startswith("[")]
        assert len(todo_logs) == 2
        assert "[1] pending: Short todo" in todo_logs[0]
        assert "[2] in_progress: This is a very long todo that should be truncated in the log..." in todo_logs[1]
    
    def test_ingest_file_event(self, temp_service):
        """Test ingesting file operation events."""
        raw_data = {
            "session_id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "hook_event_name": "PostToolUse",
            "tool_name": "Edit",
            "tool_input": {
                "file_path": "/test.py",
                "old_string": "old",
                "new_string": "new"
            }
        }
        
        response = temp_service.ingest_event(raw_data)
        assert response.success is True
        
        # Verify file event was stored
        filter_params = EventFilter(session_id=raw_data["session_id"])
        files = temp_service.query_files(filter_params)
        assert len(files) == 1
        assert files[0]['file_path'] == "/test.py"
    
    def test_websocket_callback(self, temp_service):
        """Test WebSocket callback functionality."""
        callback_calls = []
        
        def mock_callback(event_type, event_data):
            callback_calls.append((event_type, event_data))
        
        temp_service.add_websocket_callback(mock_callback)
        
        raw_data = {
            "session_id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "hook_event_name": "PreToolUse",
            "tool_name": "Read"
        }
        
        temp_service.ingest_event(raw_data)
        
        # Should have received one callback for the event
        assert len(callback_calls) == 1
        assert callback_calls[0][0] == "event"
    
    def test_async_websocket_callback(self, temp_service):
        """Test async WebSocket callback handling."""
        # Mock async callback function
        callback_calls = []
        
        async def mock_async_callback(event_type, event_data):
            callback_calls.append((event_type, event_data))
        
        # Add async callback
        temp_service.add_websocket_callback(mock_async_callback)
        
        # Test with no event loop (should handle gracefully)
        raw_data = {
            "session_id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "hook_event_name": "PreToolUse",
            "tool_name": "Read"
        }
        
        response = temp_service.ingest_event(raw_data)
        assert response.success is True
        
        # In test environment without running event loop, 
        # async callback should be skipped but not cause errors
        # (callback_calls would be empty since the async task can't run)
    
    def test_query_with_time_range(self, temp_service):
        """Test querying events with time range filters."""
        base_time = datetime.now()
        session_id = str(uuid.uuid4())
        
        # Create events at different times
        for i in range(3):
            raw_data = {
                "session_id": session_id,
                "timestamp": (base_time + timedelta(minutes=i)).isoformat(),
                "hook_event_name": "PreToolUse"
            }
            temp_service.ingest_event(raw_data)
        
        # Query with time range (should include events at minutes 1 and 2)
        filter_params = EventFilter(
            session_id=session_id,
            start_time=(base_time + timedelta(minutes=1)).isoformat(),
            end_time=(base_time + timedelta(minutes=3)).isoformat()
        )
        
        events = temp_service.query_events(filter_params)
        assert len(events) == 2  # Events at minutes 1 and 2
    
    def test_clear_events(self, temp_service):
        """Test clearing all events."""
        # Add test data
        raw_data = {
            "session_id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "hook_event_name": "PreToolUse"
        }
        temp_service.ingest_event(raw_data)
        
        # Clear events
        result = temp_service.clear_events()
        assert result['success'] is True
        assert "Deleted 1 events" in result['message']


if __name__ == "__main__":
    pytest.main([__file__])