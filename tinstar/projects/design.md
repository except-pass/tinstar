# Projects

## Overview
A project is a local directory containing a `.git` repository. Worktrees are spawned from a project when a new agent is created. Projects are registered so Tinstar can manage agents, sessions, and worktrees per project.

## Data Contracts

### Entities
- Project
  - `name` (string, unique across user; slug-safe)
  - `path` (absolute path to local dir)
  - `created_at` (ISO 8601)
  - `default_branch` (optional string)
  - `unignore_paths` (optional string[], relative paths within the project to copy into each new worktree even if gitignored)

### API (HTTP)
- GET `/projects`
  - Response: `Project[]`
- POST `/projects`
  - Body: `{ "path": string, "name"?: string, "unignore_paths"?: string[] }`
  - Response: `Project`
- PATCH `/projects/{name}`
  - Body: `{ "unignore_paths"?: string[] }`
  - Response: `Project`
- DELETE `/projects/{name}`
  - Response: `{ "deleted": true }`

### CLI (Typer)
- `tinstar projects list`
- `tinstar projects add --path <abs_path> [--name <name>] [--unignore <rel> ...]`
- `tinstar projects set-unignore --name <name> --paths <rel> ...`
- `tinstar projects remove --name <name>`

## Logic

### Validation Rules
- `path` must be absolute, exist, be a directory, and contain a `.git` folder
- `name` must be unique across the user; if omitted, derive from last path segment
- Normalize and store `path` as real path (resolve symlinks)
- Git repository checks (must all pass):
  - `git rev-parse --git-common-dir` succeeds
  - `git rev-parse --git-dir` succeeds and equals `--git-common-dir`
  - `git rev-parse --is-bare-repository` returns `false`
- `unignore_paths` entries:
  - must be relative (no absolute paths)
  - must not escape project (`..` forbidden after normalization)
  - may point to files or directories; missing entries are ignored at copy time

### Storage
- SQLite in `~/.tinstar/db/tinstar.db`
- Table: `projects(name TEXT PRIMARY KEY, path TEXT UNIQUE, created_at TEXT, default_branch TEXT, unignore_paths TEXT)`
  - `unignore_paths` stored as JSON array
- Enforce uniqueness at DB level on `name` and `path`

### Operations
- List: return all projects ordered by `created_at`
- Add: validate → insert → return inserted row
- Update unignore list: validate → update → return row
- Remove: delete by `name` (cascade cleanup handled elsewhere)

### Worktree Copy (Unignore behavior)
- When a new worktree is created for a project:
  - For each `rel` in `unignore_paths`:
    - Source: `<project.path>/<rel>`; Destination: `<worktree.path>/<rel>`
    - Create parent directories as needed
    - If source is a file: copy with metadata (copy2)
    - If source is a directory: recursive copy (dirs_exist_ok=True)
    - If source missing: skip silently
  - Operation must be idempotent (safe to re-run without duplication)

## Tests

- List empty
  - Given: DB has no projects
  - When: `tinstar projects list`
  - Then: returns `[]`

- Add valid project
  - Given: a real absolute path with `.git`
  - When: `tinstar projects add --path <path>`
  - Then: project is stored with derived `name`; `path` is normalized; appears in list

- Reject non-git directory
  - Given: absolute path without a git repo
  - When: `tinstar projects add --path <path>`
  - Then: fails with clear error `not a git repository`

- Reject bare repository
  - Given: a bare git repository path
  - When: `tinstar projects add --path <path>`
  - Then: fails with clear error `bare repositories are not supported`

- Add duplicate name
  - Given: existing project named `alpha`
  - When: `tinstar projects add --path <new_path> --name alpha`
  - Then: fails with clear error `name already exists`

- Add duplicate path
  - Given: existing project with `path=P`
  - When: `tinstar projects add --path P`
  - Then: fails with clear error `path already registered`

- Add invalid path
  - Given: non-existent or not a git repo
  - When: add attempted
  - Then: fails with clear error specifying reason

- Set unignore list
  - Given: project `alpha` exists
  - When: `tinstar projects set-unignore --name alpha --paths .env dirA/config.json`
  - Then: project row stores JSON array `[".env","dirA/config.json"]`

- Worktree copy: file
  - Given: project has `.env` in `unignore_paths` and file exists in project root
  - When: a worktree is created for the project
  - Then: `.env` appears in the worktree root with same contents and timestamps preserved

- Worktree copy: directory
  - Given: project has `secrets/` in `unignore_paths` and directory exists
  - When: worktree is created
  - Then: the directory tree is copied recursively into the worktree

- Worktree copy: missing
  - Given: `unignore_paths` contains a non-existent entry
  - When: worktree is created
  - Then: no error; missing entry is skipped

- Remove existing project
  - Given: project `alpha` exists
  - When: `tinstar projects remove --name alpha`
  - Then: returns deleted=true and project no longer listed

- Remove missing project
  - Given: no project named `ghost`
  - When: remove attempted
  - Then: returns clear `not found` error; no DB changes

- Default branch detection (optional)
  - Given: repo with configured origin/HEAD
  - When: add project
  - Then: `default_branch` stored or left null if not resolvable

## Definition of Done
- Data model and API/CLI surfaces defined as above
- Validation implemented for path and `unignore_paths`
- SQLite schema created with constraints; `unignore_paths` persisted as JSON
- Worktree creation copies configured `unignore_paths` (file/dir) idempotently
- CLI commands: list/add/set-unignore/remove with helpful errors
- Tests implemented per Given/When/Then and passing
- No references to other projects; paths resolved and stored consistently