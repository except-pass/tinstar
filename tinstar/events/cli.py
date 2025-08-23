"""
CLI commands for the Tinstar events system.
"""
import json
import requests
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import typer
from rich.console import Console
from rich.table import Table
from rich import print as rprint
from rich.progress import track

from .models import EventFilter
from .service import EventIngestionService


console = Console()
app = typer.Typer(name="events", help="Manage Tinstar events")


def get_service() -> EventIngestionService:
    """Get the events service instance."""
    return EventIngestionService()


@app.command("list")
def list_events(
    session: Optional[str] = typer.Option(None, "--session", "-s", help="Filter by session ID"),
    start: Optional[str] = typer.Option(None, "--start", help="Start time (ISO 8601)"),
    end: Optional[str] = typer.Option(None, "--end", help="End time (ISO 8601)"),
    term: Optional[str] = typer.Option(None, "--term", "-t", help="Filter by terminal name"),
    event_type: Optional[str] = typer.Option(None, "--type", help="Filter by event type"),
    limit: int = typer.Option(50, "--limit", "-l", help="Maximum number of events to show")
):
    """List events with optional filtering."""
    try:
        service = get_service()
        filter_params = EventFilter(
            session_id=session,
            start_time=start,
            end_time=end,
            tinstar_term_name=term,
            event_type=event_type
        )
        
        events = service.query_events(filter_params)
        
        if not events:
            console.print("No events found matching the criteria.", style="yellow")
            return
        
        # Show only the requested number of events
        events = events[:limit]
        
        # Create table
        table = Table(title=f"Events ({len(events)} shown)")
        table.add_column("Timestamp", style="cyan")
        table.add_column("Session ID", style="green")
        table.add_column("Hook Event", style="magenta")
        table.add_column("Tool", style="blue")
        table.add_column("Terminal", style="yellow")
        
        for event in events:
            timestamp = event.get('timestamp', '')
            session_id = event.get('session_id', '')[:8] + "..." if event.get('session_id') else ''
            hook_event = event.get('hook_event_name', '')
            tool_name = event.get('tool_name', '') or 'N/A'
            term_name = event.get('tinstar_term_name', '') or 'N/A'
            
            table.add_row(timestamp, session_id, hook_event, tool_name, term_name)
        
        console.print(table)
        
    except Exception as e:
        console.print(f"Error listing events: {e}", style="red")
        raise typer.Exit(1)


@app.command("todos")
def list_todos(
    session: Optional[str] = typer.Option(None, "--session", "-s", help="Filter by session ID"),
    start: Optional[str] = typer.Option(None, "--start", help="Start time (ISO 8601)"),
    end: Optional[str] = typer.Option(None, "--end", help="End time (ISO 8601)"),
    term: Optional[str] = typer.Option(None, "--term", "-t", help="Filter by terminal name"),
    limit: int = typer.Option(50, "--limit", "-l", help="Maximum number of todos to show")
):
    """List todo events with optional filtering."""
    try:
        service = get_service()
        filter_params = EventFilter(
            session_id=session,
            start_time=start,
            end_time=end,
            tinstar_term_name=term
        )
        
        todos = service.query_todos(filter_params)
        
        if not todos:
            console.print("No todo events found matching the criteria.", style="yellow")
            return
        
        # Show only the requested number of todos
        todos = todos[:limit]
        
        # Create table
        table = Table(title=f"Todo Events ({len(todos)} shown)")
        table.add_column("Timestamp", style="cyan")
        table.add_column("Session ID", style="green")
        table.add_column("Type", style="magenta")
        table.add_column("Todo ID", style="blue")
        table.add_column("Status", style="yellow")
        table.add_column("Content", style="white")
        
        for todo in todos:
            timestamp = todo.get('timestamp', '')
            session_id = todo.get('session_id', '')[:8] + "..." if todo.get('session_id') else ''
            todo_type = todo.get('type', '')
            todo_id = todo.get('todo_id', '')
            status = todo.get('status', '')
            content = todo.get('content', '')[:50] + "..." if len(todo.get('content', '')) > 50 else todo.get('content', '')
            
            # Color code status
            status_color = {
                'pending': 'white',
                'in_progress': 'yellow',
                'completed': 'green'
            }.get(status, 'white')
            
            table.add_row(
                timestamp, 
                session_id, 
                todo_type, 
                todo_id, 
                f"[{status_color}]{status}[/{status_color}]", 
                content
            )
        
        console.print(table)
        
    except Exception as e:
        console.print(f"Error listing todos: {e}", style="red")
        raise typer.Exit(1)


