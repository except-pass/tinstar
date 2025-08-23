"""
CLI commands for the Tinstar session management system.
"""
import asyncio
import os
import subprocess
from typing import List, Optional

import typer
from rich.console import Console
from rich.table import Table
from rich import print as rprint

from .service import SessionService

console = Console()
app = typer.Typer(name="session", help="Manage Tinstar sessions")


def get_service() -> SessionService:
    """Get the session service instance."""
    return SessionService()


def _find_matching_sessions(service: SessionService, partial_id: str) -> List[str]:
    """Find session IDs that match the partial ID."""
    sessions = service.list_sessions()
    matches = [s.id for s in sessions if s.id.startswith(partial_id)]
    return matches


@app.command("list")
def list_sessions(
    project: Optional[str] = typer.Option(None, "--project", "-p", help="Filter by project name"),
    all_status: bool = typer.Option(False, "--all", help="Show sessions with all statuses")
):
    """List all sessions."""
    try:
        service = get_service()
        sessions = service.list_sessions(project=project)
        
        if not sessions:
            console.print("No active sessions found.", style="yellow")
            return
        
        # Create table
        table = Table(title=f"Sessions ({len(sessions)} found)")
        table.add_column("ID", style="cyan")
        table.add_column("Name", style="green")
        table.add_column("Project", style="blue")
        table.add_column("Status", style="magenta")
        table.add_column("Agent", style="yellow")
        table.add_column("Created", style="white")
        
        for session in sessions:
            short_id = session.id[:8] + "..."
            status_color = {
                'active': 'green',
                'stopped': 'red',
                'error': 'orange'
            }.get(session.status, 'white')
            
            table.add_row(
                short_id,
                session.name,
                session.project,
                f"[{status_color}]{session.status}[/{status_color}]",
                session.agent_type,
                session.created_at[:19]  # Show date and time only
            )
        
        console.print(table)
        
    except Exception as e:
        console.print(f"Error listing sessions: {e}", style="red")
        raise typer.Exit(1)


@app.command("create")
def create_session(
    project: Optional[str] = typer.Argument(None, help="Project name"),
    prompt: Optional[str] = typer.Option(None, "--prompt", help="Initial prompt for agent"),
    agent: str = typer.Option("claude", "--agent", help="Agent type to use")
):
    """Create a new session."""
    try:
        # Check if project was provided
        if not project:
            from ..projects.service import ProjectService
            project_service = ProjectService()
            available_projects = project_service.list_projects()
            
            console.print("❌ No project specified.", style="red")
            console.print()
            
            if available_projects:
                console.print("📋 Available projects:", style="cyan")
                for proj in available_projects:
                    console.print(f"  • {proj.name} ({proj.path})", style="white")
                console.print()
                console.print("💡 Create a session with:", style="green")
                console.print(f"   tinstar session create {available_projects[0].name}", style="dim")
            else:
                console.print("📋 No projects registered yet.", style="yellow")
                console.print()
                console.print("💡 Register a project first:", style="green")
                console.print("   tinstar project register /path/to/your/repo", style="dim")
            
            console.print()
            console.print("📚 Learn more: tinstar session create --help", style="dim")
            raise typer.Exit(1)
        
        service = get_service()
        
        # Run async function
        session = asyncio.run(service.create_session(
            project=project,
            initial_prompt=prompt,
            agent_type=agent
        ))
        
        console.print(f"✅ Session '{session.name}' created successfully!", style="green")
        console.print(f"   ID: {session.id}", style="cyan")
        console.print(f"   Project: {session.project}", style="blue")
        console.print(f"   Worktree: {session.worktree_path}", style="yellow")
        
        if session.initial_prompt:
            console.print(f"   Initial prompt: {session.initial_prompt[:100]}...", style="white")
        
    except Exception as e:
        console.print(f"Error creating session: {e}", style="red")
        raise typer.Exit(1)


