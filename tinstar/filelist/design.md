# Filelist

## Overview
Filelist provides directory traversal and file statistics aggregation for projects and worktrees. It tracks file changes (lines added/removed) and aggregates statistics up the directory tree to show project-wide impact.

## Use Case Example
Given directory structure:
```
repo/
  d1/
    d_open/
      file1.py (+20/-2)
      file2.js (+10/-5)
    d_closed/
      hidden1.py (+30/-10)
      hidden2.js (+5/-1)
```

When `open_dirs: ["d1/d_open"]`:
- `d1/d_open/` shows full listing: `file1.py`, `file2.js` with individual stats
- `d1/d_closed/` shows as collapsed node with aggregated stats: +35/-11
- `d1/` shows aggregated stats from both children: +65/-18

## Data Contracts

### Request/Response
- Request: list of open directory paths (relative to project root)
- Response: directory tree with statistics, populated to the depth of each open directory

### Entities
- File
  - `path` (relative to project root, using forward slashes)
  - `size` (bytes)
  - `modified` (timestamp)
  - `stats` (Dict[str, Any] with flexible key-value pairs, e.g., `lines_added`, `lines_removed`)

- Directory
  - `path` (relative to project root, using forward slashes)
  - `children` (List[File | Directory])
  - `stats` (Dict[str, Any] aggregated from children with summed numeric values)


### API (HTTP)
- POST `/filelist/{project}/tree`
  - Body: `{ "open_dirs": string[] }` (array of relative paths using forward slashes)
  - Response: `{ "tree": Directory }`
  - Status codes:
    - 200: Success
    - 400: Invalid request (malformed paths, paths outside project root)
    - 404: Project not found
    - 500: Internal error (filesystem/git errors)

### CLI (Typer)
N/A


## Logic

### File Discovery (Optimized)
- **Changed files**: Use `git diff --name-only HEAD` to find files with uncommitted changes
- **Files in expanded directories**: Use `git ls-files` with directory patterns for only expanded dirs
- **Untracked files**: Use `git ls-files --others --exclude-standard` scoped to expanded directories
- **Fallback**: When git unavailable, scan only expanded directories via filesystem
- Do not follow symlinks
- Include both tracked and untracked files for expanded directories only


### Statistics Collection
- For tracked files, use `git diff --numstat HEAD` to get uncommitted changes (lines added/removed since last commit)
- For untracked files, count total lines with `wc -l` (treating as all "added")
- Binary files: skip line counting, include only file size
- Calculate statistics on-the-fly (no persistent caching)

### Directory Traversal
- Build tree structure from file paths
- For each directory in `open_dirs`, populate the full directory listing down to that depth
- If `d1/d2` is in `open_dirs`, then the full path from root through `d1` to `d1/d2` is populated with all files and subdirectories
- Directories beyond the open depth appear as collapsed nodes with aggregated stats only
- Aggregate statistics up the tree (sum children stats)
- Handle empty directories gracefully

### Service Architecture
```python
class FileStats:
    path: str
    size: int
    modified: datetime
    stats: Dict[str, Any]  # flexible stats like lines_added, lines_removed, etc.

class DirectoryNode:
    path: str
    children: List[Union[FileStats, 'DirectoryNode']]
    stats: Dict[str, Any]  # aggregated from children

class FileListService:
    def get_tree(self, project_path: Path, open_dirs: List[str]) -> DirectoryNode
    def _build_tree(self, files: List[FileStats], expanded_dirs: Set[str]) -> DirectoryNode
    def _aggregate_stats(self, node: DirectoryNode) -> None
    def _compute_expanded_dirs(self, open_dirs: List[str]) -> Set[str]
    def _should_expand_dir(self, dir_path: str, expanded_dirs: Set[str]) -> bool
```

### Storage
N/A - all calculations performed on-the-fly

### Validation Rules
- `project` must exist in projects table
- All paths in `open_dirs` must be relative to project root (no leading `/`)
- Root directory can be specified as `""` (empty string)
- Paths must use forward slashes as separators
- Directory paths must not escape project root (no `..` after normalization)
- Non-existent directories in `open_dirs` are silently ignored
- Duplicate paths in `open_dirs` are deduplicated
- Parent directories are automatically included when child directories are specified
- Empty directories appear in tree with empty `stats: {}`

## Tests

- Empty directory
  - Given: project with no files
  - When: POST `/filelist/{project}/tree` with `open_dirs: [""]`
  - Then: returns root directory with zero stats and no children

- Single file stats
  - Given: project with one tracked file
  - When: stats requested
  - Then: file appears with correct line counts; parent directories show aggregated stats

- Directory aggregation
  - Given: multiple files in different subdirectories
  - When: POST `/filelist/{project}/tree` with root directory open
  - Then: each directory shows sum of its children's stats

- Selective expansion
  - Given: structure `src/open_dir/` and `src/closed_dir/` with files in both
  - When: POST `/filelist/{project}/tree` with `open_dirs: ["src/open_dir"]`
  - Then: `src/open_dir/` shows all files individually; `src/closed_dir/` appears as collapsed node with aggregated stats only

- Implicit parent expansion
  - Given: directory structure `src/feature/deep/` with files at each level
  - When: POST `/filelist/{project}/tree` with `open_dirs: ["src/feature/deep"]`  
  - Then: full directory listing shown from root down to src/feature/deep/, including all files and subdirectories at each level

- Deduplication
  - Given: directory structure `src/feature/`
  - When: POST `/filelist/{project}/tree` with `open_dirs: ["src", "src/feature", "src"]`
  - Then: duplicates are removed; src/ and src/feature/ are both expanded once

- Error handling: non-existent directory
  - Given: `open_dirs: ["src", "nonexistent/path"]`
  - When: POST `/filelist/{project}/tree`
  - Then: returns 200; `src/` is expanded; `nonexistent/path` silently ignored

- Error handling: invalid path
  - Given: `open_dirs: ["../outside", "src/../../../escape"]`
  - When: POST `/filelist/{project}/tree`
  - Then: returns 400 with error message about invalid paths

- Symlink handling
  - Given: directory contains symlink to file/directory
  - When: stats requested
  - Then: symlinks appear as files with their own stats; targets not followed

- Performance with large trees
  - Given: project with hundreds of files
  - When: POST `/filelist/{project}/tree` with minimal `open_dirs`
  - Then: response includes only expanded directories; collapsed directories show aggregated stats without enumerating all children

## Definition of Done
- File discovery via git ls-files (tracked and untracked) implemented
- Statistics collection from git diff and line counting implemented on-the-fly
- Directory tree building with selective expansion based on `open_dirs` functional
- Statistics aggregation up the tree working correctly
- HTTP API endpoint implemented and tested
- Validation rules enforced for all inputs
- Tests cover empty projects, single files, aggregation, selective expansion, and performance
- Collapsed directories show aggregated stats without full enumeration
