import React, { useEffect, useState } from 'react';
import './DetailsPane.css';

interface DetailsPaneProps {
  sessionId: string;
}

interface Session {
  id: string;
  name: string;
  project: string;
  status?: string;
  initial_prompt?: string;
}

interface TodoEvent {
  [key: string]: any;
}

interface Event {
  hook_event_name: string;
}

export const DetailsPane: React.FC<DetailsPaneProps> = ({ sessionId }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [commandText, setCommandText] = useState('');
  const [todos, setTodos] = useState<TodoEvent[]>([]);
  const [eventStats, setEventStats] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [terminated, setTerminated] = useState<boolean>(false);

  // Fetch session details
  useEffect(() => {
    if (terminated) return;
    const fetchSession = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (!res.ok) throw new Error('Failed to fetch session');
        const data = await res.json();
        setSession(data.session || null);
      } catch (err: any) {
        setError(err.message);
      }
    };
    fetchSession();
  }, [sessionId, terminated]);

  // Poll terminal output
  useEffect(() => {
    if (terminated) {
      setTerminalLines([]);
      return;
    }
    let isMounted = true;
    const fetchPeek = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/peek?lines=50`);
        if (res.status === 404) {
          if (isMounted) setTerminalLines([]);
          return;
        }
        if (!res.ok) throw new Error('Failed to fetch terminal output');
        const data = await res.json();
        const lines: string[] = (data && data.peek && Array.isArray(data.peek.lines)) ? data.peek.lines : [];
        if (isMounted) {
          setTerminalLines(lines);
        }
      } catch (err: any) {
        if (isMounted) setError(err.message);
      }
    };
    fetchPeek();
    const interval = setInterval(fetchPeek, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [sessionId, terminated]);

  // Fetch todos
  useEffect(() => {
    const fetchTodos = async () => {
      try {
        const res = await fetch(`/api/events/todos?session_id=${sessionId}`);
        if (res.ok) {
          const data = await res.json();
          setTodos(data);
        }
      } catch (err: any) {
        setError(err.message);
      }
    };
    fetchTodos();
  }, [sessionId]);

  // Fetch event stats
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const res = await fetch(`/api/events?session_id=${sessionId}`);
        if (res.ok) {
          const data: Event[] = await res.json();
          const counts: Record<string, number> = {};
          data.forEach((evt) => {
            counts[evt.hook_event_name] = (counts[evt.hook_event_name] || 0) + 1;
          });
          setEventStats(counts);
        }
      } catch (err: any) {
        setError(err.message);
      }
    };
    fetchEvents();
  }, [sessionId]);

  const handleSend = async () => {
    try {
      await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: commandText })
      });
      setCommandText('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleTerminate = async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      if (res.ok) {
        setTerminated(true);
        setSession((prev) => prev ? { ...prev, status: 'stopped' } : prev);
        setTerminalLines(["Session terminated."]);
        // Notify MasterUI to auto-select next agent
        window.dispatchEvent(new CustomEvent('tinstar', { detail: { type: 'session-terminated', payload: { sessionId } } }));
      } else {
        // Try to parse JSON detail to show worktree removal errors
        let message = 'Failed to terminate session';
        try {
          const errorData = await res.json();
          message = errorData.detail || errorData.message || message;
        } catch {
          const txt = await res.text();
          if (txt) message = txt;
        }
        throw new Error(message);
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteWorktree = async () => {
    if (!session) return;
    try {
      await fetch(`/api/worktrees/${session.id}?project=${session.project}`, {
        method: 'DELETE'
      });
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="details-pane content-section">
      {error && <div className="error">{error}</div>}
      {session ? (
        <div className="session-info">
          <h2>{session.name}</h2>
          <p><strong>Project:</strong> {session.project}</p>
          {session.initial_prompt && (
            <p><strong>Initial Prompt:</strong> {session.initial_prompt}</p>
          )}
        </div>
      ) : (
        <p>Loading session...</p>
      )}

      <div className="terminal-section">
        <h3>Terminal Output</h3>
        <pre className="terminal-output">
          {terminalLines.map((line, idx) => (
            <div key={idx}>{line}</div>
          ))}
        </pre>
        <div className="command-input">
          <input
            type="text"
            value={commandText}
            onChange={(e) => setCommandText(e.target.value)}
            placeholder="Send command"
          />
          <button onClick={handleSend}>Send</button>
        </div>
      </div>

      <div className="actions">
        <button onClick={handleTerminate} className="danger">Terminate Session</button>
        <button onClick={handleDeleteWorktree}>Delete Worktree</button>
      </div>

      <div className="todos-section">
        <h3>Todos</h3>
        {todos.length ? (
          <ul>
            {todos.map((todo, idx) => (
              <li key={idx}>{todo.message || JSON.stringify(todo)}</li>
            ))}
          </ul>
        ) : (
          <p>No todos</p>
        )}
      </div>

      <div className="event-stats">
        <h3>Event Stats</h3>
        {Object.keys(eventStats).length ? (
          <ul>
            {Object.entries(eventStats).map(([type, count]) => (
              <li key={type}>{type}: {count}</li>
            ))}
          </ul>
        ) : (
          <p>No events</p>
        )}
      </div>
    </div>
  );
};

export default DetailsPane;