@app.command("peek")
def peek_session(
    session_id: str = typer.Argument(..., help="Session ID"),
    lines: int = typer.Option(50, "--lines", "-l", help="Number of lines to show")
):
    """View session terminal output."""
    try:
        service = get_service()
        
        # Run async function
        peek_result = asyncio.run(service.peek_session(session_id, lines))
        
        if not peek_result:
            console.print("Session not found or no output available.", style="red")
            raise typer.Exit(1)
        
        console.print(f"📺 Terminal output for session {session_id[:8]}... (last {peek_result.line_count} lines):", style="cyan")
        console.print("─" * 80, style="dim")
        
        for line in peek_result.lines:
            console.print(line)
        
        console.print("─" * 80, style="dim")
        console.print(f"Captured at: {peek_result.timestamp[:19]}", style="dim")
        
    except Exception as e:
        console.print(f"Error peeking session: {e}", style="red")
        raise typer.Exit(1)


@app.command("send")
def send_to_session(
    partial_session_id: str = typer.Argument(..., help="Partial or full session ID"),
    text: str = typer.Argument(..., help="Text to send to session")
):
    """Send text to session terminal."""
    try:
        service = get_service()
        
        # Find matching sessions
        matches = _find_matching_sessions(service, partial_session_id)
        
        if not matches:
            console.print(f"❌ No sessions found matching '{partial_session_id}'", style="red")
            console.print("💡 Use 'tinstar session list' to see available sessions", style="dim")
            raise typer.Exit(1)
        
        if len(matches) > 1:
            console.print(f"❌ Multiple sessions match '{partial_session_id}':", style="red")
            for match in matches:
                session = service.get_session(match)
                if session:
                    short_id = match[:8] + "..."
                    console.print(f"  {short_id} - {session.name} ({session.project})", style="yellow")
            console.print("💡 Use a longer partial ID to be more specific", style="dim")
            raise typer.Exit(1)
        
        # Get the matched session ID
        session_id = matches[0]
        
        # Run async function
        success = asyncio.run(service.send_to_session(session_id, text))
        
        if success:
            console.print(f"✅ Text sent to session {session_id[:8]}...", style="green")
        else:
            console.print("Session not found.", style="red")
            raise typer.Exit(1)
        
    except Exception as e:
        console.print(f"Error sending text: {e}", style="red")
        raise typer.Exit(1)


@app.command("stop")
def terminate_session(
    partial_session_id: str = typer.Argument(..., help="Partial or full session ID"),
    confirm: bool = typer.Option(False, "--confirm", help="Skip confirmation prompt")
):
    """Terminate a session."""
    try:
        service = get_service()
        
        # Find matching sessions
        matches = _find_matching_sessions(service, partial_session_id)
        
        if not matches:
            console.print(f"❌ No sessions found matching '{partial_session_id}'", style="red")
            console.print("💡 Use 'tinstar session list' to see available sessions", style="dim")
            raise typer.Exit(1)
        
        if len(matches) > 1:
            console.print(f"❌ Multiple sessions match '{partial_session_id}':", style="red")
            for match in matches:
                session = service.get_session(match)
                if session:
                    short_id = match[:8] + "..."
                    console.print(f"  {short_id} - {session.name} ({session.project})", style="yellow")
            console.print("💡 Use a longer partial ID to be more specific", style="dim")
            raise typer.Exit(1)
        
        # Get the matched session
        session_id = matches[0]
        session = service.get_session(session_id)
        
        if not session:
            console.print("❌ Session not found", style="red")
            raise typer.Exit(1)
        
        if not confirm:
            confirm_terminate = typer.confirm(f"Are you sure you want to terminate session '{session.name}'?")
            if not confirm_terminate:
                console.print("Operation cancelled.", style="yellow")
                return
        
        # Run async function
        success = asyncio.run(service.terminate_session(session_id))
        
        if success:
            console.print(f"✅ Session '{session.name}' terminated successfully.", style="green")
        else:
            console.print("Failed to terminate session.", style="red")
            raise typer.Exit(1)
        
    except Exception as e:
        console.print(f"Error terminating session: {e}", style="red")
        raise typer.Exit(1)