@app.command("files")
def list_files(
    session: Optional[str] = typer.Option(None, "--session", "-s", help="Filter by session ID"),
    start: Optional[str] = typer.Option(None, "--start", help="Start time (ISO 8601)"),
    end: Optional[str] = typer.Option(None, "--end", help="End time (ISO 8601)"),
    term: Optional[str] = typer.Option(None, "--term", "-t", help="Filter by terminal name"),
    limit: int = typer.Option(50, "--limit", "-l", help="Maximum number of file events to show")
):
    """List file events with optional filtering."""
    try:
        service = get_service()
        filter_params = EventFilter(
            session_id=session,
            start_time=start,
            end_time=end,
            tinstar_term_name=term
        )
        
        files = service.query_files(filter_params)
        
        if not files:
            console.print("No file events found matching the criteria.", style="yellow")
            return
        
        # Show only the requested number of file events
        files = files[:limit]
        
        # Create table
        table = Table(title=f"File Events ({len(files)} shown)")
        table.add_column("Timestamp", style="cyan")
        table.add_column("Session ID", style="green")
        table.add_column("Operation", style="magenta")
        table.add_column("File Path", style="blue")
        table.add_column("Lines +/-", style="yellow")
        
        for file_event in files:
            timestamp = file_event.get('timestamp', '')
            session_id = file_event.get('session_id', '')[:8] + "..." if file_event.get('session_id') else ''
            operation = file_event.get('operation', '')
            file_path = file_event.get('file_path', '')
            
            # Format line changes
            lines_added = file_event.get('lines_added')
            lines_removed = file_event.get('lines_removed')
            if lines_added is not None or lines_removed is not None:
                added_str = f"+{lines_added}" if lines_added is not None else ""
                removed_str = f"-{lines_removed}" if lines_removed is not None else ""
                lines_change = f"{added_str}/{removed_str}".strip('/')
            else:
                lines_change = "N/A"
            
            # Truncate long file paths
            if len(file_path) > 40:
                file_path = "..." + file_path[-37:]
            
            table.add_row(timestamp, session_id, operation, file_path, lines_change)
        
        console.print(table)
        
    except Exception as e:
        console.print(f"Error listing file events: {e}", style="red")
        raise typer.Exit(1)


@app.command("clear")
def clear_events(
    confirm: bool = typer.Option(False, "--confirm", help="Confirm deletion without prompt")
):
    """Clear all events from the database."""
    if not confirm:
        confirm_delete = typer.confirm("Are you sure you want to delete ALL events? This cannot be undone.")
        if not confirm_delete:
            console.print("Operation cancelled.", style="yellow")
            return
    
    try:
        service = get_service()
        result = service.clear_events()
        
        if result['success']:
            console.print(f"✅ {result['message']}", style="green")
        else:
            console.print(f"❌ Failed to clear events: {result.get('message', 'Unknown error')}", style="red")
            raise typer.Exit(1)
            
    except Exception as e:
        console.print(f"Error clearing events: {e}", style="red")
        raise typer.Exit(1)


@app.command("stats")
def show_stats():
    """Show event statistics."""
    try:
        service = get_service()
        
        # Get counts for different event types
        all_events = service.query_events(EventFilter())
        all_todos = service.query_todos(EventFilter())
        all_files = service.query_files(EventFilter())
        
        # Count by session
        sessions = {}
        for event in all_events:
            session_id = event.get('session_id')
            if session_id:
                sessions[session_id] = sessions.get(session_id, 0) + 1
        
        # Count by tool
        tools = {}
        for event in all_events:
            tool_name = event.get('tool_name', 'N/A')
            tools[tool_name] = tools.get(tool_name, 0) + 1
        
        # Create statistics table
        stats_table = Table(title="Event Statistics")
        stats_table.add_column("Metric", style="cyan")
        stats_table.add_column("Count", style="green")
        
        stats_table.add_row("Total Events", str(len(all_events)))
        stats_table.add_row("Todo Events", str(len(all_todos)))
        stats_table.add_row("File Events", str(len(all_files)))
        stats_table.add_row("Unique Sessions", str(len(sessions)))
        
        console.print(stats_table)
        
        # Show top sessions
        if sessions:
            top_sessions = sorted(sessions.items(), key=lambda x: x[1], reverse=True)[:5]
            session_table = Table(title="Top Sessions by Event Count")
            session_table.add_column("Session ID", style="cyan")
            session_table.add_column("Event Count", style="green")
            
            for session_id, count in top_sessions:
                short_id = session_id[:8] + "..." if len(session_id) > 8 else session_id
                session_table.add_row(short_id, str(count))
            
            console.print(session_table)
        
        # Show tool usage
        if tools:
            top_tools = sorted(tools.items(), key=lambda x: x[1], reverse=True)[:10]
            tool_table = Table(title="Tool Usage")
            tool_table.add_column("Tool", style="cyan")
            tool_table.add_column("Usage Count", style="green")
            
            for tool, count in top_tools:
                tool_table.add_row(tool, str(count))
            
            console.print(tool_table)
        
    except Exception as e:
        console.print(f"Error generating statistics: {e}", style="red")
        raise typer.Exit(1)


