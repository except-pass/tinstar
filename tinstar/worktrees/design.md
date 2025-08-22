# Worktrees

## Overview
Worktrees provide isolated git working directories per agent or task. Each worktree is created from a managed project’s current branch and receives a copy of selected project files (the project’s `unignore_paths`).

## Data Contracts

### Entities
- Worktree
  - `name` (string, unique per project)
  - `project` (string, project name from Projects module)
  - `path` (string, absolute path to worktree directory)
  - `branch` (string, git branch name, format: `worktree/{name}`)
  - `head` (optional string, current commit SHA)
  - `detached` (boolean, true if HEAD is detached)
  - `created_at` (ISO 8601 timestamp)

### API (HTTP)
- GET `/api/worktrees?project=<name>`
  - Response: `{ "worktrees": Worktree[] }`
  - Status codes: 200 (success), 404 (project not found)
- POST `/api/worktrees`
  - Body: `{ "project": string, "name": string }`
  - Response: `{ "worktree": Worktree }`
  - Status codes: 200 (success), 400 (validation error), 404 (project not found), 409 (worktree exists)
- DELETE `/api/worktrees/{name}`
  - Query: `?project=<name>` (required to disambiguate per project)
  - Response: `{ "deleted": true }`
  - Status codes: 200 (success), 404 (worktree not found), 500 (git error)

### CLI (Typer)
- `tinstar worktrees list --project <name>`
- `tinstar worktrees create --project <name> --name <worktree_name>`
- `tinstar worktrees remove --project <name> --name <worktree_name> [--force]`

## Logic

### Validation Rules
- `project` must exist in Projects module database
- `name` must be unique per project (stored in database)
- `name` must be valid as directory name and git branch name (alphanumeric, hyphens, underscores only)
- All git operations performed from project root directory

### Worktree Paths
- Base directory: `~/.tinstar/worktrees/`
- Worktree path: `~/.tinstar/worktrees/{name}/`
- Branch naming: `worktree/{name}`

### Creation Process
1. Validate project exists and name is unique
2. Determine source branch: current branch of project (error if detached HEAD with no branch)
3. Run: `git worktree add ~/.tinstar/worktrees/{name} -b worktree/{name} {current_branch}` from project path
4. Copy unignored files/dirs from project using Projects module `unignore_paths` rules
5. Store worktree metadata in database
6. If any step fails, clean up partial state (remove directory, delete git branch if created)

### Current Branch Detection
- Use `git branch --show-current` from project directory
- If empty (detached HEAD), use `git symbolic-ref HEAD` then extract branch name
- If both fail, return error - cannot create worktree from detached HEAD

### Removal Process
1. Validate worktree exists in database
2. Check for uncommitted changes with `git status --porcelain`
3. If changes exist and not `--force`, return error with change summary
4. Run: `git worktree remove ~/.tinstar/worktrees/{name} [--force]`
5. Remove worktree metadata from database
6. If git removal fails, log error but still remove from database

### Listing Process
- Query database for worktrees filtered by project
- For each worktree, verify directory still exists
- Update status fields (head, detached) from git if directory exists
- Return list with current status

### Copy behavior (reuse from Projects)
- For each relative path in the project's `unignore_paths`:
  - Source: `{project_path}/{rel_path}`; Destination: `~/.tinstar/worktrees/{name}/{rel_path}`
  - File: copy with metadata (copy2)
  - Directory: recursive copy (dirs_exist_ok=True)
  - Missing: skip without error
- Operation should be idempotent and safe to re-run

### Storage
- SQLite database: `~/.tinstar/db/tinstar.db` (shared with other modules)
- Table: `worktrees(name TEXT, project TEXT, path TEXT, branch TEXT, head TEXT, detached BOOLEAN, created_at TEXT, PRIMARY KEY(name, project))`
- Foreign key: `project` references `projects(name)`
- Indexes on `project` for efficient listing queries

## Tests

- List empty
  - Given: project with no worktrees under management
  - When: `tinstar worktrees list --project <name>`
  - Then: returns `[]`

- Create worktree success
  - Given: valid project on a branch; `unignore_paths` contain files/dirs
  - When: `tinstar worktrees create --project <name> --name alpha`
  - Then: branch `worktree/alpha` created; directory exists; unignored paths copied

- Create when exists
  - Given: worktree `alpha` already exists for project
  - When: create called again with same project and name
  - Then: returns 409 conflict error with existing worktree details

- Remove worktree
  - Given: worktree `alpha` exists
  - When: `tinstar worktrees remove --project <name> --name alpha`
  - Then: worktree removed via git; directory gone (unless other git state prevents it)

- Remove with force
  - Given: worktree has uncommitted changes
  - When: remove with `--force`
  - Then: removal succeeds

- List worktrees filter
  - Given: git has other worktrees not managed by tinstar
  - When: GET `/api/worktrees?project=<name>`
  - Then: only worktrees in database for specified project are returned

- Project validation
  - Given: project `nonexistent` does not exist in Projects module
  - When: attempt to create worktree for `nonexistent`
  - Then: returns 404 error with message "Project not found"

- Detached HEAD handling
  - Given: project is in detached HEAD state
  - When: attempt to create worktree
  - Then: returns 400 error with message "Cannot create worktree from detached HEAD"

- Name validation
  - Given: invalid worktree name with special characters
  - When: attempt to create worktree with name "test/name"
  - Then: returns 400 error with validation message

## Definition of Done
- HTTP API and CLI implemented for list/create/remove operations
- Database schema and storage implemented in shared tinstar.db
- Git operations (worktree add/remove) working with proper error handling
- Current branch detection with detached HEAD error handling
- Project validation integration with Projects module
- File copying using Projects module unignore_paths rules
- Name validation for directory and git branch compatibility
- Comprehensive error handling with proper status codes
- Safe cleanup of partial states on creation failure
- All tests passing including edge cases and error conditions
- Foreign key constraints and indexes in database working

