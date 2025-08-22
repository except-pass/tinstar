"""
Example usage of the Tinstar events system.
"""
import json
import uuid
from datetime import datetime

from .service import EventIngestionService


def example_usage():
    """Demonstrate the events system with sample data."""
    print("🚀 Tinstar Events System Example")
    print("=" * 40)
    
    # Create service
    service = EventIngestionService()
    
    # Sample session ID
    session_id = str(uuid.uuid4())
    timestamp = datetime.now().isoformat()
    
    print(f"📝 Session ID: {session_id[:8]}...")
    print()
    
    # 1. Ingest a basic PreToolUse event
    print("1. Ingesting PreToolUse event...")
    raw_event_1 = {
        "session_id": session_id,
        "timestamp": timestamp,
        "hook_event_name": "PreToolUse",
        "tool_name": "Read",
        "tool_input": {"file_path": "/example/file.py"},
        "tinstar_term_name": "tinstar-demo"
    }
    
    response = service.ingest_event(raw_event_1)
    print(f"   ✅ Success: {response.success}")
    
    # 2. Ingest a TodoWrite event (new todo list)
    print("\n2. Ingesting TodoWrite event (new list)...")
    raw_event_2 = {
        "session_id": session_id,
        "timestamp": timestamp,
        "hook_event_name": "PostToolUse",
        "tool_name": "TodoWrite",
        "tool_input": {
            "todos": [
                {"id": "1", "content": "Read the design document", "status": "completed"},
                {"id": "2", "content": "Implement the events system", "status": "in_progress"},
                {"id": "3", "content": "Write comprehensive tests", "status": "pending"}
            ]
        },
        "tool_response": {
            "oldTodos": [],
            "newTodos": [
                {"id": "1", "content": "Read the design document", "status": "completed"},
                {"id": "2", "content": "Implement the events system", "status": "in_progress"},
                {"id": "3", "content": "Write comprehensive tests", "status": "pending"}
            ]
        },
        "tinstar_term_name": "tinstar-demo"
    }
    
    response = service.ingest_event(raw_event_2)
    print(f"   ✅ Success: {response.success}")
    
    # 3. Ingest a file operation event
    print("\n3. Ingesting file Edit event...")
    raw_event_3 = {
        "session_id": session_id,
        "timestamp": timestamp,
        "hook_event_name": "PostToolUse",
        "tool_name": "Edit",
        "tool_input": {
            "file_path": "/example/models.py",
            "old_string": "class Event:",
            "new_string": "class Event(BaseModel):"
        },
        "tinstar_term_name": "tinstar-demo"
    }
    
    response = service.ingest_event(raw_event_3)
    print(f"   ✅ Success: {response.success}")
    
    # 4. Query events back
    print("\n4. Querying stored events...")
    from .models import EventFilter
    
    filter_params = EventFilter(session_id=session_id)
    events = service.query_events(filter_params)
    print(f"   📊 Found {len(events)} events")
    
    # 5. Query todos
    print("\n5. Querying todo events...")
    todos = service.query_todos(filter_params)
    print(f"   📋 Found {len(todos)} todo items")
    for todo in todos:
        status_emoji = {"pending": "⏳", "in_progress": "🔄", "completed": "✅"}.get(todo['status'], "❓")
        print(f"      {status_emoji} {todo['content']}")
    
    # 6. Query file events
    print("\n6. Querying file events...")
    files = service.query_files(filter_params)
    print(f"   📁 Found {len(files)} file operations")
    for file_event in files:
        print(f"      📝 {file_event['operation']}: {file_event['file_path']}")
    
    print("\n✨ Events system demonstration complete!")


if __name__ == "__main__":
    example_usage()