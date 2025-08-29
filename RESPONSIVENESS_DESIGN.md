# Tinstar UI Responsiveness Design Document

## Executive Summary

The current Tinstar UI feels sluggish and clunky, particularly in four critical areas:
1. **Agent status updates** (idle, needs attention, etc.)
2. **Changed files display**
3. **Terminal output rendering**
4. **Todo lists and timeline events**

This document outlines a comprehensive redesign using **event-driven architecture** focused on **speed and responsiveness over efficiency or scalability**, optimized for local single-user deployment.

## Current Performance Analysis

### Agent Status System
- **Current**: Status updates every 10 seconds via polling
- **Problem**: 10-second delay feels unresponsive, status changes appear laggy
- **Impact**: Users don't get immediate feedback on agent state changes

### Changed Files Display  
- **Current**: Full file tree refresh on expand/collapse operations
- **Problem**: Network round-trip for every UI interaction
- **Impact**: Tree expansion feels sluggish, no immediate visual feedback

### Terminal Output
- **Current**: 3-second polling for terminal output, full DOM regeneration
- **Problem**: Delayed updates, janky scrolling, inefficient rendering
- **Impact**: Terminal feels disconnected from real-time activity

### Todo Lists and Timeline
- **Current**: Separate API calls for todos and timeline events with periodic polling
- **Problem**: Multiple polling intervals, delayed updates, inconsistent refresh timing
- **Impact**: Todo changes and timeline events appear with significant delays

### WebSocket Usage
- **Current**: WebSocket connections exist but underutilized
- **Problem**: Still relying heavily on polling instead of real-time updates
- **Impact**: Missed opportunities for instant responsiveness

## Design Principles

### Speed First
- Prioritize immediate visual feedback over data accuracy
- Use optimistic updates where possible
- Implement instant UI state changes before server confirmation

### Event-Driven Architecture
- Single WebSocket connection for all real-time updates
- Components subscribe to specific event types
- Eliminate all polling in favor of push notifications

### Local Deployment Optimization
- Aggressive caching since we control the environment
- Higher memory usage acceptable for better performance
- Real-time event streaming since bandwidth isn't constrained

## Proposed Event-Driven Architecture

### 1. Central Event Bus System

#### Event Bus Implementation
```typescript
// EventBus.ts - Single source of truth for all real-time updates
class TinstarEventBus {
  private ws: WebSocket | null = null;
  private subscribers = new Map<string, Set<Function>>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  
  connect() {
    this.ws = new WebSocket('/api/ws/events');
    
    this.ws.onopen = () => {
      console.log('WebSocket connected');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };
    
    this.ws.onmessage = (event) => {
      const { type, data } = JSON.parse(event.data);
      this.emit(type, data);
    };
    
    this.ws.onclose = () => {
      // Auto-reconnect with exponential backoff
      this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    };
  }
  
  subscribe(eventType: string, callback: Function) {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType)!.add(callback);
    
    return () => {
      this.subscribers.get(eventType)?.delete(callback);
    };
  }
  
  private emit(type: string, data: any) {
    const callbacks = this.subscribers.get(type);
    callbacks?.forEach(callback => callback(data));
  }
}

export const eventBus = new TinstarEventBus();
```

#### Event Types Definition
```typescript
// Event types the server publishes via WebSocket
type TinstarEvents = {
  // Agent events
  'agent_status_changed': { sessionId: string; status: string; timestamp: number; }
  'agent_created': { session: Session; }
  'agent_terminated': { sessionId: string; }
  
  // Terminal events
  'terminal_output': { sessionId: string; lines: string[]; }
  'terminal_cleared': { sessionId: string; }
  
  // File system events
  'file_changed': { sessionId: string; path: string; stats: GitStats; }
  'file_created': { sessionId: string; path: string; }
  'file_deleted': { sessionId: string; path: string; }
  'git_status_changed': { sessionId: string; files: FileStatus[]; }
  
  // Todo and timeline events
  'todo_updated': { sessionId: string; todos: TodoItem[]; }
  'timeline_event_added': { sessionId: string; event: TimelineEvent; }
}
```

