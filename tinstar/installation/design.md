# Installation Process

## Data Contracts
N/A.  


## Logic

### Bootstrap directory structure
- `mkdir -p ~/.tinstar` and required subdirs:
  - `~/.tinstar/db` - SQLite database files
  - `~/.tinstar/logs` - Application logs
  - `~/.tinstar/worktrees` - Git worktree storage
  - `~/.tinstar/sessions` - Session metadata

- Configuration is handled by the TinstarConfig class which creates `~/.tinstar/config.json` automatically

### Dependencies
- Hard deps to check: `jq`, `npm`, `tmux`, `ttyd`
- Python runtime dep: `typer` (for CLI)
- Note: `pip` is assumed available since Tinstar is installed via pip

### Orchestration (kickoff)
- Install via pip: `pip install tinstar` (publishes `tinstar` CLI via Typer)
- Doctor (check only): `tinstar install doctor`
  - Verifies `jq`, `npm`, `tmux`, `ttyd`
  - Prints clear suggestions for how to install any missing deps (apt/brew links or commands)
  - Makes no system changes
- Run installer: `tinstar install run`
  - Bootstrap directory structure and copy default config if missing
  - Purge + merge hooks into `~/.claude/settings.json` and template log path
  - Ensure `permissions.additionalDirectories` includes `/home/<user>/.tinstar/worktrees/`
  - Initialize SQLite DB at `~/.tinstar/db/tinstar.db`

### Install/merge hooks (purge + merge)
- If `~/.claude/settings.json` does not exist, copy `tinstar/installation/hooks.json` (after templating log path to `/home/<user>/.tinstar/logs/activity-log.jsonl`).
- Else (settings exists):
  - Load JSON and back up to `~/.claude/settings.json.backup.<timestamp>`
  - Purge: remove any hook entries whose command contains `#TINSTAR`
  - Merge: append hooks from `tinstar/installation/hooks.json` into their corresponding event arrays, preserving user hooks
  - Ensure `permissions.additionalDirectories` includes `/home/<user>/.tinstar/worktrees/` (idempotent)
  - Write merged settings back (single write)

### Initialize database
- Validate installation by checking all required directories exist
- Open/create SQLite at `~/.tinstar/db/tinstar.db`
- Run idempotent schema initialization


## Tests

- Directory creation
  - Given: `~/.tinstar` does not exist
  - When: `tinstar install run`
  - Then: all subdirs exist with correct permissions; rerun is idempotent

- Config file creation
  - Given: `~/.tinstar/config.json` is missing
  - When: TinstarConfig is initialized
  - Then: file is created with default configuration

- Doctor checks
  - Given: one or more of `jq`, `npm`, `tmux`, `ttyd` are missing
  - When: `tinstar install doctor`
  - Then: exit non-zero and print per-dependency install suggestions (apt/brew); no files changed

- Hooks install (no existing settings)
  - Given: `~/.claude/settings.json` does not exist
  - When: `tinstar install run`
  - Then: file is created; hooks present; log path templated to absolute `~/.tinstar/logs/activity-log.jsonl`; permissions include `~/.tinstar/worktrees/`

- Hooks purge/merge (existing settings)
  - Given: `~/.claude/settings.json` exists with user hooks and prior `#TINSTAR` hooks
  - When: `tinstar install run`
  - Then: backup is created; all prior `#TINSTAR` hooks are removed; user hooks remain; new hooks appended once; JSON valid

- Database initialization
  - Given: no DB file at `~/.tinstar/db/tinstar.db`
  - When: `tinstar install run`
  - Then: SQLite file created and schema initialized; rerun idempotent

- Backup/restore
  - Given: existing `~/.claude/settings.json`
  - When: `tinstar install run`
  - Then: backup file created with timestamp; contents match pre-install

- Multi-user scenario
  - Given: different `$HOME`
  - When: each user runs `tinstar install run`
  - Then: each user has isolated `~/.tinstar` and Claude settings updated for that user only

## Definition of Done
- Typer-based CLI present: `tinstar install doctor`, `tinstar install run`
- Doctor checks deps and only prints actionable suggestions; no side effects
- Installer performs bootstrap, hooks purge/merge, permissions, and SQLite init
- Hard deps are documented as checks (not auto-installed)
- Config copy source/target is explicit
- SQLite DB path and idempotent schema init are explicit
- Tests use Given/When/Then and cover doctor, run, and idempotency
- No references to other projects remain in installed artifacts
- install.sh is not needed and has been deleted from the codebase