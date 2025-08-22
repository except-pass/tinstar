import typer

from .installation import install_app
from .worktrees.cli import app as worktrees_app
from .session.cli import app as session_app
from .testing import app as test_app

app = typer.Typer(help="Tinstar command line interface")
app.add_typer(install_app, name="install")
app.add_typer(worktrees_app, name="worktrees")
app.add_typer(session_app, name="session")
app.add_typer(test_app, name="test")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
