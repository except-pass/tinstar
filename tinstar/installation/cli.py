import typer

from . import installer

install_app = typer.Typer(help="Installation commands for Tinstar")


@install_app.command()
def doctor() -> None:
    """Check for required external dependencies."""
    missing = installer.check_dependencies()
    if missing:
        for dep in missing:
            info = installer.DEPENDENCIES[dep]
            typer.echo(
                f"Missing {dep}. Install via apt: {info['apt']} | brew: {info['brew']} | choco: {info['choco']}"
            )
        raise typer.Exit(code=1)
    typer.echo("All dependencies satisfied")


@install_app.command()
def run() -> None:
    """Run the installer."""
    installer.install()
    typer.echo("Installation complete")
