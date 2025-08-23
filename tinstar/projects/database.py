"""
Database layer for the Tinstar projects system.
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Optional

from .models import Project


class ProjectsDatabase:
    """SQLite database manager for projects storage."""
    
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
            # Projects table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS projects (
                    name TEXT PRIMARY KEY,
                    path TEXT UNIQUE NOT NULL,
                    created_at TEXT NOT NULL,
                    default_branch TEXT,
                    unignore_paths TEXT NOT NULL DEFAULT '[]'
                )
            """)
            
            # Create indexes for performance
            conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at)")
    
    def create_project(self, project: Project) -> Project:
        """Create a new project in the database."""
        with self.get_connection() as conn:
            try:
                conn.execute("""
                    INSERT INTO projects (name, path, created_at, default_branch, unignore_paths)
                    VALUES (?, ?, ?, ?, ?)
                """, (
                    project.name,
                    project.path,
                    project.created_at,
                    project.default_branch,
                    json.dumps(project.unignore_paths)
                ))
                return project
            except sqlite3.IntegrityError as e:
                if "name" in str(e):
                    raise ValueError(f"Project name '{project.name}' already exists")
                elif "path" in str(e):
                    raise ValueError(f"Project path '{project.path}' is already registered")
                else:
                    raise ValueError(f"Project creation failed: {e}")
    
    def get_project(self, name: str) -> Optional[Project]:
        """Get a project by name."""
        with self.get_connection() as conn:
            cursor = conn.execute(
                "SELECT name, path, created_at, default_branch, unignore_paths FROM projects WHERE name = ?",
                (name,)
            )
            row = cursor.fetchone()
            if row:
                return Project(
                    name=row['name'],
                    path=row['path'],
                    created_at=row['created_at'],
                    default_branch=row['default_branch'],
                    unignore_paths=json.loads(row['unignore_paths'])
                )
            return None
    
    def list_projects(self) -> List[Project]:
        """List all projects ordered by created_at."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT name, path, created_at, default_branch, unignore_paths 
                FROM projects 
                ORDER BY created_at ASC
            """)
            projects = []
            for row in cursor.fetchall():
                projects.append(Project(
                    name=row['name'],
                    path=row['path'],
                    created_at=row['created_at'],
                    default_branch=row['default_branch'],
                    unignore_paths=json.loads(row['unignore_paths'])
                ))
            return projects
    
    def update_project(self, name: str, updates: Dict) -> Optional[Project]:
        """Update a project's settings."""
        with self.get_connection() as conn:
            # Check if project exists
            if not self.get_project(name):
                return None
            
            # Build update query
            set_clauses = []
            params = []
            
            if 'unignore_paths' in updates:
                set_clauses.append("unignore_paths = ?")
                params.append(json.dumps(updates['unignore_paths']))
            
            if 'default_branch' in updates:
                set_clauses.append("default_branch = ?")
                params.append(updates['default_branch'])
            
            if not set_clauses:
                # No updates to apply
                return self.get_project(name)
            
            params.append(name)  # For WHERE clause
            
            conn.execute(f"""
                UPDATE projects 
                SET {', '.join(set_clauses)}
                WHERE name = ?
            """, params)
            
            return self.get_project(name)
    
    def delete_project(self, name: str) -> bool:
        """Delete a project by name."""
        with self.get_connection() as conn:
            cursor = conn.execute("DELETE FROM projects WHERE name = ?", (name,))
            return cursor.rowcount > 0
    
    def project_exists_by_name(self, name: str) -> bool:
        """Check if a project exists by name."""
        with self.get_connection() as conn:
            cursor = conn.execute("SELECT 1 FROM projects WHERE name = ? LIMIT 1", (name,))
            return cursor.fetchone() is not None
    
    def project_exists_by_path(self, path: str) -> bool:
        """Check if a project exists by path."""
        with self.get_connection() as conn:
            cursor = conn.execute("SELECT 1 FROM projects WHERE path = ? LIMIT 1", (path,))
            return cursor.fetchone() is not None
    
    def close(self):
        """Close database connections."""
        if hasattr(self._local, 'connection'):
            self._local.connection.close()
            delattr(self._local, 'connection')