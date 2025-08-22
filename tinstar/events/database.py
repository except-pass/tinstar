"""
Database layer for the Tinstar events system.
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from .models import Event, EventFilter


class EventsDatabase:
    """SQLite database manager for events storage."""
    
    def __init__(self, db_path: Optional[Path] = None):
        if db_path is None:
            tinstar_home = Path.home() / ".tinstar"
            tinstar_home.mkdir(exist_ok=True)
            db_dir = tinstar_home / "db"
            db_dir.mkdir(exist_ok=True)
            db_path = db_dir / "events.db"
        
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
            # Main events table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    hook_event_name TEXT NOT NULL,
                    transcript_path TEXT,
                    tinstar_term_name TEXT,
                    tool_name TEXT,
                    raw_data TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Specialized todos table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS todos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    tinstar_term_name TEXT,
                    type TEXT NOT NULL CHECK (type IN ('new', 'update')),
                    todo_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
                    priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Specialized files table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    tinstar_term_name TEXT,
                    file_path TEXT NOT NULL,
                    operation TEXT NOT NULL CHECK (operation IN ('write', 'edit', 'multiedit')),
                    lines_added INTEGER,
                    lines_removed INTEGER,
                    content_preview TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Create indexes for performance
            self._create_indexes(conn)
    
    def _create_indexes(self, conn: sqlite3.Connection):
        """Create database indexes for fast queries."""
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id)",
            "CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)",
            "CREATE INDEX IF NOT EXISTS idx_events_tinstar_term_name ON events(tinstar_term_name)",
            "CREATE INDEX IF NOT EXISTS idx_events_session_timestamp ON events(session_id, timestamp)",
            "CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name)",
            
            "CREATE INDEX IF NOT EXISTS idx_todos_session_id ON todos(session_id)",
            "CREATE INDEX IF NOT EXISTS idx_todos_timestamp ON todos(timestamp)",
            "CREATE INDEX IF NOT EXISTS idx_todos_tinstar_term_name ON todos(tinstar_term_name)",
            "CREATE INDEX IF NOT EXISTS idx_todos_session_timestamp ON todos(session_id, timestamp)",
            "CREATE INDEX IF NOT EXISTS idx_todos_todo_id ON todos(todo_id)",
            
            "CREATE INDEX IF NOT EXISTS idx_files_session_id ON files(session_id)",
            "CREATE INDEX IF NOT EXISTS idx_files_timestamp ON files(timestamp)",
            "CREATE INDEX IF NOT EXISTS idx_files_tinstar_term_name ON files(tinstar_term_name)",
            "CREATE INDEX IF NOT EXISTS idx_files_session_timestamp ON files(session_id, timestamp)",
            "CREATE INDEX IF NOT EXISTS idx_files_file_path ON files(file_path)",
        ]
        
        for index_sql in indexes:
            conn.execute(index_sql)
    
    def store_event(self, event: Event) -> int:
        """Store an event in the database."""
        with self.get_connection() as conn:
            cursor = conn.execute("""
                INSERT INTO events (
                    session_id, timestamp, hook_event_name, transcript_path,
                    tinstar_term_name, tool_name, raw_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                event.session_id,
                event.timestamp,
                event.hook_event_name,
                event.transcript_path,
                event.tinstar_term_name,
                event.tool_name,
                json.dumps(event.model_dump())
            ))
            return cursor.lastrowid
    
    def store_todo_events(self, session_id: str, timestamp: str, tinstar_term_name: Optional[str],
                         event_type: str, todos: List[Dict[str, Any]]):
        """Store todo events in the specialized todos table."""
        with self.get_connection() as conn:
            for todo in todos:
                conn.execute("""
                    INSERT INTO todos (
                        session_id, timestamp, tinstar_term_name, type,
                        todo_id, content, status, priority
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    session_id, timestamp, tinstar_term_name, event_type,
                    todo['id'], todo['content'], todo['status'], todo.get('priority')
                ))
    
    def store_file_event(self, session_id: str, timestamp: str, tinstar_term_name: Optional[str],
                        file_path: str, operation: str, lines_added: Optional[int] = None,
                        lines_removed: Optional[int] = None, content_preview: Optional[str] = None):
        """Store file event in the specialized files table."""
        with self.get_connection() as conn:
            conn.execute("""
                INSERT INTO files (
                    session_id, timestamp, tinstar_term_name, file_path,
                    operation, lines_added, lines_removed, content_preview
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session_id, timestamp, tinstar_term_name, file_path,
                operation, lines_added, lines_removed, content_preview
            ))
    
    def query_events(self, filter_params: EventFilter) -> List[Dict[str, Any]]:
        """Query events with filtering."""
        query = "SELECT * FROM events WHERE 1=1"
        params = []
        
        if filter_params.session_id:
            query += " AND session_id = ?"
            params.append(filter_params.session_id)
        
        if filter_params.start_time:
            query += " AND timestamp >= ?"
            params.append(filter_params.start_time)
        
        if filter_params.end_time:
            query += " AND timestamp <= ?"
            params.append(filter_params.end_time)
        
        if filter_params.tinstar_term_name:
            query += " AND tinstar_term_name = ?"
            params.append(filter_params.tinstar_term_name)
        
        if filter_params.event_type:
            query += " AND hook_event_name = ?"
            params.append(filter_params.event_type)
        
        query += " ORDER BY timestamp ASC"
        
        with self.get_connection() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    
    def query_todos(self, filter_params: EventFilter) -> List[Dict[str, Any]]:
        """Query todo events with filtering."""
        query = "SELECT * FROM todos WHERE 1=1"
        params = []
        
        if filter_params.session_id:
            query += " AND session_id = ?"
            params.append(filter_params.session_id)
        
        if filter_params.start_time:
            query += " AND timestamp >= ?"
            params.append(filter_params.start_time)
        
        if filter_params.end_time:
            query += " AND timestamp <= ?"
            params.append(filter_params.end_time)
        
        if filter_params.tinstar_term_name:
            query += " AND tinstar_term_name = ?"
            params.append(filter_params.tinstar_term_name)
        
        query += " ORDER BY timestamp ASC"
        
        with self.get_connection() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    
    def query_files(self, filter_params: EventFilter) -> List[Dict[str, Any]]:
        """Query file events with filtering."""
        query = "SELECT * FROM files WHERE 1=1"
        params = []
        
        if filter_params.session_id:
            query += " AND session_id = ?"
            params.append(filter_params.session_id)
        
        if filter_params.start_time:
            query += " AND timestamp >= ?"
            params.append(filter_params.start_time)
        
        if filter_params.end_time:
            query += " AND timestamp <= ?"
            params.append(filter_params.end_time)
        
        if filter_params.tinstar_term_name:
            query += " AND tinstar_term_name = ?"
            params.append(filter_params.tinstar_term_name)
        
        query += " ORDER BY timestamp ASC"
        
        with self.get_connection() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    
    def clear_events(self) -> Dict[str, int]:
        """Clear all events from database."""
        with self.get_connection() as conn:
            events_count = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            todos_count = conn.execute("SELECT COUNT(*) FROM todos").fetchone()[0]
            files_count = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]
            
            conn.execute("DELETE FROM events")
            conn.execute("DELETE FROM todos")
            conn.execute("DELETE FROM files")
            
            return {
                "events": events_count,
                "todos": todos_count,
                "files": files_count
            }
    
    def cleanup_old_events(self, retention_days: int = 30):
        """Remove events older than retention period."""
        cutoff_date = datetime.now() - timedelta(days=retention_days)
        cutoff_iso = cutoff_date.isoformat()
        
        with self.get_connection() as conn:
            events_deleted = conn.execute(
                "DELETE FROM events WHERE timestamp < ?", (cutoff_iso,)
            ).rowcount
            
            todos_deleted = conn.execute(
                "DELETE FROM todos WHERE timestamp < ?", (cutoff_iso,)
            ).rowcount
            
            files_deleted = conn.execute(
                "DELETE FROM files WHERE timestamp < ?", (cutoff_iso,)
            ).rowcount
            
            return {
                "events_deleted": events_deleted,
                "todos_deleted": todos_deleted,
                "files_deleted": files_deleted
            }
    
    def close(self):
        """Close database connections."""
        if hasattr(self._local, 'connection'):
            self._local.connection.close()
            delattr(self._local, 'connection')