import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnsiUp } from 'ansi_up';
import './DetailsPane.css';
import FileList from './FileList';
import { ControlBoard } from '../control_board';

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
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [terminated, setTerminated] = useState<boolean>(false);

  const terminalRef = useRef<HTMLPreElement | null>(null);
  const hasAutoScrolled = useRef(false);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    
    // Clear existing timeout
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    
    // Auto-hide after 4 seconds
    toastTimeoutRef.current = setTimeout(() => {
      setToast(null);
      toastTimeoutRef.current = null;
    }, 4000);
  };

  const ansiUp = useMemo(() => {
    const ansi = new (AnsiUp as any)();
    ansi.use_classes = true;
    return ansi;
  }, []);

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

  // On first load of terminal lines, scroll to bottom so newest output is visible
  useEffect(() => {
    if (!hasAutoScrolled.current && terminalLines.length > 0) {
      hasAutoScrolled.current = true;
      requestAnimationFrame(() => {
        const el = terminalRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  }, [terminalLines]);

  // Fetch todos
  useEffect(() => {
    const fetchTodos = async () => {
      try {
        const query = session?.name
          ? `/api/events/todos?tinstar_term_name=${encodeURIComponent(session.name)}`
          : `/api/events/todos?session_id=${sessionId}`;
        const res = await fetch(query);
        if (res.ok) {
          const data = await res.json();
          setTodos(data);
        }
      } catch (err: any) {
        setError(err.message);
      }
    };
    fetchTodos();
  }, [sessionId, session?.name]);

  // Fetch event stats
  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const query = session?.name
          ? `/api/events?tinstar_term_name=${encodeURIComponent(session.name)}`
          : `/api/events?session_id=${sessionId}`;
        const res = await fetch(query);
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
  }, [sessionId, session?.name]);

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

  const handleSaveChanges = async () => {
    if (!session) return;
    try {
      const commitPrompt = "Please create a git commit with all staged and unstaged files in the current worktree. Use a helpful commit message that describes the changes.";
      await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: commitPrompt })
      });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleMergeWorktree = async () => {
    if (!session) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message + (data.details ? `\n${data.details}` : ''), 'success');
      } else {
        const errorData = await res.json();
        throw new Error(errorData.detail || 'Failed to merge worktree');
      }
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  return (
    <div className="details-pane content-section">
      {error && <div className="error">{error}</div>}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          <div className="toast-content">
            {toast.message}
            <button 
              className="toast-close" 
              onClick={() => setToast(null)}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
      )}
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

      <div className="details-content">
        <div className="details-main">
          <div className="terminal-section">
            <h3>Terminal Output</h3>
            <pre className="terminal-output" ref={terminalRef}>
              {terminalLines.map((line, idx) => (
                <div key={idx} dangerouslySetInnerHTML={{ __html: ansiUp.ansi_to_html(line) }} />
              ))}
            </pre>
            <div className="command-input">
              <textarea
                value={commandText}
                onChange={(e) => setCommandText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Send command (Enter to send, Shift+Enter for newline)"
              />
              <button onClick={handleSend}>Send</button>
            </div>
          </div>

          <div className="actions">
            <button onClick={handleSaveChanges} className="save">Save Changes</button>
            <button onClick={handleMergeWorktree} className="merge">Merge Worktree</button>
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

        <div className="details-sidebar">
          <ControlBoard sessionId={sessionId} />
          {session && (
            <FileList sessionId={sessionId} project={session.project} />
          )}
        </div>
      </div>
    </div>
  );
};

export default DetailsPane;