def _read_activity_log(log_file: Optional[str] = None) -> List[Dict]:
    """Read events from activity log file."""
    if not log_file:
        log_file = str(Path.home() / ".tinstar" / "logs" / "activity-log.jsonl")
    
    log_path = Path(log_file)
    if not log_path.exists():
        console.print(f"❌ Log file not found: {log_file}", style="red")
        raise typer.Exit(1)
    
    events = []
    with open(log_path, 'r') as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                events.append(event)
            except json.JSONDecodeError as e:
                console.print(f"⚠️  Skipping invalid JSON on line {line_num}: {e}", style="yellow")
                continue
    
    return events


def _find_matching_sessions(events: List[Dict], partial_id: str) -> List[str]:
    """Find session IDs that match the partial ID."""
    all_sessions = set()
    for event in events:
        session_id = event.get('session_id')
        if session_id:
            all_sessions.add(session_id)
    
    # Find matches
    matches = [sid for sid in all_sessions if sid.startswith(partial_id)]
    return sorted(matches)


@app.command("sessions")
def list_sessions(
    log_file: Optional[str] = typer.Option(None, "--file", "-f", help="Path to activity log file")
):
    """List all available session IDs from the activity log."""
    try:
        events = _read_activity_log(log_file)
        
        if not events:
            console.print("No events found in activity log.", style="yellow")
            return
        
        # Group events by session
        sessions: Dict[str, Dict] = {}
        for event in events:
            session_id = event.get('session_id')
            if not session_id:
                continue
                
            if session_id not in sessions:
                sessions[session_id] = {
                    'count': 0,
                    'first_timestamp': event.get('timestamp', ''),
                    'last_timestamp': event.get('timestamp', ''),
                    'terminal_names': set(),
                    'tool_names': set()
                }
            
            session_data = sessions[session_id]
            session_data['count'] += 1
            
            # Update timestamp range
            timestamp = event.get('timestamp', '')
            if timestamp:
                if not session_data['first_timestamp'] or timestamp < session_data['first_timestamp']:
                    session_data['first_timestamp'] = timestamp
                if not session_data['last_timestamp'] or timestamp > session_data['last_timestamp']:
                    session_data['last_timestamp'] = timestamp
            
            # Track terminal names and tools
            if event.get('tinstar_term_name'):
                session_data['terminal_names'].add(event['tinstar_term_name'])
            if event.get('tool_name'):
                session_data['tool_names'].add(event['tool_name'])
        
        # Create table
        table = Table(title=f"Available Sessions ({len(sessions)} total)")
        table.add_column("Session ID", style="cyan")
        table.add_column("Events", style="green")
        table.add_column("First Event", style="yellow")
        table.add_column("Last Event", style="yellow")
        table.add_column("Terminals", style="magenta")
        table.add_column("Tools", style="blue")
        
        # Sort by last timestamp (most recent first)
        sorted_sessions = sorted(
            sessions.items(), 
            key=lambda x: x[1]['last_timestamp'], 
            reverse=True
        )
        
        for session_id, data in sorted_sessions:
            # Truncate session ID for display
            short_id = session_id[:8] + "..." if len(session_id) > 8 else session_id
            
            # Format timestamps
            first_time = data['first_timestamp'][:16] if data['first_timestamp'] else 'N/A'
            last_time = data['last_timestamp'][:16] if data['last_timestamp'] else 'N/A'
            
            # Format terminal names and tools
            terminals = ', '.join(sorted(data['terminal_names']))[:30]
            if len(terminals) > 30:
                terminals += "..."
            
            tools = ', '.join(sorted(data['tool_names']))[:30] 
            if len(tools) > 30:
                tools += "..."
            
            table.add_row(
                short_id,
                str(data['count']),
                first_time,
                last_time,
                terminals or 'N/A',
                tools or 'N/A'
            )
        
        console.print(table)
        console.print(f"\n💡 Use 'tinstar events replay <session_id>' to replay events from a session", style="dim")
        console.print(f"   You can use partial session IDs (e.g., '{sorted_sessions[0][0][:8]}')", style="dim")
        
    except Exception as e:
        console.print(f"❌ Error reading activity log: {e}", style="red")
        raise typer.Exit(1)


