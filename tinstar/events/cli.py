"""
CLI commands for the Tinstar events system.
"""
import json
from datetime import datetime
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table
from rich import print as rprint

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


if __name__ == "__main__":
    app()