#### React Hook for Event Subscription
```typescript
// useEventSubscription.ts
const useEventSubscription = <T>(
  eventType: keyof TinstarEvents, 
  callback: (data: T) => void,
  deps: any[] = []
) => {
  useEffect(() => {
    return eventBus.subscribe(eventType, callback);
  }, deps);
};

// Specific hooks for common use cases
const useAgentStatus = (sessionId: string) => {
  const [status, setStatus] = useState<string>('loading');
  
  useEventSubscription('agent_status_changed', (data: any) => {
    if (data.sessionId === sessionId) {
      setStatus(data.status);
    }
  }, [sessionId]);
  
  return status;
};

const useRealtimeTerminal = (sessionId: string) => {
  const [lines, setLines] = useState<string[]>([]);
  
  useEventSubscription('terminal_output', (data: any) => {
    if (data.sessionId === sessionId) {
      setLines(prev => [...prev.slice(-1000), ...data.lines]);
    }
  }, [sessionId]);
  
  useEventSubscription('terminal_cleared', (data: any) => {
    if (data.sessionId === sessionId) {
      setLines([]);
    }
  }, [sessionId]);
  
  return lines;
};
```

### 2. Component Architecture Transformation

#### AgentPane - Event-Driven
```typescript
// AgentPane.tsx - No more polling!
export const AgentPane: React.FC<AgentPaneProps> = ({ onAgentClick }) => {
  const [sessions, setSessions] = useState<Session[]>([]);
  
  // Subscribe to agent events
  useEventSubscription('agent_status_changed', (data) => {
    setSessions(prev => prev.map(session => 
      session.id === data.sessionId 
        ? { ...session, status: data.status, last_activity: data.timestamp }
        : session
    ));
  });
  
  useEventSubscription('agent_created', (data) => {
    setSessions(prev => [...prev, data.session]);
  });
  
  useEventSubscription('agent_terminated', (data) => {
    setSessions(prev => prev.filter(s => s.id !== data.sessionId));
  });
  
  // Initial load only - no more polling intervals
  useEffect(() => {
    fetchSessions().then(setSessions);
    eventBus.connect(); // Connect to WebSocket
  }, []);
  
  return (
    <div className="agent-pane">
      {sessions.map(session => (
        <SmallAgentWidget 
          key={session.id}
          session={session}
          onAgentClick={onAgentClick}
          // Status updates automatically via events
        />
      ))}
    </div>
  );
};
```

#### DetailsPane - Event-Driven
```typescript
// DetailsPane.tsx - Real-time everything
export const DetailsPane: React.FC<DetailsPaneProps> = ({ sessionId }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  
  // Real-time terminal output
  const terminalLines = useRealtimeTerminal(sessionId);
  
  // Real-time todo updates
  useEventSubscription('todo_updated', (data) => {
    if (data.sessionId === sessionId) {
      setTodos(data.todos);
    }
  }, [sessionId]);
  
  // Real-time timeline events
  useEventSubscription('timeline_event_added', (data) => {
    if (data.sessionId === sessionId) {
      setTimelineEvents(prev => [...prev, data.event]);
    }
  }, [sessionId]);
  
  // Initial load only - all updates come via events
  useEffect(() => {
    if (sessionId) {
      fetchSession(sessionId).then(setSession);
      fetchTodos(sessionId).then(setTodos);
      fetchTimelineEvents(sessionId).then(setTimelineEvents);
    }
  }, [sessionId]);
  
  return (
    <div className="details-pane">
      <div className="terminal-section">
        <VirtualizedTerminal lines={terminalLines} />
      </div>
      
      <div className="todos-section">
        <TodoList todos={todos} />
      </div>
      
      <div className="timeline-section">
        <Timeline events={timelineEvents} />
      </div>
    </div>
  );
};
```

#### FileList - Event-Driven
```typescript
// FileList.tsx - Instant interactions with real-time updates
export const FileList: React.FC<FileListProps> = ({ sessionId }) => {
  const [fileTree, setFileTree] = useState<FileTree>();
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  
  // Real-time file changes
  useEventSubscription('file_changed', (data) => {
    if (data.sessionId === sessionId) {
      setFileTree(prev => updateFileInTree(prev, data.path, data.stats));
    }
  }, [sessionId]);
  
  useEventSubscription('git_status_changed', (data) => {
    if (data.sessionId === sessionId) {
      setFileTree(prev => updateGitStatus(prev, data.files));
    }
  }, [sessionId]);
  
  // Instant expand/collapse - no API calls
  const toggleDirectory = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next; // Instant UI update!
    });
  };
  
  // Initial load of complete file structure
  useEffect(() => {
    if (sessionId) {
      fetchCompleteFileTree(sessionId).then(setFileTree);
    }
  }, [sessionId]);
  
  return (
    <div className="file-list">
      <FileTree 
        tree={fileTree}
        expandedDirs={expandedDirs}
        onToggleDirectory={toggleDirectory}
      />
    </div>
  );
};
```

### 3. Server-Side Event Implementation

