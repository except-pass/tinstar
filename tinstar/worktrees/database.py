"""
Database layer for the Tinstar worktrees system.
"""
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import List, Optional

from .models import Worktree


class WorktreeDatabase:
    """SQLite database manager for worktrees storage."""
    
    def __init__(self, db_path: Optional[Path] = None):
        if db_path is None:
            tinstar_home = Path.home() / ".tinstar"
            tinstar_home.mkdir(exist_ok=True)
            db_dir = tinstar_home / "db"
            db_dir.mkdir(exist_ok=True)
            db_path = db_dir / "tinstar.db"
        
        self.db_path = db_path
        self._local = threading.local()
        self._init_database()
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get thread-local database connection."""
        if not hasattr(self._local, 'connection'):
            self._local.connection = sqlite3.connect(
                str(self.db_path),
                check_same_thread=False,
                timeout=30.0
            )
            self._local.connection.row_factory = sqlite3.Row
            # Enable WAL mode for better concurrency
            self._local.connection.execute("PRAGMA journal_mode=WAL")
            self._local.connection.execute("PRAGMA synchronous=NORMAL")
            self._local.connection.execute("PRAGMA foreign_keys=ON")
        
        return self._local.connection
    
    @contextmanager
    def get_connection(self):
        """Context manager for database connections."""
        conn = self._get_connection()
        try:
            yield conn
        except Exception:
            conn.rollback()
            raise
        else:
            conn.commit()
    
    def _init_database(self):
        """Initialize database schema."""
        with self.get_connection() as conn:
            # Create projects table first (if it doesn't exist)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS projects (
                    name TEXT PRIMARY KEY,
                    path TEXT UNIQUE NOT NULL,
                    default_branch TEXT,
                    unignore_paths TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL
                )
            """)
            
            # Worktrees table with foreign key constraint
            conn.execute("""
                CREATE TABLE IF NOT EXISTS worktrees (
                    name TEXT NOT NULL,
                    project TEXT NOT NULL,
                    path TEXT NOT NULL,
                    branch TEXT NOT NULL,
                    head TEXT,
                    detached BOOLEAN NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (name, project),
                    FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
                )
            """)
            
            # Create indexes for performance
            self._create_indexes(conn)
    
    def _create_indexes(self, conn: sqlite3.Connection):
        """Create database indexes for fast queries."""
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project)",
            "CREATE INDEX IF NOT EXISTS idx_worktrees_name ON worktrees(name)",
            "CREATE INDEX IF NOT EXISTS idx_worktrees_created_at ON worktrees(created_at)",
        ]
        
        for index_sql in indexes:
            conn.execute(index_sql)
    
    def create_worktree(self, worktree: Worktree) -> None:
        """Create a new worktree record."""
        with self.get_connection() as conn:
            conn.execute("""
                INSERT INTO worktrees (
                    name, project, path, branch, head, detached, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                worktree.name,
                worktree.project,
                worktree.path,
                worktree.branch,
                worktree.head,
                worktree.detached,
                worktree.created_at
            ))
    
    def get_worktree(self, name: str, project: str) -> Optional[Worktree]:
        """Get a specific worktree by name and project."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT name, project, path, branch, head, detached, created_at
                FROM worktrees
                WHERE name = ? AND project = ?
            """, (name, project))
            
            row = cursor.fetchone()
            if row:
                return Worktree(
                    name=row['name'],
                    project=row['project'],
                    path=row['path'],
                    branch=row['branch'],
                    head=row['head'],
                    detached=bool(row['detached']),
                    created_at=row['created_at']
                )
            return None
    
    def find_worktrees_by_partial_name(self, partial_name: str) -> List[Worktree]:
        """Find worktrees that start with the given partial name across all projects."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT name, project, path, branch, head, detached, created_at
                FROM worktrees
                WHERE name LIKE ?
                ORDER BY created_at DESC
            """, (f"{partial_name}%",))
            
            worktrees = []
            for row in cursor.fetchall():
                worktrees.append(Worktree(
                    name=row['name'],
                    project=row['project'],
                    path=row['path'],
                    branch=row['branch'],
                    head=row['head'],
                    detached=bool(row['detached']),
                    created_at=row['created_at']
                ))
            
            return worktrees
    
    def list_worktrees(self, project: str) -> List[Worktree]:
        """List all worktrees for a project."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT name, project, path, branch, head, detached, created_at
                FROM worktrees
                WHERE project = ?
                ORDER BY created_at ASC
            """, (project,))
            
            return [
                Worktree(
                    name=row['name'],
                    project=row['project'],
                    path=row['path'],
                    branch=row['branch'],
                    head=row['head'],
                    detached=bool(row['detached']),
                    created_at=row['created_at']
                )
                for row in cursor.fetchall()
            ]
    
    def update_worktree_status(self, name: str, project: str, head: Optional[str], detached: bool) -> None:
        """Update worktree git status."""
        with self.get_connection() as conn:
            conn.execute("""
                UPDATE worktrees 
                SET head = ?, detached = ?
                WHERE name = ? AND project = ?
            """, (head, detached, name, project))
    
    def delete_worktree(self, name: str, project: str) -> bool:
        """Delete a worktree record."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                DELETE FROM worktrees
                WHERE name = ? AND project = ?
            """, (name, project))
            return cursor.rowcount > 0
    
    def project_exists(self, project: str) -> bool:
        """Check if a project exists."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT 1 FROM projects WHERE name = ?
            """, (project,))
            return cursor.fetchone() is not None
    
    def get_project_path(self, project: str) -> Optional[str]:
        """Get project path."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT path FROM projects WHERE name = ?
            """, (project,))
            row = cursor.fetchone()
            return row['path'] if row else None
    
    def get_project_unignore_paths(self, project: str) -> List[str]:
        """Get project unignore paths."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT unignore_paths FROM projects WHERE name = ?
            """, (project,))
            row = cursor.fetchone()
            if row and row['unignore_paths']:
                # Assuming unignore_paths is stored as JSON string or comma-separated
                import json
                try:
                    return json.loads(row['unignore_paths'])
                except (json.JSONDecodeError, TypeError):
                    # Fallback to comma-separated parsing
                    return [p.strip() for p in row['unignore_paths'].split(',') if p.strip()]
            return []
    
    def close(self):
        """Close database connections."""
        if hasattr(self._local, 'connection'):
            self._local.connection.close()
            delattr(self._local, 'connection')