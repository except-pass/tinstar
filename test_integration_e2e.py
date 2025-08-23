"""
End-to-end integration test for Tinstar.

This test runs a complete integration scenario:
1. Sets up a temporary workdir and cleans the database
2. Copies real events from ~/.tinstar/logs/activity-log.jsonl
3. Replays events using the tinstar server
4. Validates server responses for notification, prompt, and todo list events
"""
import json
import multiprocessing
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from typing import Dict, List
import subprocess
import requests
import pytest

from tinstar.events.database import EventsDatabase
from tinstar.events.models import EventFilter
from tinstar.events.service import EventIngestionService
from tinstar.server import run_server


class TinstarTestServer:
    """Context manager for running Tinstar server during tests."""
    
    def __init__(self, host="127.0.0.1", port=None, debug=False):
        self.host = host
        # Use a different port for testing to avoid conflicts
        self.port = port or self._find_free_port()
        self.debug = debug
        self.process = None
        self.server_url = f"http://{host}:{self.port}"
    
    def _find_free_port(self):
        """Find a free port for testing."""
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('', 0))
            s.listen(1)
            port = s.getsockname()[1]
        return port
    
    def __enter__(self):
        """Start the server process."""
        # Start server in a separate process
        self.process = multiprocessing.Process(
            target=run_server,
            kwargs={"host": self.host, "port": self.port, "debug": self.debug}
        )
        self.process.start()
        
        # Wait for server to be ready
        max_retries = 50
        for i in range(max_retries):
            try:
                # Try both health endpoints
                response = requests.get(f"{self.server_url}/api/events/health", timeout=1)
                if response.status_code == 200:
                    break
            except:
                pass
            time.sleep(0.2)
        else:
            self.process.terminate()
            self.process.join()
            raise RuntimeError(f"Server failed to start on port {self.port}")
        
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Stop the server process."""
        if self.process:
            self.process.terminate()
            self.process.join(timeout=5)
            if self.process.is_alive():
                self.process.kill()
                self.process.join()


class TestEndToEndIntegration:
    """End-to-end integration tests for Tinstar."""
    
    @pytest.fixture
    def temp_workdir(self):
        """Create a temporary workdir for testing."""
        temp_dir = tempfile.mkdtemp(prefix="tinstar_test_")
        original_cwd = os.getcwd()
        
        # Create a basic project structure
        (Path(temp_dir) / "src").mkdir()
        (Path(temp_dir) / "tests").mkdir()
        (Path(temp_dir) / "README.md").write_text("Test project")
        (Path(temp_dir) / "src" / "main.py").write_text('print("Hello, World!")')
        
        yield temp_dir
        
        # Cleanup
        os.chdir(original_cwd)
        shutil.rmtree(temp_dir)
    
    @pytest.fixture
    def clean_database(self):
        """Ensure we start with a clean database."""
        # Clear the test database
        db = EventsDatabase()
        db.clear_events()
        db.close()
        yield
        # Clean up after test
        db = EventsDatabase()
        db.clear_events()
        db.close()
    
    @pytest.fixture
    def real_activity_log(self):
        """Get the path to real activity logs."""
        log_path = Path.home() / ".tinstar" / "logs" / "activity-log.jsonl"
        if not log_path.exists():
            pytest.skip("No real activity log found")
        return log_path
    
    def read_activity_log(self, log_path: Path, limit: int = 100) -> List[Dict]:
        """Read events from activity log file, limited to recent events."""
        events = []
        with open(log_path, 'r') as f:
            lines = f.readlines()
            # Take the most recent events
            recent_lines = lines[-limit:] if len(lines) > limit else lines
            
            for line in recent_lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    events.append(event)
                except json.JSONDecodeError:
                    continue
        return events
    
    def filter_events_by_types(self, events: List[Dict], event_types: List[str]) -> List[Dict]:
        """Filter events by specific types."""
        return [e for e in events if e.get('type') in event_types or e.get('hook_event_name') in event_types]
    
    def test_full_integration_workflow(self, temp_workdir, clean_database, real_activity_log):
        """Test complete end-to-end integration workflow."""
        # Step 1: Read real events from activity log
        all_events = self.read_activity_log(real_activity_log, limit=50)
        assert len(all_events) > 0, "No events found in activity log"
        
        # Step 2: Filter for specific event types we want to test
        target_event_types = [
            'TodoWrite', 'PreToolUse', 'PostToolUse', 
            'UserPromptSubmit', 'Notification', 'Stop'
        ]
        test_events = self.filter_events_by_types(all_events, target_event_types)
        assert len(test_events) > 0, "No target events found"
        
        print(f"Found {len(test_events)} events to replay")
        
        # Step 3: Start Tinstar server
        with TinstarTestServer() as server:
            # Step 4: Replay events to server
            replayed_events = self.replay_events_to_server(server.server_url, test_events)
            assert len(replayed_events) > 0, "No events were successfully replayed"
            
            # Give server time to process
            time.sleep(0.5)
            
            # Step 5: Validate server responses
            self.validate_server_responses(server.server_url, replayed_events)
    
    def replay_events_to_server(self, server_url: str, events: List[Dict]) -> List[Dict]:
        """Replay events to the server and return successfully sent events."""
        endpoint_map = {
            'pretooluse': '/api/events/pre_tool_use',
            'posttooluse': '/api/events/post_tool_use', 
            'todowrite': '/api/events/todowrite',
            'notification': '/api/events/notification',
            'stop': '/api/events/stop',
            'userpromptsubmit': '/api/events/user_prompt'
        }
        
        successfully_replayed = []
        
        for event in events:
            try:
                # Determine endpoint
                event_type = event.get('type', event.get('hook_event_name', 'PreToolUse'))
                endpoint = endpoint_map.get(event_type.lower(), '/api/events/pre_tool_use')
                url = f"{server_url}{endpoint}"
                
                # Send event
                response = requests.post(
                    url,
                    json=event,
                    headers={'Content-Type': 'application/json'},
                    timeout=10
                )
                
                if response.status_code == 200:
                    successfully_replayed.append(event)
                    print(f"✅ Replayed {event_type}: {response.status_code}")
                else:
                    print(f"⚠️ Failed {event_type}: {response.status_code} - {response.text}")
                    
            except Exception as e:
                print(f"❌ Error replaying event: {e}")
        
        return successfully_replayed
    
    def validate_server_responses(self, server_url: str, replayed_events: List[Dict]):
        """Validate that the server processed and stored events correctly."""
        service = EventIngestionService()
        
        # Get all events from database
        from tinstar.events.models import EventFilter
        all_stored_events = service.query_events(EventFilter())
        
        print(f"Found {len(all_stored_events)} events in database")
        
        # Validate we have events
        assert len(all_stored_events) > 0, "No events found in database after replay"
        
        # Check for specific event types
        todo_events = service.query_todos(EventFilter()) 
        file_events = service.query_files(EventFilter())
        
        print(f"Found {len(todo_events)} todo events, {len(file_events)} file events")
        
        # Validate TodoWrite events if any were replayed
        todowrite_events = [e for e in replayed_events if 
                           e.get('tool_name') == 'TodoWrite' or e.get('type') == 'TodoWrite']
        if todowrite_events:
            assert len(todo_events) > 0, "TodoWrite events were replayed but none found in database"
            
            # Validate todo structure
            for todo in todo_events[:3]:  # Check first few
                assert 'todo_id' in todo, "Todo missing ID"
                assert 'content' in todo, "Todo missing content"
                assert 'status' in todo, "Todo missing status"
                assert todo['status'] in ['pending', 'in_progress', 'completed'], f"Invalid status: {todo['status']}"
        
        # Validate session consistency
        session_ids = set(e.get('session_id') for e in all_stored_events if e.get('session_id'))
        replayed_session_ids = set(e.get('session_id') for e in replayed_events if e.get('session_id'))
        
        # At least some session IDs should match
        matching_sessions = session_ids.intersection(replayed_session_ids)
        assert len(matching_sessions) > 0, "No matching session IDs found between replayed and stored events"
        
        print(f"Validated {len(matching_sessions)} matching sessions")
        
        # Validate event timestamps
        for event in all_stored_events[:5]:  # Check first few
            assert 'timestamp' in event, "Event missing timestamp"
            # Should be valid ISO format
            try:
                from datetime import datetime
                datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00'))
            except:
                assert False, f"Invalid timestamp format: {event['timestamp']}"
    
    def test_notification_events(self, temp_workdir, clean_database, real_activity_log):
        """Test specific notification event handling."""
        # Read events and filter for notification events
        all_events = self.read_activity_log(real_activity_log, limit=100)
        notification_events = self.filter_events_by_types(all_events, ['Notification'])
        
        if not notification_events:
            pytest.skip("No notification events found in activity log")
        
        with TinstarTestServer() as server:
            # Replay notification events
            replayed = self.replay_events_to_server(server.server_url, notification_events)
            
            if replayed:
                # Validate notifications were stored
                service = EventIngestionService()
                stored_events = service.query_events(EventFilter())
                
                notification_stored = [e for e in stored_events if e.get('hook_event_name') == 'Notification']
                assert len(notification_stored) > 0, "Notification events not stored in database"
    
    def test_user_prompt_events(self, temp_workdir, clean_database, real_activity_log):
        """Test user prompt submission event handling."""
        all_events = self.read_activity_log(real_activity_log, limit=100)
        prompt_events = self.filter_events_by_types(all_events, ['UserPromptSubmit'])
        
        if not prompt_events:
            pytest.skip("No user prompt events found in activity log")
        
        with TinstarTestServer() as server:
            # Replay prompt events
            replayed = self.replay_events_to_server(server.server_url, prompt_events)
            
            if replayed:
                # Validate prompts were stored
                service = EventIngestionService()
                stored_events = service.query_events(EventFilter())
                
                prompt_stored = [e for e in stored_events if e.get('hook_event_name') == 'UserPromptSubmit']
                assert len(prompt_stored) > 0, "User prompt events not stored in database"
                
                # Check that prompt content exists
                for event in prompt_stored[:3]:
                    if 'prompt' in event:
                        assert len(event['prompt']) > 0, "Empty prompt content"
    
    def test_todo_list_lifecycle(self, temp_workdir, clean_database, real_activity_log):
        """Test todo list creation, updates, and completion workflow."""
        all_events = self.read_activity_log(real_activity_log, limit=200)
        todo_events = [e for e in all_events if e.get('tool_name') == 'TodoWrite']
        
        if not todo_events:
            pytest.skip("No TodoWrite events found in activity log")
        
        with TinstarTestServer() as server:
            # Replay todo events
            replayed = self.replay_events_to_server(server.server_url, todo_events)
            
            if replayed:
                time.sleep(0.5)  # Give server time to process
                
                # Validate todo lifecycle
                service = EventIngestionService()
                todo_records = service.query_todos(EventFilter())
                
                assert len(todo_records) > 0, "No todo records found in database"
                
                # Check for different todo statuses
                statuses = set(t.get('status') for t in todo_records)
                valid_statuses = {'pending', 'in_progress', 'completed'}
                
                assert statuses.issubset(valid_statuses), f"Invalid todo statuses found: {statuses - valid_statuses}"
                
                # Validate todo content
                for todo in todo_records[:5]:
                    assert todo.get('content'), "Todo missing content"
                    assert len(todo['content']) > 0, "Empty todo content"
                    assert todo.get('todo_id'), "Todo missing ID"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])