@app.command("editor")
def open_in_editor(
    session_id: str = typer.Argument(..., help="Session ID"),
    file_path: str = typer.Argument(..., help="File path to open"),
    line: Optional[int] = typer.Option(None, "--line", help="Line number to jump to")
):
    """Open file in configured editor."""
    try:
        service = get_service()
        
        # Run async function
        success = asyncio.run(service.open_in_editor(session_id, file_path, line))
        
        if success:
            editor_type = service.config.get("editor", "cursor")
            line_info = f" at line {line}" if line else ""
            console.print(f"✅ File '{file_path}'{line_info} opened in {editor_type}.", style="green")
        else:
            console.print("Session not found or failed to open file.", style="red")
            raise typer.Exit(1)
        
    except Exception as e:
        console.print(f"Error opening file: {e}", style="red")
        raise typer.Exit(1)


@app.command("respond")
def respond_to_notification(
    session_id: str = typer.Argument(..., help="Session ID"),
    response: str = typer.Argument(..., help="Response type: approve_once, approve_always, deny")
):
    """Respond to agent notification."""
    valid_responses = ["approve_once", "approve_always", "deny"]
    
    if response not in valid_responses:
        console.print(f"Invalid response. Must be one of: {', '.join(valid_responses)}", style="red")
        raise typer.Exit(1)
    
    try:
        service = get_service()
        
        # Run async function
        success = asyncio.run(service.respond_to_notification(session_id, response))
        
        if success:
            console.print(f"✅ Response '{response}' sent to session {session_id[:8]}...", style="green")
        else:
            console.print("Session not found or failed to send response.", style="red")
            raise typer.Exit(1)
        
    except Exception as e:
        console.print(f"Error sending response: {e}", style="red")
        raise typer.Exit(1)


@app.command("health")
def check_health(
    session_id: Optional[str] = typer.Argument(None, help="Session ID (optional, checks all if not provided)")
):
    """Check session health."""
    try:
        service = get_service()
        
        if session_id:
            # Check specific session
            healthy = asyncio.run(service.health_check(session_id))
            status = "healthy" if healthy else "unhealthy"
            color = "green" if healthy else "red"
            console.print(f"Session {session_id[:8]}... is {status}", style=color)
        else:
            # Check all sessions
            sessions = service.list_sessions()
            
            if not sessions:
                console.print("No active sessions found.", style="yellow")
                return
            
            table = Table(title="Session Health Check")
            table.add_column("Session ID", style="cyan")
            table.add_column("Name", style="green")
            table.add_column("Status", style="magenta")
            table.add_column("Health", style="yellow")
            
            for session in sessions:
                healthy = asyncio.run(service.health_check(session.id))
                health_status = "healthy" if healthy else "unhealthy"
                health_color = "green" if healthy else "red"
                
                table.add_row(
                    session.id[:8] + "...",
                    session.name,
                    session.status,
                    f"[{health_color}]{health_status}[/{health_color}]"
                )
            
            console.print(table)
        
    except Exception as e:
        console.print(f"Error checking health: {e}", style="red")
        raise typer.Exit(1)


@app.command("info")
def show_session_info(
    session_id: str = typer.Argument(..., help="Session ID")
):
    """Show detailed session information."""
    try:
        service = get_service()
        session = service.get_session(session_id)
        
        if not session:
            console.print("Session not found.", style="red")
            raise typer.Exit(1)
        
        # Create info table
        table = Table(title=f"Session Information: {session.name}")
        table.add_column("Property", style="cyan")
        table.add_column("Value", style="white")
        
        table.add_row("ID", session.id)
        table.add_row("Name", session.name)
        table.add_row("Project", session.project)
        table.add_row("Status", session.status)
        table.add_row("Agent Type", session.agent_type)
        table.add_row("Worktree Name", session.worktree_name)
        table.add_row("Worktree Path", session.worktree_path)
        table.add_row("Tmux Session", session.tmux_session_name)
        table.add_row("Created At", session.created_at)
        table.add_row("Last Activity", session.last_activity)
        
        if session.initial_prompt:
            # Truncate long prompts
            prompt = session.initial_prompt[:200] + "..." if len(session.initial_prompt) > 200 else session.initial_prompt
            table.add_row("Initial Prompt", prompt)
        
        console.print(table)
        
        # Check health
        healthy = asyncio.run(service.health_check(session.id))
        health_status = "healthy" if healthy else "unhealthy"
        health_color = "green" if healthy else "red"
        console.print(f"\nHealth Status: [{health_color}]{health_status}[/{health_color}]")
        
    except Exception as e:
        console.print(f"Error showing session info: {e}", style="red")
        raise typer.Exit(1)