def _get_endpoint_for_event_type(event_type: str) -> str:
    """Map event type to the correct API endpoint."""
    endpoint_map = {
        'pretooluse': '/api/events/pre_tool_use',
        'posttooluse': '/api/events/post_tool_use',
        'todowrite': '/api/events/todowrite',
        'notification': '/api/events/notification',
        'stop': '/api/events/stop',
        'subagentstop': '/api/events/subagent_stop',
        'userpromptsubmit': '/api/events/user_prompt'
    }
    
    return endpoint_map.get(event_type.lower(), '/api/events/pre_tool_use')


@app.command("replay")
def replay_events(
    partial_session_id: str = typer.Argument(..., help="Partial or full session ID to replay"),
    server_url: str = typer.Option("http://localhost:3002", "--server", "-s", help="Server URL"),
    log_file: Optional[str] = typer.Option(None, "--file", "-f", help="Path to activity log file"),
    dry_run: bool = typer.Option(False, "--dry-run", "-n", help="Show events without sending"),
    limit: int = typer.Option(0, "--limit", "-l", help="Limit number of events to replay (0 = all)")
):
    """Replay events from a session by sending them to the server via HTTP."""
    try:
        events = _read_activity_log(log_file)
        
        if not events:
            console.print("No events found in activity log.", style="yellow")
            return
        
        # Find matching sessions
        matches = _find_matching_sessions(events, partial_session_id)
        
        if not matches:
            console.print(f"❌ No sessions found matching '{partial_session_id}'", style="red")
            console.print("💡 Use 'tinstar events sessions' to see available sessions", style="dim")
            raise typer.Exit(1)
        
        if len(matches) > 1:
            console.print(f"❌ Multiple sessions match '{partial_session_id}':", style="red")
            for match in matches:
                short_id = match[:8] + "..." if len(match) > 8 else match
                console.print(f"  {short_id} ({match})", style="yellow")
            console.print("💡 Use a longer partial ID to be more specific", style="dim")
            raise typer.Exit(1)
        
        # Get the matched session
        session_id = matches[0]
        console.print(f"📋 Replaying events from session: {session_id[:8]}...", style="green")
        
        # Filter events for this session
        session_events = [e for e in events if e.get('session_id') == session_id]
        
        if not session_events:
            console.print(f"❌ No events found for session {session_id}", style="red")
            return
        
        # Apply limit if specified
        if limit > 0:
            session_events = session_events[:limit]
            console.print(f"🔢 Limited to first {limit} events", style="yellow")
        
        console.print(f"📊 Found {len(session_events)} events to replay", style="green")
        
        if dry_run:
            console.print("🔍 DRY RUN - Events that would be replayed:", style="cyan")
            table = Table()
            table.add_column("#", style="dim")
            table.add_column("Type", style="magenta")
            table.add_column("Tool", style="blue")
            table.add_column("Timestamp", style="cyan")
            table.add_column("Endpoint", style="yellow")
            
            for i, event in enumerate(session_events, 1):
                event_type = event.get('type', 'unknown')
                tool_name = event.get('tool_name', 'N/A')
                timestamp = event.get('timestamp', '')[:16]
                endpoint = _get_endpoint_for_event_type(event_type)
                
                table.add_row(
                    str(i), 
                    event_type, 
                    tool_name, 
                    timestamp,
                    endpoint
                )
            
            console.print(table)
            console.print(f"🚀 Run without --dry-run to replay these events to {server_url}", style="dim")
            return
        
        # Replay events to server
        success_count = 0
        error_count = 0
        
        console.print(f"🚀 Sending events to {server_url}...", style="green")
        
        for i, event in enumerate(track(session_events, description="Replaying events..."), 1):
            try:
                # Determine the correct endpoint
                event_type = event.get('type', 'PreToolUse')
                endpoint = _get_endpoint_for_event_type(event_type)
                url = f"{server_url}{endpoint}"
                
                # Send event to server
                response = requests.post(
                    url,
                    json=event,
                    headers={'Content-Type': 'application/json'},
                    timeout=10
                )
                
                if response.status_code == 200:
                    success_count += 1
                else:
                    error_count += 1
                    console.print(f"⚠️  Event {i}: HTTP {response.status_code} - {response.text[:100]}", style="yellow")
                    
            except Exception as e:
                error_count += 1
                console.print(f"⚠️  Event {i}: Error - {str(e)[:100]}", style="yellow")
        
        # Summary
        if error_count == 0:
            console.print(f"✅ Replay completed successfully: {success_count} events sent", style="green")
        else:
            console.print(f"⚠️  Replay completed with errors: {success_count} successful, {error_count} failed", style="yellow")
        
        console.print(f"💡 Check server logs or use 'tinstar events list' to see replayed events", style="dim")
        
    except Exception as e:
        console.print(f"❌ Error during replay: {e}", style="red")
        raise typer.Exit(1)


if __name__ == "__main__":
    app()