"""Installation helpers for the Tinstar project.

This module contains the core logic used by the Typer CLI.  The install
process performs the following high level steps:

1. Verify/create Tinstar directories under ``~/.tinstar``
2. Copy the default configuration file if missing
3. Purge and merge Tinstar hooks into ``~/.claude/settings.json``
4. Template the hook log path to ``~/.tinstar/logs/activity-log.jsonl``
5. Ensure ``permissions.additionalDirectories`` contains the worktrees path
6. Initialize an idempotent SQLite database at ``~/.tinstar/db/tinstar.db``
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Dict, List


DEPENDENCIES: Dict[str, Dict[str, str]] = {
    "jq": {
        "apt": "sudo apt-get install -y jq",
        "brew": "brew install jq",
        "choco": "choco install jq",
    },
    "npm": {
        "apt": "sudo apt-get install -y npm",
        "brew": "brew install node",
        "choco": "choco install nodejs",
    },
    "tmux": {
        "apt": "sudo apt-get install -y tmux",
        "brew": "brew install tmux",
        "choco": "choco install tmux",
    },
    "ttyd": {
        "apt": "sudo apt-get install -y ttyd",
        "brew": "brew install ttyd",
        "choco": "choco install ttyd",
    },
}


def check_dependencies() -> List[str]:
    """Return a list of missing hard dependencies."""
    from shutil import which

    return [dep for dep in DEPENDENCIES if which(dep) is None]


def get_install_paths() -> Dict[str, Path]:
    """Compute all relevant paths used during installation."""
    home_dir = Path.home()
    tinstar_root = home_dir / ".tinstar"
    paths: Dict[str, Path] = {
        "home_dir": home_dir,
        "tinstar_root": tinstar_root,
        "db_dir": tinstar_root / "db",
        "logs_dir": tinstar_root / "logs",
        "worktrees_dir": tinstar_root / "worktrees",
        "sessions_dir": tinstar_root / "sessions",
        "default_hooks_src": Path(__file__).parent / "hooks.json",
        "db_file": tinstar_root / "db" / "tinstar.db",
        "claude_settings": home_dir / ".claude" / "settings.json",
        "claude_settings_backup": home_dir
        / ".claude"
        / f"settings.json.backup.{datetime.now().strftime('%Y%m%d_%H%M%S')}",
    }
    return paths


def bootstrap_directories(paths: dict) -> None:
    """Create required Tinstar and Claude settings directories."""
    for directory in [
        paths["tinstar_root"],
        paths["db_dir"],
        paths["logs_dir"],
        paths["worktrees_dir"],
        paths["sessions_dir"],
    ]:
        directory.mkdir(parents=True, exist_ok=True)
    # Claude settings dir
    paths["claude_settings"].parent.mkdir(parents=True, exist_ok=True)


def backup_existing_settings(claude_settings: Path, backup_file: Path) -> bool:
    """Backup existing Claude settings if they exist."""
    if claude_settings.exists():
        print(f"💾 Backing up existing Claude settings to: {backup_file}")
        shutil.copy2(claude_settings, backup_file)
        return True
    return False


def template_hooks_json(hooks_src: Path, logs_dir: Path) -> dict:
    """Template the hooks.json with user-specific paths and server configuration."""
    if not hooks_src.exists():
        raise FileNotFoundError(f"hooks.json not found at {hooks_src}")

    # Import here to avoid circular dependency
    from ..config import get_config
    config = get_config()

    log_path = str((logs_dir / "activity-log.jsonl").resolve())
    tinstar_root_path = str(logs_dir.parent.resolve()) + "/"
    worktree_path = str((logs_dir.parent / "worktrees").resolve()) + "/"
    server_base_url = config.get_server_base_url()

    hooks_content = hooks_src.read_text()
    templated_content = hooks_content.replace(
        "/home/ubuntu/repo/ctrltower/logs/activity-log.jsonl", log_path
    ).replace(
        "/home/ubuntu/.tinstar/", tinstar_root_path
    ).replace(
        "/home/ubuntu/.tinstar/worktrees/", worktree_path
    ).replace(
        "{{SERVER_BASE_URL}}", server_base_url
    )

    return json.loads(templated_content)


def copy_default_config_if_missing(paths: dict) -> None:
    """Copy default Tinstar config if it doesn't already exist."""
    # Configuration is now handled by the TinstarConfig class
    # which creates ~/.tinstar/config.json automatically
    pass


