"""
CLI commands for running tests in the Tinstar system.
"""
import subprocess
import sys
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console

app = typer.Typer(help="Run tests for Tinstar modules")
console = Console()


@app.command("all")
def test_all(
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
    coverage: bool = typer.Option(False, "--coverage", "-c", help="Run with coverage"),
    parallel: bool = typer.Option(False, "--parallel", "-p", help="Run tests in parallel")
):
    """Run all tests in the tinstar package."""
    _run_pytest("tinstar/", verbose, coverage, parallel)


@app.command("module")
def test_module(
    module: str = typer.Argument(..., help="Module name (e.g., 'worktrees', 'events', 'session')"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
    coverage: bool = typer.Option(False, "--coverage", "-c", help="Run with coverage"),
    parallel: bool = typer.Option(False, "--parallel", "-p", help="Run tests in parallel")
):
    """Run tests for a specific module."""
    module_path = f"tinstar/{module}/"
    if not Path(module_path).exists():
        console.print(f"[red]Error: Module '{module}' not found[/red]")
        console.print(f"[dim]Available modules: events, worktrees, installation, session[/dim]")
        raise typer.Exit(1)
    
    _run_pytest(module_path, verbose, coverage, parallel)


@app.command("file")
def test_file(
    file_path: str = typer.Argument(..., help="Test file path (e.g., 'tinstar/worktrees/test_worktrees.py')"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
    coverage: bool = typer.Option(False, "--coverage", "-c", help="Run with coverage")
):
    """Run a specific test file."""
    if not Path(file_path).exists():
        console.print(f"[red]Error: Test file '{file_path}' not found[/red]")
        raise typer.Exit(1)
    
    _run_pytest(file_path, verbose, coverage, False)


def _run_pytest(path: str, verbose: bool, coverage: bool, parallel: bool):
    """Run pytest with specified options."""
    try:
        # Build pytest command
        cmd = ["python", "-m", "pytest", path]
        
        if verbose:
            cmd.append("-v")
        
        if coverage:
            cmd.extend(["--cov=tinstar", "--cov-report=term-missing"])
        
        if parallel:
            cmd.extend(["-n", "auto"])
        
        console.print(f"[blue]Running:[/blue] {' '.join(cmd)}")
        
        # Check if we need to install additional dependencies
        if coverage and not _check_package_installed("pytest-cov"):
            console.print("[yellow]Installing pytest-cov...[/yellow]")
            subprocess.run([sys.executable, "-m", "pip", "install", "pytest-cov"], check=True)
        
        if parallel and not _check_package_installed("pytest-xdist"):
            console.print("[yellow]Installing pytest-xdist...[/yellow]")
            subprocess.run([sys.executable, "-m", "pip", "install", "pytest-xdist"], check=True)
        
        # Run pytest
        result = subprocess.run(cmd, cwd=Path.cwd())
        
        if result.returncode == 0:
            console.print("[green]✓ All tests passed![/green]")
        else:
            console.print(f"[red]✗ Tests failed with exit code {result.returncode}[/red]")
            raise typer.Exit(result.returncode)
            
    except subprocess.CalledProcessError as e:
        console.print(f"[red]Error running tests: {e}[/red]")
        raise typer.Exit(1)
    except KeyboardInterrupt:
        console.print("[yellow]Tests interrupted by user[/yellow]")
        raise typer.Exit(130)


def _check_package_installed(package: str) -> bool:
    """Check if a package is installed."""
    try:
        subprocess.run([sys.executable, "-c", f"import {package.replace('-', '_')}"], 
                      check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError:
        return False


@app.command()
def run(
    module: Optional[str] = typer.Argument(None, help="Module name (optional)"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
    coverage: bool = typer.Option(False, "--coverage", "-c", help="Run with coverage"),
    parallel: bool = typer.Option(False, "--parallel", "-p", help="Run tests in parallel")
):
    """Run tests. If no module specified, runs all tests."""
    if module:
        # Run specific module tests
        module_path = f"tinstar/{module}/"
        if not Path(module_path).exists():
            console.print(f"[red]Error: Module '{module}' not found[/red]")
            console.print(f"[dim]Available modules: events, worktrees, installation, session[/dim]")
            raise typer.Exit(1)
        _run_pytest(module_path, verbose, coverage, parallel)
    else:
        # Run all tests
        _run_pytest("tinstar/", verbose, coverage, parallel)


@app.callback()
def callback():
    """Test runner for Tinstar modules."""
    pass


if __name__ == "__main__":
    app()