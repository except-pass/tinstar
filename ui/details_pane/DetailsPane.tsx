import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnsiUp } from 'ansi_up';
import './DetailsPane.css';
import FileList from './FileList';
import { ControlBoard } from '../control_board';
import { useQuickDrawDetailsActions } from '../quick_draw/useQuickDrawDetailsActions';
import { Timeline, TimelineEvent } from '../timeline';
import { useTimelineEvents } from '../timeline/useTimelineEvents';

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
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
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
  const [selectedTimelineEvent, setSelectedTimelineEvent] = useState<TimelineEvent | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [extractedPrompts, setExtractedPrompts] = useState<Record<number, string>>({});

  const terminalRef = useRef<HTMLPreElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hasAutoScrolled = useRef(false);
  const toastTimeoutRef = useRef<number | null>(null);

  // Get timeline events for prompt extraction
  const { events } = useTimelineEvents(sessionId, session?.name);

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

  // Extract prompt content from an event synchronously first, then async if needed
  const extractPromptFromEvent = useCallback((event: any): string | null => {
    if (!event) return null;
    
    console.log('DetailsPane Debug - Extracting from event:', event);
    
    // For UserPromptSubmit events, check hook_data first (this is where the actual prompt text is stored)
    if (event.hook_event_name === 'UserPromptSubmit' && event.hook_data) {
      console.log('DetailsPane Debug - Found UserPromptSubmit with hook_data:', event.hook_data);
      if (typeof event.hook_data === 'string') {
        try {
          const parsed = JSON.parse(event.hook_data);
          if (parsed.text) return parsed.text;
          if (parsed.message) return parsed.message;
          if (parsed.prompt) return parsed.prompt;
        } catch (e) {
          // If it's not JSON, maybe it's the raw text
          return event.hook_data;
        }
      } else if (event.hook_data && typeof event.hook_data === 'object') {
        if (event.hook_data.text) return event.hook_data.text;
        if (event.hook_data.message) return event.hook_data.message;
        if (event.hook_data.prompt) return event.hook_data.prompt;
      }
    }
    
    // Check various places where prompt content might be stored
    if (event.message) return event.message;
    if (event.tool_input?.text) return event.tool_input.text;
    if (event.tool_input?.prompt) return event.tool_input.prompt;
    if (event.prompt) return event.prompt;
    if (event.text) return event.text;  // Sometimes it might be in a text field
    
    // Check if it's in the raw data structure
    if (typeof event.raw_data === 'string') {
      try {
        const parsed = JSON.parse(event.raw_data);
        if (parsed.message) return parsed.message;
        if (parsed.text) return parsed.text;
        if (parsed.prompt) return parsed.prompt;
      } catch (e) {
        // Ignore parse errors
      }
    } else if (event.raw_data && typeof event.raw_data === 'object') {
      if (event.raw_data.message) return event.raw_data.message;
      if (event.raw_data.text) return event.raw_data.text;
      if (event.raw_data.prompt) return event.raw_data.prompt;
    }
    
    return null;
  }, []);

  // Extract prompts from events and sessions  
  useEffect(() => {
    const extractPromptsFromEvents = async () => {
      if (!events.length) return;
      
      const userPromptEvents = events.filter(event => 
        event.hook_event_name?.toLowerCase() === 'userpromptsubmit' ||
        event.hook_event_name?.toLowerCase() === 'user_prompt' ||
        event.hook_event_name === 'UserPromptSubmit'
      );
      
      const newExtractedPrompts: Record<number, string> = {};
      
      for (const event of userPromptEvents) {
        // Skip if we already have the content extracted
        if (extractedPrompts[event.id]) continue;
        
        // Try to get content synchronously first
        const syncContent = extractPromptFromEvent(event);
        if (syncContent) {
          newExtractedPrompts[event.id] = syncContent;
          continue;
        }
        
        // For UserPromptSubmit events without content, fetch from transcript
        if (event.transcript_path) {
          // For the first event, use the session's initial_prompt if available
          const isFirstEvent = userPromptEvents.findIndex(e => e.id === event.id) === 0;
          if (isFirstEvent && session?.initial_prompt) {
            newExtractedPrompts[event.id] = session.initial_prompt;
          } else {
            // For subsequent events, fetch from the transcript API
            try {
              console.log('Fetching transcript for event:', event.id, 'from:', event.transcript_path);
              const response = await fetch(`/api/events/transcript?transcript_path=${encodeURIComponent(event.transcript_path)}&timestamp=${encodeURIComponent(event.timestamp)}`);
              
              if (response.ok) {
                const data = await response.json();
                if (data.content) {
                  newExtractedPrompts[event.id] = data.content;
                  console.log('Successfully extracted prompt for event:', event.id, 'content length:', data.content.length);
                } else {
                  console.warn('No content found in transcript for event:', event.id, data.error || 'Unknown error');
                  newExtractedPrompts[event.id] = `[Prompt from ${new Date(event.timestamp).toLocaleString()}]`;
                }
              } else {
                console.warn('Failed to fetch transcript for event:', event.id, 'status:', response.status);
                newExtractedPrompts[event.id] = `[Prompt from ${new Date(event.timestamp).toLocaleString()}]`;
              }
            } catch (error) {
              console.error('Failed to read transcript for event:', event.id, error);
              newExtractedPrompts[event.id] = `[Prompt from ${new Date(event.timestamp).toLocaleString()}]`;
            }
          }
        } else {
          // Fallback if no transcript path
          const eventDate = new Date(event.timestamp).toLocaleString();
          newExtractedPrompts[event.id] = `[User prompt submitted at ${eventDate}]`;
        }
      }
      
      if (Object.keys(newExtractedPrompts).length > 0) {
        setExtractedPrompts(prev => ({ ...prev, ...newExtractedPrompts }));
      }
    };
    
    extractPromptsFromEvents();
  }, [events, session?.initial_prompt, extractedPrompts, extractPromptFromEvent]);

  // Determine which prompts to show (up to 3: initial, latest if different, selected if different)
  const promptsToShow = useMemo(() => {
    const prompts: Array<{label: string, content: string}> = [];
    
    // Debug logging
    console.log('DetailsPane Debug - Events:', events.length);
    console.log('DetailsPane Debug - Event types:', events.map(e => e.hook_event_name));
    console.log('DetailsPane Debug - Selected prompt:', selectedPrompt);
    console.log('DetailsPane Debug - Extracted prompts:', extractedPrompts);
    
    // Always show initial prompt if available
    if (session?.initial_prompt) {
      prompts.push({
        label: 'Initial Prompt',
        content: session.initial_prompt
      });
    }
    
    // Find all user prompt events and get the latest one
    const userPromptEvents = events.filter(event => 
      event.hook_event_name?.toLowerCase() === 'userpromptsubmit' ||
      event.hook_event_name?.toLowerCase() === 'user_prompt' ||
      event.hook_event_name === 'UserPromptSubmit'
    );
    
    console.log('DetailsPane Debug - User prompt events found:', userPromptEvents.length);
    if (userPromptEvents.length > 0) {
      console.log('DetailsPane Debug - Sample user prompt event:', userPromptEvents[0]);
    }
    
    if (userPromptEvents.length > 0) {
      // Get the latest prompt - try extracted prompts first, then sync extraction
      const latestPromptEvent = userPromptEvents[userPromptEvents.length - 1];
      const latestPromptContent = extractedPrompts[latestPromptEvent.id] || extractPromptFromEvent(latestPromptEvent);
      
      console.log('DetailsPane Debug - Latest prompt content:', latestPromptContent);
      
      // Only show latest if it's different from initial
      if (latestPromptContent && latestPromptContent !== session?.initial_prompt) {
        prompts.push({
          label: 'Latest Prompt',
          content: latestPromptContent
        });
      }
      
      // If there are multiple prompts, show all unique ones
      if (userPromptEvents.length > 1) {
        for (let i = userPromptEvents.length - 2; i >= 0 && prompts.length < 3; i--) {
          const event = userPromptEvents[i];
          const content = extractedPrompts[event.id] || extractPromptFromEvent(event);
          
          if (content && !prompts.some(p => p.content === content)) {
            prompts.push({
              label: `Prompt ${userPromptEvents.length - i}`,
              content: content
            });
          }
        }
      }
    }
    
    // Show selected prompt if it's different from all shown prompts
    if (selectedPrompt && !prompts.some(p => p.content === selectedPrompt)) {
      prompts.push({
        label: 'Selected Prompt',
        content: selectedPrompt
      });
    }
    
    console.log('DetailsPane Debug - Final prompts to show:', prompts);
    return prompts;
  }, [session?.initial_prompt, events, selectedPrompt, extractedPrompts, extractPromptFromEvent]);

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
          
          // Find the most recent todo list (the one with the latest timestamp)
          if (data && data.length > 0) {
            // Sort by timestamp descending and take the first (most recent) todo list
            const sortedTodos = data.sort((a: any, b: any) => 
              new Date(b.timestamp || b.created_at || 0).getTime() - 
              new Date(a.timestamp || a.created_at || 0).getTime()
            );
            
            // Get the most recent todo list
            const latestTodoList = sortedTodos[0];
            
            // Extract individual todos from the latest list
            const todos = latestTodoList.todos || [];
            setTodos(Array.isArray(todos) ? todos : []);
          } else {
            setTodos([]);
          }
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

  // Timeline event selection handler
  const handleTimelineEventSelect = useCallback((event: TimelineEvent) => {
    setSelectedTimelineEvent(event);
    
    // If it's a prompt event, extract and display the prompt message
    if (event.type === 'prompt' && event.data && 'message' in event.data) {
      setSelectedPrompt(event.data.message || null);
    } else if (event.type === 'prompt' && event.data && 'tool_input' in event.data && event.data.tool_input) {
      // For user_prompt events, the prompt might be in tool_input
      setSelectedPrompt(event.data.tool_input.text || event.data.tool_input.prompt || null);
    } else {
      setSelectedPrompt(null);
    }
  }, []);

  // QuickDraw callbacks
  const handleTodoSelect = useCallback((index: number) => {
    if (index < todos.length) {
      const todoElement = document.querySelector(`[data-testid="todo-item-${index}"]`);
      if (todoElement) {
        todoElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Add a temporary highlight effect
        todoElement.classList.add('highlight');
        setTimeout(() => todoElement.classList.remove('highlight'), 2000);
      }
    }
  }, [todos]);

  const handleFocusPrompt = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  const handlePause = useCallback(async () => {
    try {
      await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '\x1b' }) // Escape key
      });
    } catch (err: any) {
      setError(err.message);
    }
  }, [sessionId]);

  const handleNotification = useCallback(async (number: string) => {
    try {
      await fetch(`/api/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: number })
      });
    } catch (err: any) {
      setError(err.message);
    }
  }, [sessionId]);

  const handleScrollToBottom = useCallback(() => {
    const el = terminalRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const handleScrollToTop = useCallback(() => {
    const el = terminalRef.current;
    if (el) {
      el.scrollTop = 0;
    }
  }, []);

  // Register QuickDraw actions
  useQuickDrawDetailsActions({
    todos,
    onTodoSelect: handleTodoSelect,
    onSave: handleSaveChanges,
    onFocusPrompt: handleFocusPrompt,
    onPause: handlePause,
    onNotification: handleNotification,
    onScrollToBottom: handleScrollToBottom,
    onScrollToTop: handleScrollToTop,
    sessionId
  });

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
          
          {/* Display up to 3 prompts */}
          {promptsToShow.map((prompt, index) => (
            <div key={index} className="prompt-section">
              <p><strong>{prompt.label}:</strong> {prompt.content}</p>
            </div>
          ))}
        </div>
      ) : (
        <p>Loading session...</p>
      )}

      {session && (
        <div className="timeline-section">
          <Timeline 
            sessionId={sessionId}
            sessionName={session?.name}
            onEventSelect={handleTimelineEventSelect}
            selectedEventId={selectedTimelineEvent?.id}
          />
        </div>
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
                ref={textareaRef}
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


          <div className="todos-section">
            <div className="todo-header">
              <h3>Todo Lists</h3>
            </div>
            {todos.length ? (
              <div className="todo-widget">
                <div className="todo-lists-container">
                  {todos.map((todo, idx) => (
                    <div key={idx} className="todo-item-container" data-testid={`todo-item-${idx}`}>
                      <div className="todo-item">
                        <span className={`status-indicator status-${todo.status || 'pending'}`}></span>
                        <span className="todo-content">
                          {todo.content || todo.message || 'Todo item'}
                        </span>
                        {todo.status && (
                          <span className={`priority-badge priority-${todo.priority || 'medium'}`}>
                            {todo.priority || 'med'}
                          </span>
                        )}
                      </div>
                      {todo.activeForm && todo.status === 'in_progress' && (
                        <div className="todo-active-form">
                          {todo.activeForm}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="no-todos">
                <p>No todo lists found</p>
              </div>
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
          <ControlBoard 
            sessionId={sessionId} 
            session={session}
            onSaveChanges={handleSaveChanges}
            onMergeWorktree={handleMergeWorktree}
            onTerminate={handleTerminate}
          />
          {session && (
            <FileList sessionId={sessionId} project={session.project} />
          )}
        </div>
      </div>
    </div>
  );
};

export default DetailsPane;