#### Terminal Output Streaming
```bash
#!/bin/bash
# Terminal streaming setup
SESSION_ID=$1
LOG_FILE="/tmp/session_${SESSION_ID}.log"

# Set up tmux to pipe all output to log file
tmux pipe-pane -t $SESSION_ID "tee -a $LOG_FILE"

# Stream new lines to WebSocket clients
tail -f $LOG_FILE | while IFS= read -r line; do
  # Send to WebSocket event publisher
  curl -X POST http://localhost:8080/api/events/publish \
    -H "Content-Type: application/json" \
    -d "{
      \"type\": \"terminal_output\",
      \"data\": {
        \"sessionId\": \"$SESSION_ID\",
        \"lines\": [\"$line\"]
      }
    }"
done
```

#### File Change Monitoring
```typescript
// Server-side file watcher
const watchWorktreeFiles = (sessionId: string) => {
  const worktreePath = getWorktreePath(sessionId);
  
  // Use chokidar for cross-platform file watching
  const watcher = chokidar.watch(worktreePath, {
    ignored: /node_modules|\.git\/objects|\.DS_Store/,
    persistent: true,
    ignoreInitial: true
  });
  
  const gitStatusDebouncer = new Map<string, NodeJS.Timeout>();
  
  watcher.on('change', async (filePath) => {
    const relativePath = path.relative(worktreePath, filePath);
    
    // Instant optimistic update
    eventPublisher.publish('file_changed', {
      sessionId,
      path: relativePath,
      status: 'modified'
    });
    
    // Debounced git stats update
    if (gitStatusDebouncer.has(filePath)) {
      clearTimeout(gitStatusDebouncer.get(filePath)!);
    }
    
    gitStatusDebouncer.set(filePath, setTimeout(async () => {
      const stats = await getGitDiffStats(relativePath, worktreePath);
      eventPublisher.publish('file_changed', {
        sessionId,
        path: relativePath,
        stats
      });
    }, 300));
  });
  
  return () => watcher.close();
};
```

#### Event Publisher Service
```typescript
// EventPublisher.ts - Central event publishing
class TinstarEventPublisher {
  private wsClients = new Set<WebSocket>();
  
  addClient(ws: WebSocket) {
    this.wsClients.add(ws);
    ws.on('close', () => this.wsClients.delete(ws));
  }
  
  publish(eventType: keyof TinstarEvents, data: any) {
    const message = JSON.stringify({ type: eventType, data });
    
    this.wsClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}

export const eventPublisher = new TinstarEventPublisher();

// Usage examples:
// Agent status change: eventPublisher.publish('agent_status_changed', {...})
// File change: eventPublisher.publish('file_changed', {...})
// Todo update: eventPublisher.publish('todo_updated', {...})
// Timeline event: eventPublisher.publish('timeline_event_added', {...})
```

### 4. Virtualized Terminal Implementation

#### High-Performance Terminal Component
```typescript
// VirtualizedTerminal.tsx - Smooth scrolling for large outputs
interface VirtualizedTerminalProps {
  lines: string[];
  height?: number;
}

export const VirtualizedTerminal: React.FC<VirtualizedTerminalProps> = ({ 
  lines, 
  height = 400 
}) => {
  const [startIndex, setStartIndex] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const lineHeight = 20;
  const visibleCount = Math.ceil(height / lineHeight);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = lines.length * lineHeight;
    }
  }, [lines.length, autoScroll]);
  
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const scrollTop = event.currentTarget.scrollTop;
    const newStart = Math.floor(scrollTop / lineHeight);
    setStartIndex(newStart);
    
    // Disable auto-scroll if user scrolls up
    const isAtBottom = scrollTop >= (lines.length * lineHeight) - height;
    setAutoScroll(isAtBottom);
  };
  
  const visibleLines = lines.slice(startIndex, startIndex + visibleCount + 5);
  
  return (
    <div className="virtualized-terminal">
      <div className="terminal-controls">
        <button onClick={() => setAutoScroll(true)}>
          Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
        </button>
      </div>
      
      <div 
        ref={containerRef}
        className="terminal-content" 
        onScroll={handleScroll}
        style={{ height, overflowY: 'auto' }}
      >
        <div style={{ height: lines.length * lineHeight, position: 'relative' }}>
          <div style={{ 
            transform: `translateY(${startIndex * lineHeight}px)`,
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0
          }}>
            {visibleLines.map((line, idx) => (
              <TerminalLine 
                key={startIndex + idx} 
                line={line} 
                lineHeight={lineHeight}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoized terminal line component
const TerminalLine = React.memo<{line: string, lineHeight: number}>(({ 
  line, 
  lineHeight 
}) => {
  const ansiUp = useMemo(() => new AnsiUp(), []);
  
  return (
    <div 
      style={{ height: lineHeight, lineHeight: `${lineHeight}px` }}
      dangerouslySetInnerHTML={{ 
        __html: ansiUp.ansi_to_html(line) 
      }} 
    />
  );
});
```