def initialize_sqlite_db(paths: dict) -> None:
    """Create SQLite DB file and run idempotent schema initialization."""
    db_file = paths["db_file"]
    with sqlite3.connect(db_file) as conn:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        cur.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)",
            ("initialized", datetime.now().isoformat()),
        )
        conn.commit()


def load_existing_settings(claude_settings: Path) -> dict:
    if claude_settings.exists():
        try:
            return json.loads(claude_settings.read_text())
        except Exception:
            # If unreadable, treat as empty baseline
            return {}
    return {}


def purge_tinstar_hooks(settings: dict) -> None:
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return
    for event_hooks in hooks.values():
        if not isinstance(event_hooks, list):
            continue
        for entry in event_hooks:
            cmds = entry.get("hooks", [])
            entry["hooks"] = [
                cmd
                for cmd in cmds
                if not (
                    cmd.get("type") == "command"
                    and "#TINSTAR" in cmd.get("command", "")
                )
            ]


def merge_hooks(settings: dict, new_hooks: dict) -> None:
    settings_hooks = settings.setdefault("hooks", {})
    for event_name, arr in new_hooks.get("hooks", {}).items():
        if not isinstance(arr, list):
            continue
        existing_hooks = settings_hooks.setdefault(event_name, [])
        
        # Only add hooks that don't already exist
        for new_hook in arr:
            matcher = new_hook.get("matcher", "")
            new_commands = new_hook.get("hooks", [])
            
            # Check if a hook with the same matcher already exists
            existing_hook = None
            for hook in existing_hooks:
                if hook.get("matcher", "") == matcher:
                    existing_hook = hook
                    break
            
            if existing_hook is None:
                # No hook with this matcher exists, add the entire hook
                existing_hooks.append(new_hook)
            else:
                # Hook with same matcher exists, merge commands avoiding duplicates
                existing_commands = existing_hook.setdefault("hooks", [])
                for new_cmd in new_commands:
                    # Check if this exact command already exists
                    cmd_exists = any(
                        existing_cmd.get("command", "") == new_cmd.get("command", "")
                        for existing_cmd in existing_commands
                    )
                    if not cmd_exists:
                        existing_commands.append(new_cmd)


def ensure_permissions(settings: dict, worktrees_dir: Path) -> None:
    perms = settings.setdefault("permissions", {})
    addl = perms.setdefault("additionalDirectories", [])
    
    # Add the main tinstar directory for trust
    tinstar_root_path = str(worktrees_dir.parent.resolve()) + "/"
    if tinstar_root_path not in addl:
        addl.append(tinstar_root_path)
        
    # Add the worktrees directory
    worktrees_path = str(worktrees_dir.resolve()) + "/"
    if worktrees_path not in addl:
        addl.append(worktrees_path)


def write_settings(claude_settings: Path, settings: dict) -> None:
    claude_settings.write_text(json.dumps(settings, indent=2))


def install() -> None:
    """Run the full installation routine."""
    paths = get_install_paths()

    bootstrap_directories(paths)
    copy_default_config_if_missing(paths)

    had_existing = backup_existing_settings(
        paths["claude_settings"], paths["claude_settings_backup"]
    )

    templated_hooks = template_hooks_json(
        paths["default_hooks_src"], paths["logs_dir"]
    )

    existing = load_existing_settings(paths["claude_settings"]) if had_existing else {}
    if existing:
        purge_tinstar_hooks(existing)
        merge_hooks(existing, templated_hooks)
        ensure_permissions(existing, paths["worktrees_dir"])
        write_settings(paths["claude_settings"], existing)
    else:
        ensure_permissions(templated_hooks, paths["worktrees_dir"])
        write_settings(paths["claude_settings"], templated_hooks)

    initialize_sqlite_db(paths)