"""
CLI commands for the Tinstar projects system.
"""
from typing import List, Optional

import typer
from rich.console import Console
from rich.table import Table
from rich import print as rprint

from .models import CreateProjectRequest, UpdateProjectRequest
from .service import ProjectService, ProjectValidationError

console = Console()
app = typer.Typer(name="project", help="Manage projects")


def get_service() -> ProjectService:
    """Get the projects service instance."""
    return ProjectService()


@app.command("list")
def list_projects():
    """List all registered projects."""
    try:
        service = get_service()
        projects = service.list_projects()
        
        if not projects:
            console.print("No projects registered.", style="yellow")
            console.print("💡 Use 'tinstar project register <path>' to register a project", style="dim")
            return
        
        # Create table
        table = Table(title=f"Registered Projects ({len(projects)} total)")
        table.add_column("Name", style="cyan")
        table.add_column("Path", style="green")
        table.add_column("Default Branch", style="blue")
        table.add_column("Unignore Paths", style="magenta")
        table.add_column("Created", style="dim")
        
        for project in projects:
            # Format unignore paths
            unignore_display = ", ".join(project.unignore_paths[:3])
            if len(project.unignore_paths) > 3:
                unignore_display += f" (+{len(project.unignore_paths)-3} more)"
            elif not project.unignore_paths:
                unignore_display = "none"
            
            # Truncate long paths
            path_display = project.path
            if len(path_display) > 50:
                path_display = "..." + path_display[-47:]
            
            table.add_row(
                project.name,
                path_display,
                project.default_branch or "unknown",
                unignore_display,
                project.created_at[:19]
            )
        
        console.print(table)
        
    except Exception as e:
        console.print(f"❌ Error listing projects: {e}", style="red")
        raise typer.Exit(1)


@app.command("register")
def register_project(
    path: str = typer.Argument(..., help="Path to git repository"),
    name: Optional[str] = typer.Option(None, "--name", "-n", help="Project name (auto-generated if not provided)"),
    unignore_paths: List[str] = typer.Option([], "--unignore", "-u", help="Relative paths to copy to worktrees (can be specified multiple times)")
):
    """Register a git repository as a project."""
    try:
        service = get_service()
        
        request = CreateProjectRequest(
            path=path,
            name=name,
            unignore_paths=unignore_paths
        )
        
        console.print(f"📋 Registering project at: {path}")
        if name:
            console.print(f"   Name: {name}")
        if unignore_paths:
            console.print(f"   Unignore paths: {', '.join(unignore_paths)}")
        
        project = service.create_project(request)
        
        console.print(f"✅ Project '{project.name}' registered successfully!", style="green")
        console.print(f"   Path: {project.path}", style="green")
        console.print(f"   Default branch: {project.default_branch or 'unknown'}", style="cyan")
        
        if project.unignore_paths:
            console.print(f"   Unignore paths: {', '.join(project.unignore_paths)}", style="magenta")
        
        console.print(f"\n💡 Now you can create sessions: tinstar session create {project.name}", style="dim")
        
    except ProjectValidationError as e:
        console.print(f"❌ Validation error: {e}", style="red")
        raise typer.Exit(1)
    except Exception as e:
        console.print(f"❌ Error registering project: {e}", style="red")
        raise typer.Exit(1)


@app.command("show")
def show_project(
    name: str = typer.Argument(..., help="Project name")
):
    """Show detailed information about a project."""
    try:
        service = get_service()
        project = service.get_project(name)
        
        if not project:
            console.print(f"❌ Project '{name}' not found", style="red")
            console.print("💡 Use 'tinstar project list' to see available projects", style="dim")
            raise typer.Exit(1)
        
        # Create info table
        table = Table(title=f"Project: {project.name}")
        table.add_column("Property", style="cyan")
        table.add_column("Value", style="white")
        
        table.add_row("Name", project.name)
        table.add_row("Path", project.path)
        table.add_row("Default Branch", project.default_branch or "unknown")
        table.add_row("Created At", project.created_at)
        table.add_row("Unignore Paths", str(len(project.unignore_paths)) + " entries")
        
        console.print(table)
        
        # Show unignore paths if any
        if project.unignore_paths:
            console.print("\n📁 Unignore Paths (copied to worktrees):", style="cyan")
            for i, path in enumerate(project.unignore_paths, 1):
                console.print(f"  {i}. {path}")
        else:
            console.print("\n📁 No unignore paths configured - worktrees will only get git files", style="yellow")
        
    except Exception as e:
        console.print(f"❌ Error showing project: {e}", style="red")
        raise typer.Exit(1)


@app.command("update")
def update_project(
    name: str = typer.Argument(..., help="Project name"),
    unignore_paths: List[str] = typer.Option(None, "--unignore", "-u", help="Update unignore paths (replaces existing)")
):
    """Update project settings."""
    try:
        service = get_service()
        
        if unignore_paths is None:
            console.print("❌ No updates specified. Use --unignore to update paths.", style="red")
            raise typer.Exit(1)
        
        request = UpdateProjectRequest(unignore_paths=unignore_paths)
        project = service.update_project(name, request)
        
        if not project:
            console.print(f"❌ Project '{name}' not found", style="red")
            raise typer.Exit(1)
        
        console.print(f"✅ Project '{name}' updated successfully!", style="green")
        console.print(f"   Unignore paths: {', '.join(project.unignore_paths) if project.unignore_paths else 'none'}")
        
    except ProjectValidationError as e:
        console.print(f"❌ Validation error: {e}", style="red")
        raise typer.Exit(1)
    except Exception as e:
        console.print(f"❌ Error updating project: {e}", style="red")
        raise typer.Exit(1)


@app.command("remove")
def remove_project(
    name: str = typer.Argument(..., help="Project name"),
    confirm: bool = typer.Option(False, "--confirm", help="Skip confirmation prompt")
):
    """Remove a project registration."""
    try:
        service = get_service()
        
        # Check if project exists
        project = service.get_project(name)
        if not project:
            console.print(f"❌ Project '{name}' not found", style="red")
            raise typer.Exit(1)
        
        if not confirm:
            console.print(f"⚠️  This will remove project '{name}' registration.", style="yellow")
            console.print(f"   Path: {project.path}", style="dim")
            console.print("   Note: This only removes the registration, not the actual files.", style="dim")
            
            confirm_delete = typer.confirm("Are you sure you want to continue?")
            if not confirm_delete:
                console.print("Operation cancelled.", style="yellow")
                return
        
        success = service.delete_project(name)
        
        if success:
            console.print(f"✅ Project '{name}' removed successfully.", style="green")
        else:
            console.print(f"❌ Failed to remove project '{name}'", style="red")
            raise typer.Exit(1)
        
    except Exception as e:
        console.print(f"❌ Error removing project: {e}", style="red")
        raise typer.Exit(1)


if __name__ == "__main__":
    app()