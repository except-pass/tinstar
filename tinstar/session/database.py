"""
Database layer for the Tinstar session management system.
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .models import Session


class SessionDatabase:
    """SQLite database manager for session storage."""
    
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
            # Sessions table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    project TEXT NOT NULL,
                    worktree_name TEXT NOT NULL,
                    worktree_path TEXT NOT NULL,
                    tmux_session_name TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL CHECK (status IN ('active', 'stopped', 'error')),
                    created_at TEXT NOT NULL,
                    last_activity TEXT NOT NULL,
                    agent_type TEXT NOT NULL DEFAULT 'claude',
                    initial_prompt TEXT
                )
            """)
            
            # Session logs table for terminal output
            conn.execute("""
                CREATE TABLE IF NOT EXISTS session_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    log_line TEXT NOT NULL,
                    line_number INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
            """)
            
            # Session policies table for notification responses
            conn.execute("""
                CREATE TABLE IF NOT EXISTS session_policies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    notification_type TEXT NOT NULL,
                    response TEXT NOT NULL CHECK (response IN ('approve_once', 'approve_always', 'deny')),
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                )
            """)
            
            # Create indexes for performance
            self._create_indexes(conn)
    
    def _create_indexes(self, conn: sqlite3.Connection):
        """Create database indexes for fast queries."""
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity)",
            
            "CREATE INDEX IF NOT EXISTS idx_session_logs_session_id ON session_logs(session_id)",
            "CREATE INDEX IF NOT EXISTS idx_session_logs_timestamp ON session_logs(timestamp)",
            "CREATE INDEX IF NOT EXISTS idx_session_logs_session_timestamp ON session_logs(session_id, timestamp)",
            
            "CREATE INDEX IF NOT EXISTS idx_session_policies_session_id ON session_policies(session_id)",
            "CREATE INDEX IF NOT EXISTS idx_session_policies_type ON session_policies(notification_type)",
        ]
        
        for index_sql in indexes:
            conn.execute(index_sql)
    
    def create_session(self, session: Session) -> str:
        """Create a new session in the database."""
        with self.get_connection() as conn:
            conn.execute("""
                INSERT INTO sessions (
                    id, name, project, worktree_name, worktree_path,
                    tmux_session_name, status, created_at, last_activity,
                    agent_type, initial_prompt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session.id,
                session.name,
                session.project,
                session.worktree_name,
                session.worktree_path,
                session.tmux_session_name,
                session.status,
                session.created_at,
                session.last_activity,
                session.agent_type,
                session.initial_prompt
            ))
            return session.id
    
    def get_session(self, session_id: str) -> Optional[Session]:
        """Get a session by ID."""
        with self.get_connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,)
            )
            row = cursor.fetchone()
            if row:
                return Session(**dict(row))
            return None
    
    def get_session_by_name(self, name: str) -> Optional[Session]:
        """Get a session by name."""
        with self.get_connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM sessions WHERE name = ?",
                (name,)
            )
            row = cursor.fetchone()
            if row:
                return Session(**dict(row))
            return None
    
    def list_sessions(self, project: Optional[str] = None, status: Optional[str] = None) -> List[Session]:
        """List sessions with optional filtering."""
        query = "SELECT * FROM sessions WHERE 1=1"
        params = []
        
        if project:
            query += " AND project = ?"
            params.append(project)
        
        if status:
            query += " AND status = ?"
            params.append(status)
        
        query += " ORDER BY created_at DESC"
        
        with self.get_connection() as conn:
            cursor = conn.execute(query, params)
            return [Session(**dict(row)) for row in cursor.fetchall()]
    
    def update_session_status(self, session_id: str, status: str) -> bool:
        """Update session status."""
        with self.get_connection() as conn:
            cursor = conn.execute(
                "UPDATE sessions SET status = ?, last_activity = ? WHERE id = ?",
                (status, datetime.now().isoformat(), session_id)
            )
            return cursor.rowcount > 0
    
    def update_session_activity(self, session_id: str) -> bool:
        """Update session last activity timestamp."""
        with self.get_connection() as conn:
            cursor = conn.execute(
                "UPDATE sessions SET last_activity = ? WHERE id = ?",
                (datetime.now().isoformat(), session_id)
            )
            return cursor.rowcount > 0
    
    def delete_session(self, session_id: str) -> bool:
        """Delete a session from the database."""
        with self.get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM sessions WHERE id = ?",
                (session_id,)
            )
            return cursor.rowcount > 0
    
    def store_session_log(self, session_id: str, log_line: str, line_number: int) -> int:
        """Store a session log line."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                INSERT INTO session_logs (
                    session_id, timestamp, log_line, line_number
                ) VALUES (?, ?, ?, ?)
            """, (
                session_id,
                datetime.now().isoformat(),
                log_line,
                line_number
            ))
            return cursor.lastrowid
    
    def get_session_logs(self, session_id: str, lines: int = 50) -> List[Dict[str, Any]]:
        """Get recent session logs."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT log_line, timestamp, line_number 
                FROM session_logs 
                WHERE session_id = ? 
                ORDER BY line_number DESC 
                LIMIT ?
            """, (session_id, lines))
            return [dict(row) for row in cursor.fetchall()]
    
    def clear_session_logs(self, session_id: str) -> int:
        """Clear all logs for a session."""
        with self.get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM session_logs WHERE session_id = ?",
                (session_id,)
            )
            return cursor.rowcount
    
    def store_session_policy(self, session_id: str, notification_type: str, response: str) -> int:
        """Store a session notification policy."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                INSERT INTO session_policies (
                    session_id, notification_type, response
                ) VALUES (?, ?, ?)
            """, (session_id, notification_type, response))
            return cursor.lastrowid
    
    def get_session_policy(self, session_id: str, notification_type: str) -> Optional[str]:
        """Get session policy for a notification type."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                SELECT response FROM session_policies 
                WHERE session_id = ? AND notification_type = ? 
                ORDER BY created_at DESC 
                LIMIT 1
            """, (session_id, notification_type))
            row = cursor.fetchone()
            return row[0] if row else None
    
    def close(self):
        """Close database connections."""
        if hasattr(self._local, 'connection'):
            self._local.connection.close()
            delattr(self._local, 'connection')