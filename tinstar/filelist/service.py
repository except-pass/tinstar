"""File listing service with directory traversal and git statistics."""

import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Set, Union
from dataclasses import dataclass


@dataclass
class FileStats:
    """File statistics and metadata."""
    path: str  # relative to project root, using forward slashes
    size: int  # bytes
    modified: datetime  # timestamp
    stats: Dict[str, Any]  # flexible stats like lines_added, lines_removed


@dataclass
class DirectoryNode:
    """Directory node in the file tree."""
    path: str  # relative to project root, using forward slashes
    children: List[Union[FileStats, 'DirectoryNode']]
    stats: Dict[str, Any]  # aggregated from children


class FileListService:
    """Service for building directory trees with file statistics."""
    
    def get_tree(self, project_path: Path, open_dirs: List[str]) -> DirectoryNode:
        """Build directory tree with statistics for the given open directories.
        
        Args:
            project_path: Absolute path to the project/worktree
            open_dirs: List of relative directory paths to expand
            
        Returns:
            Directory tree with statistics
            
        Raises:
            ValueError: If paths are invalid or escape project root
            FileNotFoundError: If project_path doesn't exist
        """
        if not project_path.exists() or not project_path.is_dir():
            raise FileNotFoundError(f"Project path does not exist: {project_path}")
        
        # Validate and normalize open_dirs
        expanded_dirs = self._compute_expanded_dirs(open_dirs)
        
        # Discover all files
        all_files = self._discover_files(project_path)
        
        # Cache files for aggregation of collapsed directories
        self._all_files_cache = all_files
        
        # Build tree structure
        tree = self._build_tree(all_files, expanded_dirs)
        
        # Aggregate statistics
        self._aggregate_stats(tree)
        
        # Clear cache
        delattr(self, '_all_files_cache')
        
        return tree
    
    def _compute_expanded_dirs(self, open_dirs: List[str]) -> Set[str]:
        """Compute all directories that should be expanded.
        
        This includes:
        - All explicitly listed directories
        - All parent directories of listed directories
        - Deduplication of paths
        """
        expanded = set()
        
        for dir_path in open_dirs:
            # Validate before normalizing
            if dir_path.startswith('/'):
                raise ValueError("Paths must be relative (no leading slash)")
            
            # Normalize path
            normalized = self._normalize_path(dir_path)
            
            # Add this directory and all its parents
            if normalized == '':
                # Root directory
                expanded.add('')
            else:
                # Add root directory first
                expanded.add('')
                
                # Add all parent directories
                parts = normalized.split('/')
                for i in range(len(parts)):
                    parent_path = '/'.join(parts[:i+1])
                    expanded.add(parent_path)
        
        return expanded
    
    def _normalize_path(self, path: str) -> str:
        """Normalize a path to use forward slashes and remove redundant parts."""
        if not path:
            return ""
        
        # Convert to forward slashes and normalize
        normalized = path.replace('\\', '/')
        parts = []
        
        for part in normalized.split('/'):
            if part == '.' or part == '':
                continue
            elif part == '..':
                if parts:
                    parts.pop()
                else:
                    raise ValueError("Path escapes project root")
            else:
                parts.append(part)
        
        return '/'.join(parts)
    
    def _validate_path(self, path: str) -> None:
        """Validate that a path is safe and doesn't escape project root."""
        if path.startswith('/'):
            raise ValueError("Paths must be relative (no leading slash)")
        
        # Additional validation is done in _normalize_path for '..' handling
        # The '..' check is done in _normalize_path which raises ValueError
    
    def _discover_files(self, project_path: Path) -> List[FileStats]:
        """Discover files in the project using git to respect .gitignore."""
        files = []
        file_paths = set()
        
        try:
            # Get tracked files
            result = subprocess.run(
                ['git', 'ls-files'],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0:
                for line in result.stdout.strip().split('\n'):
                    if line.strip():
                        file_paths.add(line.strip())
            
            # Get untracked files (excluding ignored ones)
            result = subprocess.run(
                ['git', 'ls-files', '--others', '--exclude-standard'],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0:
                for line in result.stdout.strip().split('\n'):
                    if line.strip():
                        file_paths.add(line.strip())
        
        except (subprocess.SubprocessError, subprocess.TimeoutExpired):
            # Fallback to filesystem traversal with basic exclusions if git fails
            return self._discover_files_fallback(project_path)
        
        # Convert paths to FileStats objects
        file_count = 0
        for rel_path in file_paths:
            file_count += 1
            if file_count > 5000:  # Safety limit
                break
                
            file_path = project_path / rel_path
            
            # Skip if file doesn't exist (might be deleted)
            if not file_path.exists():
                continue
                
            # Skip symlinks
            if file_path.is_symlink():
                # Include symlinks as files but don't follow them
                stat_info = file_path.lstat()  # lstat doesn't follow symlinks
                
                files.append(FileStats(
                    path=rel_path,
                    size=stat_info.st_size,
                    modified=datetime.fromtimestamp(stat_info.st_mtime),
                    stats={}  # No git stats for symlinks
                ))
            else:
                stat_info = file_path.stat()
                
                # Get git statistics
                git_stats = self._get_git_stats(project_path, rel_path)
                
                files.append(FileStats(
                    path=rel_path,
                    size=stat_info.st_size,
                    modified=datetime.fromtimestamp(stat_info.st_mtime),
                    stats=git_stats
                ))
        
        return files
    
    def _discover_files_fallback(self, project_path: Path) -> List[FileStats]:
        """Fallback method for file discovery when git is not available."""
        files = []
        file_count = 0
        
        # Basic exclusions for common ignored directories
        excluded_dirs = {'.git', 'node_modules', 'venv', '__pycache__', '.pytest_cache', 
                        'build', 'dist', '.mypy_cache', '.tox', 'coverage_html', 
                        '.coverage', 'htmlcov', '.venv', 'env'}
        
        for root, dirs, filenames in os.walk(project_path):
            # Filter out excluded directories
            dirs[:] = [d for d in dirs if d not in excluded_dirs and not os.path.islink(os.path.join(root, d))]
            
            if file_count > 5000:  # Safety limit
                break
                
            for filename in filenames:
                file_count += 1
                if file_count > 5000:  # Safety limit
                    break
                    
                file_path = Path(root) / filename
                
                # Skip symlinks
                if file_path.is_symlink():
                    rel_path = file_path.relative_to(project_path).as_posix()
                    stat_info = file_path.lstat()
                    
                    files.append(FileStats(
                        path=rel_path,
                        size=stat_info.st_size,
                        modified=datetime.fromtimestamp(stat_info.st_mtime),
                        stats={}
                    ))
                else:
                    rel_path = file_path.relative_to(project_path).as_posix()
                    stat_info = file_path.stat()
                    
                    # Get git statistics
                    git_stats = self._get_git_stats(project_path, rel_path)
                    
                    files.append(FileStats(
                        path=rel_path,
                        size=stat_info.st_size,
                        modified=datetime.fromtimestamp(stat_info.st_mtime),
                        stats=git_stats
                    ))
        
        return files
    
    def _get_git_stats(self, project_path: Path, rel_path: str) -> Dict[str, Any]:
        """Get git statistics for a file."""
        try:
            # Check if file is tracked
            result = subprocess.run(
                ['git', 'ls-files', '--', rel_path],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=5  # Reduced timeout
            )
            
            is_tracked = bool(result.stdout.strip())
            
            if is_tracked:
                # Check if file is binary first
                file_path = project_path / rel_path
                if self._is_binary_file(file_path):
                    return {'is_tracked': True, 'binary': True}
                
                # Get diff stats for tracked text files only
                result = subprocess.run(
                    ['git', 'diff', '--numstat', 'HEAD', '--', rel_path],
                    cwd=project_path,
                    capture_output=True,
                    text=True,
                    timeout=5  # Reduced timeout
                )
                
                if result.returncode == 0 and result.stdout.strip():
                    # Parse numstat output: "added\tdeleted\tfilename"
                    lines = result.stdout.strip().split('\t')
                    if len(lines) >= 2:
                        try:
                            # If git reports '-' it usually means binary file
                            if lines[0] == '-' or lines[1] == '-':
                                return {'is_tracked': True, 'binary': True}
                            
                            added = int(lines[0])
                            removed = int(lines[1])
                            return {
                                'lines_added': added,
                                'lines_removed': removed,
                                'is_tracked': True
                            }
                        except ValueError:
                            # Binary file or other issue
                            return {'is_tracked': True, 'binary': True}
                
                # No changes or error
                return {'lines_added': 0, 'lines_removed': 0, 'is_tracked': True}
            
            else:
                # Untracked file - count total lines
                file_path = project_path / rel_path
                try:
                    if self._is_binary_file(file_path):
                        return {'is_tracked': False, 'binary': True}
                    
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                        line_count = sum(1 for _ in f)
                    
                    return {
                        'lines_added': line_count,  # All lines are "added" for new files
                        'lines_removed': 0,
                        'is_tracked': False
                    }
                except Exception:
                    return {'is_tracked': False, 'binary': True}
        
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, Exception):
            # Git command failed or not a git repo
            return {}
    
    def _is_binary_file(self, file_path: Path) -> bool:
        """Check if a file is binary by looking for null bytes in the first 8192 bytes."""
        try:
            with open(file_path, 'rb') as f:
                chunk = f.read(8192)
                return b'\0' in chunk
        except Exception:
            return True  # Assume binary if we can't read it
    
    def _build_tree(self, files: List[FileStats], expanded_dirs: Set[str]) -> DirectoryNode:
        """Build directory tree structure."""
        # Create all directory nodes
        all_dirs = set([''])  # Always include root
        all_dirs.update(expanded_dirs)
        
        # Add parent directories for all files
        for file_stat in files:
            parts = file_stat.path.split('/')
            for i in range(len(parts) - 1):  # Exclude the file name
                dir_path = '/'.join(parts[:i+1])
                all_dirs.add(dir_path)
        
        # Group files by their immediate parent directory
        files_by_dir: Dict[str, List[FileStats]] = {}
        for file_stat in files:
            parts = file_stat.path.split('/')
            parent_dir = '/'.join(parts[:-1]) if len(parts) > 1 else ''
            
            if parent_dir not in files_by_dir:
                files_by_dir[parent_dir] = []
            files_by_dir[parent_dir].append(file_stat)
        
        # Build tree recursively
        return self._build_directory_node_v2('', files_by_dir, all_dirs, expanded_dirs)
    
    def _build_directory_node_v2(
        self, 
        dir_path: str, 
        files_by_dir: Dict[str, List[FileStats]],
        all_dirs: Set[str],
        expanded_dirs: Set[str]
    ) -> DirectoryNode:
        """Build a single directory node (version 2)."""
        children = []
        
        if self._should_expand_dir(dir_path, expanded_dirs):
            # Directory is expanded - show its contents
            
            # Add files in this directory
            for file_stat in files_by_dir.get(dir_path, []):
                children.append(file_stat)
            
            # Add direct child directories
            child_dirs = []
            for other_dir in all_dirs:
                if self._is_direct_child_dir(other_dir, dir_path):
                    child_dirs.append(other_dir)
            
            for child_dir in sorted(child_dirs):
                child_node = self._build_directory_node_v2(child_dir, files_by_dir, all_dirs, expanded_dirs)
                children.append(child_node)
        
        return DirectoryNode(
            path=dir_path,
            children=children,
            stats={}  # Will be filled by _aggregate_stats
        )
    
    def _is_direct_child_dir(self, child_path: str, parent_path: str) -> bool:
        """Check if child_path is a direct child directory of parent_path."""
        if parent_path == '':
            # Root directory - child should have no '/' (single level)
            return child_path != '' and '/' not in child_path
        else:
            # Child should start with parent + '/' and have no more '/' after that
            prefix = parent_path + '/'
            if not child_path.startswith(prefix):
                return False
            remaining = child_path[len(prefix):]
            return remaining != '' and '/' not in remaining
    
    def _should_expand_dir(self, dir_path: str, expanded_dirs: Set[str]) -> bool:
        """Check if a directory should be expanded."""
        return dir_path in expanded_dirs
    
    def _aggregate_stats(self, node: DirectoryNode) -> None:
        """Recursively aggregate statistics up the tree."""
        aggregated: Dict[str, Any] = {}
        
        # If this directory is collapsed, we need to aggregate stats from all files beneath it
        if len(node.children) == 0:
            # Collapsed directory - aggregate from all files in subdirectories
            all_files_stats = self._get_all_files_stats_under_path(node.path)
            for file_stats in all_files_stats:
                for key, value in file_stats.items():
                    if isinstance(value, (int, float)) and key not in ['is_tracked', 'binary']:
                        aggregated[key] = aggregated.get(key, 0) + value
        else:
            # Expanded directory - aggregate from visible children
            for child in node.children:
                if isinstance(child, FileStats):
                    # Add file stats
                    for key, value in child.stats.items():
                        if isinstance(value, (int, float)) and key not in ['is_tracked', 'binary']:
                            aggregated[key] = aggregated.get(key, 0) + value
                        # Non-numeric values and flags are not aggregated
                
                elif isinstance(child, DirectoryNode):
                    # Recursively aggregate child directory first
                    self._aggregate_stats(child)
                    
                    # Add child directory stats
                    for key, value in child.stats.items():
                        if isinstance(value, (int, float)) and key not in ['is_tracked', 'binary']:
                            aggregated[key] = aggregated.get(key, 0) + value
        
        node.stats = aggregated
    
    def _get_all_files_stats_under_path(self, dir_path: str) -> List[Dict[str, Any]]:
        """Get stats for all files under a directory path from the original file list."""
        # This is a bit hacky but we need access to the original files list
        # In a real implementation, this might be refactored differently
        if not hasattr(self, '_all_files_cache'):
            return []
        
        stats_list = []
        for file_stat in self._all_files_cache:
            if dir_path == '':
                # Root directory - all files
                stats_list.append(file_stat.stats)
            elif file_stat.path.startswith(dir_path + '/'):
                # File is under this directory
                stats_list.append(file_stat.stats)
        return stats_list