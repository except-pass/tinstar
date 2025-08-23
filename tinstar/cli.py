import typer

from .installation import install_app
from .worktrees.cli import app as worktrees_app
from .session.cli import app as session_app
from .projects.cli import app as projects_app
from .events.cli import app as events_app
from .testing import app as test_app
from .server import run_server

app = typer.Typer(help="Tinstar command line interface")
app.add_typer(install_app, name="install")
app.add_typer(projects_app, name="project")
app.add_typer(worktrees_app, name="worktrees")
app.add_typer(session_app, name="session")
app.add_typer(events_app, name="events")
app.add_typer(test_app, name="test")


@app.command()
def server(
    host: str = typer.Option("0.0.0.0", help="Host to bind the server to"),
    port: int = typer.Option(3002, help="Port to bind the server to"),
    debug: bool = typer.Option(False, help="Enable debug mode")
):
    """Start the Tinstar API server."""
    typer.echo(f"Starting Tinstar server on {host}:{port}")
    run_server(host=host, port=port, debug=debug)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