## Implementation Phases

### Phase 1: Event Bus Foundation (Week 1)
1. **Set up central event bus system**
   - Implement TinstarEventBus class
   - Create WebSocket endpoint `/api/ws/events`
   - Add event type definitions

2. **Migrate agent status to events**
   - Remove 10-second polling from AgentPane
   - Implement real-time agent status events
   - Add visual feedback for status changes

3. **Basic server-side event publishing**
   - Set up EventPublisher service
   - Implement agent status change detection
   - Publish events when agent states change

### Phase 2: Terminal and File Events (Week 2)
1. **Real-time terminal streaming**
   - Set up tmux pipe-pane logging
   - Implement terminal output events
   - Remove 3-second polling from DetailsPane

2. **File system event streaming**
   - Implement chokidar file watching
   - Set up git status change detection
   - Add real-time file change events

3. **Client-side optimizations**
   - Implement instant file tree expand/collapse
   - Add optimistic UI updates for file operations
   - Cache file tree structure client-side

### Phase 3: Advanced Features (Week 3)
1. **Virtualized terminal rendering**
   - Implement VirtualizedTerminal component
   - Add smooth auto-scrolling
   - Optimize for large terminal outputs

2. **Todo and timeline event streaming**
   - Add real-time todo updates
   - Implement timeline event streaming
   - Remove remaining polling intervals

3. **Performance optimizations**
   - Add connection retry logic
   - Implement event batching for high-frequency updates
   - Add performance monitoring

## Expected Performance Improvements

### Agent Status
- **Before**: 10-second delay for status changes
- **After**: <100ms real-time updates via WebSocket

### File Tree
- **Before**: 200-500ms network delay per expand/collapse
- **After**: <16ms instant expand/collapse (client-side only)

### Terminal Output  
- **Before**: 3-second delay, full DOM regeneration, janky scrolling
- **After**: <50ms real-time streaming, virtualized rendering, smooth 60fps scrolling

### Todo Lists & Timeline
- **Before**: Separate polling intervals, inconsistent update timing
- **After**: <100ms real-time updates synchronized with all other events

### Overall Architecture
- **Before**: Multiple polling intervals, high network overhead
- **After**: Single WebSocket connection, event-driven updates, zero polling

## Technical Benefits

### Eliminated Polling
- No more setInterval calls throughout the codebase
- Reduced network overhead from constant HTTP requests
- Consistent real-time behavior across all components

### Unified State Management
- Single event bus for all real-time updates
- Components subscribe only to events they care about
- Easier debugging and monitoring of real-time updates

### Improved Performance
- Virtualized rendering for large datasets
- Client-side state management for instant interactions
- Optimistic updates for immediate user feedback

## Risk Mitigation

### WebSocket Connection Issues
- **Risk**: Connection drops or fails to establish
- **Mitigation**: Auto-reconnect with exponential backoff, polling fallback

### Memory Usage
- **Risk**: Event accumulation and client-side caching
- **Mitigation**: Implement LRU caches, limit terminal line buffers (1000 lines)

### Event Storm Protection
- **Risk**: High-frequency file changes overwhelming WebSocket
- **Mitigation**: Event debouncing, batching multiple changes

### Implementation Complexity
- **Risk**: Event-driven architecture adds complexity
- **Mitigation**: Gradual migration, extensive testing, clear event type definitions

## Success Metrics

### Quantitative
- Agent status update latency: <100ms (from 10 seconds)
- File tree interaction latency: <16ms (from 200-500ms)
- Terminal output delay: <50ms (from 3 seconds)
- Network requests per minute: <10 (from ~100+)

### Qualitative  
- User perception of "instant" responsiveness
- Elimination of perceived lag in all interactions
- Consistent real-time behavior across all components

## Conclusion

This event-driven architecture transformation eliminates all polling from the Tinstar UI and replaces it with a high-performance, real-time system. By using a single WebSocket connection for all updates and implementing client-side optimizations, we achieve the responsive, video game-like feel desired.

The phased implementation minimizes risk while delivering immediate performance benefits. Each phase removes polling intervals and adds real-time capabilities, creating a fundamentally more responsive development environment.

Key deliverables for developers:
1. **Complete event bus system** with TypeScript definitions
2. **Server-side event publishers** for all data changes  
3. **React hooks** for easy event subscription
4. **Virtualized components** for performance-critical displays
5. **Migration guide** from polling to event-driven patterns

This architecture positions Tinstar as a truly modern, responsive development tool that feels instant and engaging to use.