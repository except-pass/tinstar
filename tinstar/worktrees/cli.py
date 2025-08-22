"""
CLI commands for the Tinstar worktrees system.
"""
import typer
from typing import Optional
from rich.console import Console
from rich.table import Table

from .models import WorktreeCreateRequest, WorktreeDeleteRequest
from .service import WorktreeService

app = typer.Typer(help="Manage git worktrees for projects")
console = Console()


@app.command("list")
def list_worktrees(
    project: str = typer.Option(..., "--project", "-p", help="Project name")
):
    """List all worktrees for a project."""
    try:
        service = WorktreeService()
        worktrees = service.list_worktrees(project)
        
        if not worktrees:
            console.print(f"[yellow]No worktrees found for project '{project}'[/yellow]")
            return
        
        # Create table
        table = Table(title=f"Worktrees for project '{project}'")
        table.add_column("Name", style="cyan", no_wrap=True)
        table.add_column("Path", style="green")
        table.add_column("Branch", style="blue")
        table.add_column("HEAD", style="magenta")
        table.add_column("Status", style="yellow")
        table.add_column("Created", style="dim")
        
        for worktree in worktrees:
            status = "detached" if worktree.detached else "normal"
            head_short = worktree.head[:8] if worktree.head else "unknown"
            created_short = worktree.created_at[:19] if worktree.created_at else "unknown"
            
            table.add_row(
                worktree.name,
                worktree.path,
                worktree.branch,
                head_short,
                status,
                created_short
            )
        
        console.print(table)
        
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
    except Exception as e:
        console.print(f"[red]Unexpected error: {e}[/red]")
        raise typer.Exit(1)


@app.command("create")
def create_worktree(
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
    name: str = typer.Option(..., "--name", "-n", help="Worktree name")
):
    """Create a new worktree."""
    try:
        request = WorktreeCreateRequest(project=project, name=name)
        service = WorktreeService()
        worktree = service.create_worktree(request)
        
        console.print(f"[green]✓[/green] Worktree '{name}' created successfully")
        console.print(f"  Path: {worktree.path}")
        console.print(f"  Branch: {worktree.branch}")
        console.print(f"  HEAD: {worktree.head[:8] if worktree.head else 'unknown'}")
        
    except ValueError as e:
        if "already exists" in str(e):
            console.print(f"[red]Error: {e}[/red]")
            raise typer.Exit(1)
        elif "not found" in str(e):
            console.print(f"[red]Error: {e}[/red]")
            console.print("[dim]Hint: Make sure the project exists in the Projects module[/dim]")
            raise typer.Exit(1)
        elif "detached HEAD" in str(e):
            console.print(f"[red]Error: {e}[/red]")
            console.print("[dim]Hint: Switch to a branch first before creating a worktree[/dim]")
            raise typer.Exit(1)
        else:
            console.print(f"[red]Error: {e}[/red]")
            raise typer.Exit(1)
    except Exception as e:
        console.print(f"[red]Unexpected error: {e}[/red]")
        raise typer.Exit(1)


@app.command("remove")
def remove_worktree(
    project: str = typer.Option(..., "--project", "-p", help="Project name"),
    name: str = typer.Option(..., "--name", "-n", help="Worktree name"),
    force: bool = typer.Option(False, "--force", "-f", help="Force removal even with uncommitted changes")
):
    """Remove a worktree."""
    try:
        request = WorktreeDeleteRequest(project=project, name=name, force=force)
        service = WorktreeService()
        
        # Confirm deletion unless forcing
        if not force:
            confirm = typer.confirm(f"Are you sure you want to remove worktree '{name}' from project '{project}'?")
            if not confirm:
                console.print("[yellow]Operation cancelled[/yellow]")
                return
        
        deleted = service.delete_worktree(request)
        
        if deleted:
            console.print(f"[green]✓[/green] Worktree '{name}' removed successfully")
        else:
            console.print(f"[red]Error: Worktree '{name}' not found[/red]")
            raise typer.Exit(1)
            
    except ValueError as e:
        if "uncommitted changes" in str(e):
            console.print(f"[red]Error: {e}[/red]")
            console.print("[dim]Hint: Use --force to remove anyway, or commit/stash your changes[/dim]")
            raise typer.Exit(1)
        elif "not found" in str(e):
            console.print(f"[red]Error: {e}[/red]")
            raise typer.Exit(1)
        else:
            console.print(f"[red]Error: {e}[/red]")
            raise typer.Exit(1)
    except Exception as e:
        console.print(f"[red]Unexpected error: {e}[/red]")
        raise typer.Exit(1)


if __name__ == "__main__":
    app()