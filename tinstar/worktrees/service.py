"""
Service layer for the Tinstar worktrees system.
"""
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

from .database import WorktreeDatabase
from .models import Worktree, WorktreeCreateRequest, WorktreeDeleteRequest, Commit


class WorktreeService:
    """Service for managing git worktrees."""
    
    def __init__(self, db: Optional[WorktreeDatabase] = None):
        self.db = db or WorktreeDatabase()
        self.base_dir = Path.home() / ".tinstar" / "worktrees"
        self.base_dir.mkdir(parents=True, exist_ok=True)
    
    def _run_git_command(self, command: List[str], cwd: str) -> Tuple[bool, str]:
        """Run a git command and return success status and output."""
        try:
            result = subprocess.run(
                command,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=30
            )
            return result.returncode == 0, result.stdout + result.stderr
        except subprocess.TimeoutExpired:
            return False, "Git command timed out"
        except Exception as e:
            return False, str(e)
    
    def _get_current_branch(self, project_path: str) -> Optional[str]:
        """Get current branch name from project directory."""
        # Try git branch --show-current first
        success, output = self._run_git_command(
            ["git", "branch", "--show-current"],
            project_path
        )
        
        if success and output.strip():
            return output.strip()
        
        # Fallback to symbolic-ref HEAD
        success, output = self._run_git_command(
            ["git", "symbolic-ref", "HEAD"],
            project_path
        )
        
        if success and output.strip():
            # Extract branch name from refs/heads/branch_name
            ref = output.strip()
            if ref.startswith("refs/heads/"):
                return ref[11:]  # Remove "refs/heads/" prefix
        
        return None
    
    def _get_head_commit(self, path: str) -> Optional[str]:
        """Get current HEAD commit SHA."""
        success, output = self._run_git_command(
            ["git", "rev-parse", "HEAD"],
            path
        )
        return output.strip() if success else None
    
    def _is_detached_head(self, path: str) -> bool:
        """Check if repository is in detached HEAD state."""
        success, output = self._run_git_command(
            ["git", "symbolic-ref", "-q", "HEAD"],
            path
        )
        return not success
    
    def _check_uncommitted_changes(self, path: str) -> Tuple[bool, str]:
        """Check for uncommitted changes in worktree."""
        success, output = self._run_git_command(
            ["git", "status", "--porcelain"],
            path
        )
        
        if not success:
            return False, "Failed to check git status"
        
        has_changes = bool(output.strip())
        return has_changes, output.strip()
    
    def _copy_unignored_files(self, source_path: str, dest_path: str, unignore_paths: List[str]) -> None:
        """Copy unignored files from source to destination."""
        source = Path(source_path)
        dest = Path(dest_path)
        
        for rel_path in unignore_paths:
            src_item = source / rel_path
            dest_item = dest / rel_path
            
            if not src_item.exists():
                continue  # Skip missing items as per spec
            
            # Ensure parent directory exists
            dest_item.parent.mkdir(parents=True, exist_ok=True)
            
            if src_item.is_file():
                shutil.copy2(src_item, dest_item)
            elif src_item.is_dir():
                if dest_item.exists():
                    shutil.rmtree(dest_item)
                shutil.copytree(src_item, dest_item)
    
    def list_worktrees(self, project: str) -> List[Worktree]:
        """List all worktrees for a project."""
        if not self.db.project_exists(project):
            raise ValueError("Project not found")
        
        worktrees = self.db.list_worktrees(project)
        
        # Update status for existing worktrees
        for worktree in worktrees:
            worktree_path = Path(worktree.path)
            if worktree_path.exists():
                head = self._get_head_commit(str(worktree_path))
                detached = self._is_detached_head(str(worktree_path))
                
                # Update database if status changed
                if head != worktree.head or detached != worktree.detached:
                    self.db.update_worktree_status(worktree.name, project, head, detached)
                    worktree.head = head
                    worktree.detached = detached
        
        return worktrees
    
    def create_worktree(self, request: WorktreeCreateRequest) -> Worktree:
        """Create a new worktree."""
        # Validate project exists
        if not self.db.project_exists(request.project):
            raise ValueError("Project not found")
        
        # Check if worktree name already exists for this project
        if self.db.get_worktree(request.name, request.project):
            raise ValueError(f"Worktree '{request.name}' already exists for project '{request.project}'")
        
        # Get project path
        project_path = self.db.get_project_path(request.project)
        if not project_path:
            raise ValueError("Project path not found")
        
        # Get current branch
        current_branch = self._get_current_branch(project_path)
        if not current_branch:
            raise ValueError("Cannot create worktree from detached HEAD")
        
        # Prepare paths
        worktree_path = self.base_dir / request.name
        branch_name = f"worktree/{request.name}"
        
        try:
            # Create worktree with new branch
            success, output = self._run_git_command([
                "git", "worktree", "add", str(worktree_path), 
                "-b", branch_name, current_branch
            ], project_path)
            
            if not success:
                raise RuntimeError(f"Failed to create git worktree: {output}")
            
            # Copy unignored files
            unignore_paths = self.db.get_project_unignore_paths(request.project)
            if unignore_paths:
                self._copy_unignored_files(project_path, str(worktree_path), unignore_paths)
            
            # Get initial HEAD commit
            head = self._get_head_commit(str(worktree_path))
            
            # Create worktree record
            worktree = Worktree(
                name=request.name,
                project=request.project,
                path=str(worktree_path),
                branch=branch_name,
                head=head,
                detached=False,
                created_at=datetime.now().isoformat()
            )
            
            self.db.create_worktree(worktree)
            return worktree
            
        except Exception as e:
            # Cleanup on failure
            self._cleanup_failed_worktree(str(worktree_path), branch_name, project_path)
            raise e
    
    def _cleanup_failed_worktree(self, worktree_path: str, branch_name: str, project_path: str):
        """Clean up partially created worktree."""
        # Remove directory if it exists
        path = Path(worktree_path)
        if path.exists():
            try:
                shutil.rmtree(path)
            except Exception:
                pass  # Best effort cleanup
        
        # Remove git branch if it was created
        try:
            self._run_git_command(["git", "branch", "-D", branch_name], project_path)
        except Exception:
            pass  # Best effort cleanup
    
    def delete_worktree(self, request: WorktreeDeleteRequest) -> bool:
        """Delete a worktree."""
        # Validate worktree exists
        worktree = self.db.get_worktree(request.name, request.project)
        if not worktree:
            raise ValueError("Worktree not found")
        
        # Get project path for git operations
        project_path = self.db.get_project_path(request.project)
        if not project_path:
            raise ValueError("Project path not found")
        
        worktree_path = Path(worktree.path)
        
        # Check for uncommitted changes if not forcing
        if not request.force and worktree_path.exists():
            has_changes, changes = self._check_uncommitted_changes(str(worktree_path))
            if has_changes:
                raise ValueError(f"Worktree has uncommitted changes:\n{changes}")
        
        # Remove worktree via git
        force_flag = ["--force"] if request.force else []
        success, output = self._run_git_command([
            "git", "worktree", "remove", str(worktree_path)
        ] + force_flag, project_path)
        
        # Remove from database (even if git removal failed)
        deleted = self.db.delete_worktree(request.name, request.project)
        
        if not success:
            # Log error but don't fail since we removed from database
            # In a real implementation, you'd use proper logging
            print(f"Warning: Git worktree removal failed: {output}")
        
        return deleted
    
    def find_worktrees_by_partial_name(self, partial_name: str) -> List[Worktree]:
        """Find worktrees by partial name across all projects."""
        return self.db.find_worktrees_by_partial_name(partial_name)
    
    def _parse_git_log_output(self, output: str, worktree_path: str) -> List[Commit]:
        """Parse git log output into Commit objects."""
        if not output.strip():
            return []
        
        commits = []
        lines = output.strip().split('\n')
        
        for line in lines:
            if not line.strip():
                continue
            
            # Parse format: "hash|author|timestamp|message"
            parts = line.split('|', 3)
            if len(parts) != 4:
                continue
            
            hash_short, author, timestamp_str, message = parts
            
            # Get full hash
            success, full_hash_output = self._run_git_command(
                ["git", "rev-parse", hash_short],
                worktree_path
            )
            full_hash = full_hash_output.strip() if success else hash_short
            
            # Get files changed count
            success, files_output = self._run_git_command(
                ["git", "show", "--name-only", "--format=", hash_short],
                worktree_path
            )
            files_changed = len([f for f in files_output.strip().split('\n') if f.strip()]) if success else 0
            
            # Convert timestamp to ISO format
            try:
                # Git log timestamp format: "2025-08-29 14:32:15 -0700"
                dt = datetime.strptime(timestamp_str.split(' ')[0] + ' ' + timestamp_str.split(' ')[1], 
                                     '%Y-%m-%d %H:%M:%S')
                iso_timestamp = dt.isoformat()
            except:
                iso_timestamp = timestamp_str
            
            commits.append(Commit(
                hash=full_hash,
                message=message.strip(),
                author=author.strip(),
                timestamp=iso_timestamp,
                files_changed=files_changed
            ))
        
        return commits
    
    def get_commits_for_worktree(self, worktree_name: str, project: str) -> List[Commit]:
        """Get commits made in a specific worktree that aren't in the main project."""
        # Get worktree from database
        worktree = self.db.get_worktree(worktree_name, project)
        if not worktree:
            return []
        
        # Get project path
        project_path = self.db.get_project_path(project)
        if not project_path:
            return []
        
        worktree_path = Path(worktree.path)
        if not worktree_path.exists():
            return []
        
        # Get project HEAD commit
        project_head_success, project_head_output = self._run_git_command(
            ["git", "rev-parse", "HEAD"],
            project_path
        )
        
        if not project_head_success:
            return []
        
        project_head = project_head_output.strip()
        
        # Use the git command: git log --oneline "$(git -C "$PROJECT" rev-parse HEAD)"..HEAD
        # But with more detailed format for parsing
        git_log_command = [
            "git", "log", 
            "--format=%h|%an|%ai|%s",  # hash|author|timestamp|message
            f"{project_head}..HEAD"
        ]
        
        success, output = self._run_git_command(git_log_command, str(worktree_path))
        
        if not success:
            return []
        
        return self._parse_git_log_output(output, str(worktree_path))
    
    def get_commits_by_session(self, session_id: Optional[str] = None, tinstar_term_name: Optional[str] = None) -> List[Commit]:
        """Get commits for a session identified by session_id or tinstar_term_name."""
        if not session_id and not tinstar_term_name:
            return []
        
        # Find worktrees that match the session criteria
        # This is a simplified approach - in a real implementation we'd need
        # to track session-to-worktree mapping more explicitly
        
        if tinstar_term_name:
            # Use the partial name search to find matching worktrees
            worktrees = self.db.find_worktrees_by_partial_name(tinstar_term_name)
            
            all_commits = []
            for worktree in worktrees:
                if worktree.name == tinstar_term_name:  # Exact match
                    commits = self.get_commits_for_worktree(worktree.name, worktree.project)
                    all_commits.extend(commits)
            
            return all_commits
        
        # For session_id, we'd need additional mapping logic
        # For now, return empty list as this requires more complex session tracking
        return []