@app.command("attach")
def attach_session(
    partial_session_id: str = typer.Argument(..., help="Partial or full session ID to attach to"),
    read_only: bool = typer.Option(False, "--read-only", "-r", help="Attach in read-only mode")
):
    """Attach to an existing session terminal."""
    try:
        service = get_service()
        
        # Find matching sessions
        matches = _find_matching_sessions(service, partial_session_id)
        
        if not matches:
            console.print(f"❌ No sessions found matching '{partial_session_id}'", style="red")
            console.print("💡 Use 'tinstar session list' to see available sessions", style="dim")
            raise typer.Exit(1)
        
        if len(matches) > 1:
            console.print(f"❌ Multiple sessions match '{partial_session_id}':", style="red")
            for match in matches:
                session = service.get_session(match)
                if session:
                    short_id = match[:8] + "..."
                    console.print(f"  {short_id} - {session.name} ({session.project})", style="yellow")
            console.print("💡 Use a longer partial ID to be more specific", style="dim")
            raise typer.Exit(1)
        
        # Get the matched session
        session_id = matches[0]
        session = service.get_session(session_id)
        
        if not session:
            console.print("❌ Session not found", style="red")
            raise typer.Exit(1)
        
        if session.status != "active":
            console.print(f"⚠️  Session '{session.name}' is not active (status: {session.status})", style="yellow")
            if not typer.confirm("Do you want to attach anyway?"):
                console.print("Operation cancelled.", style="yellow")
                return
        
        # Check if tmux session exists
        check_cmd = ["tmux", "has-session", "-t", session.tmux_session_name]
        try:
            subprocess.run(check_cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError:
            console.print(f"❌ Tmux session '{session.tmux_session_name}' not found", style="red")
            console.print("The session may have been terminated outside of Tinstar", style="yellow")
            raise typer.Exit(1)
        
        # Show session info before attaching
        console.print(f"🔗 Attaching to session: {session.name}", style="green")
        console.print(f"   ID: {session.id[:8]}...", style="cyan")
        console.print(f"   Project: {session.project}", style="blue")
        console.print(f"   Worktree: {session.worktree_path}", style="yellow")
        
        if read_only:
            console.print(f"   Mode: Read-only", style="magenta")
        else:
            console.print(f"   Mode: Interactive", style="green")
        
        console.print("\n📋 Press Ctrl+B, D to detach from the session", style="dim")
        console.print("🚪 Use 'tinstar session list' to see all sessions when detached", style="dim")
        
        # Wait a moment for user to read
        import time
        time.sleep(1)
        
        # Attach to tmux session
        attach_cmd = ["tmux", "attach-session", "-t", session.tmux_session_name]
        
        if read_only:
            attach_cmd.extend(["-r"])  # Read-only mode
        
        # Ensure proper terminal handling
        if not read_only and os.isatty(0):
            # We're in an interactive terminal, ensure tmux gets control
            os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
        
        # Replace current process with tmux attach
        try:
            os.execvp("tmux", attach_cmd)
        except OSError as e:
            console.print(f"❌ Failed to attach to session: {e}", style="red")
            console.print("Make sure tmux is installed and available in PATH", style="yellow")
            raise typer.Exit(1)
        
    except Exception as e:
        console.print(f"❌ Error attaching to session: {e}", style="red")
        raise typer.Exit(1)


if __name__ == "__main__":
    app()