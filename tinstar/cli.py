import typer

from .installation import install_app
from .worktrees.cli import app as worktrees_app

app = typer.Typer(help="Tinstar command line interface")
app.add_typer(install_app, name="install")
app.add_typer(worktrees_app, name="worktrees")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
