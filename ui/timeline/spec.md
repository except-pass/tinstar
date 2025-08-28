# Timeline Widget Specification

## Overview

The Timeline Widget provides a chronological visualization of session events, including user interactions, system activities, and git commits. It serves as the primary navigation interface for browsing session history and understanding the flow of agent activity.

## Data Sources

The timeline widget consumes data from multiple APIs:

### Events API
**GET `/api/events`** - Returns session events:
```typescript
interface Event {
  session_id: string
  timestamp: string
  hook_event_name: string  // "user_prompt", "notification", "stop", "pre_tool_use", "post_tool_use", "todowrite"
  tool_name?: string
  tool_input?: any
  tool_response?: any
  message?: string
  tinstar_term_name?: string
}
```

### Commits API
**GET `/api/worktrees/commits`** - Returns git commits for the session:
```typescript
interface Commit {
  hash: string
  message: string
  author: string
  timestamp: string
  files_changed: number
}
```

**WebSocket `/api/events/ws`** - Real-time event streaming for live timeline updates.

## Visual Design

```
┌─ Timeline Widget ──────────────────────────────────────────────┐
│ Time: 14:32:15                                    [Auto-scroll] │
├────────────────────────────────────────────────────────────────┤
│ [User]    --P---N---------S                                    │
│ [System]  ----🔧x5-----🔧x12----✓---🔧x3                      │  
│ [Commits] ------💾----------💾-------                         │
│           14:30  14:35     14:40                               │
└────────────────────────────────────────────────────────────────┘
```

## Event Types and Icons

### User Events
- **Prompt**: 💬 User input message
- **Notification**: 🟠 System notification requiring user attention (filled orange circle when active, ⚪ outline circle when inactive)
- **Stop**: 🛑 Session termination or pause
- **Commit**: 💾 Git commit to worktree

### System Events  
- **Tool Use**: 🔧 Agent tool execution
  - Single tool: `🔧`
  - Multiple tools: `🔧x5` (collapsed with count)
- **Todo Update**: ✅ Todo list modifications

## Component Structure

### Timeline Display
- **Two horizontal tracks**: User (prompts, notifications, stops, commits), System (tool use, todos)
- **Time axis**: Horizontal timeline with timestamp markers
- **Event positioning**: Events positioned based on timestamp
- **Icon grouping**: Consecutive tool uses collapsed with count
- **Auto-scroll**: Optional auto-scroll to follow latest activity

### Event Icons
```typescript
interface TimelineEvent {
  id: string
  type: 'prompt' | 'notification' | 'stop' | 'tool' | 'todo' | 'commit'
  timestamp: Date
  icon: '💬' | '🟠' | '⚪' | '🛑' | '🔧' | '✅' | '💾'
  count?: number  // For collapsed tool events
  selected: boolean
  active?: boolean  // For notifications
  data: Event | Commit
}
```

## State Management

```typescript
interface TimelineState {
  events: TimelineEvent[]
  selectedEventId: string | null
  autoScroll: boolean
  timeRange: { start: Date; end: Date }
  loading: boolean
  error: string | null
}

interface TimelineProps {
  sessionId: string
  onEventSelect: (event: TimelineEvent) => void
  selectedEventId?: string
}
```

## Interaction

### Event Selection
- **Click prompt icon**: Select prompt event and update details pane
- **Selected state**: Highlighted with border and background color
- **Details pane integration**: Always shows initial prompt, plus selected prompt if different

### Notification States
- **Active notification**: Filled orange circle (🟠) - last unhandled notification
- **Inactive notification**: Outline circle (⚪) - handled or superseded notifications

### Commit Tooltips
- **Mouse hover**: Show commit hash, message, and files changed count
- **Click**: Navigate to commit diff view (future enhancement)

### Auto-scroll
- **Toggle button**: Enable/disable auto-scroll to latest events
- **Behavior**: Automatically scrolls timeline to show new events as they arrive
- **Pause on interaction**: Temporarily pause auto-scroll when user interacts with timeline

## API Integration

### Event Processing
```typescript
const processEvents = (rawEvents: Event[]): TimelineEvent[] => {
  const grouped = groupConsecutiveToolUses(rawEvents)
  return grouped.map(event => ({
    id: generateEventId(event),
    type: mapEventType(event.hook_event_name),
    timestamp: new Date(event.timestamp),
    icon: getEventIcon(event),
    count: event.toolCount || undefined,
    selected: false,
    active: event.hook_event_name === 'notification' && isActiveNotification(event),
    data: event
  }))
}

const groupConsecutiveToolUses = (events: Event[]): Event[] => {
  // Collapse consecutive PreToolUse/PostToolUse events into single entries with count
  return events.reduce((acc, event) => {
    const lastEvent = acc[acc.length - 1]
    if (isToolEvent(event) && isToolEvent(lastEvent) && 
        Math.abs(new Date(event.timestamp).getTime() - new Date(lastEvent.timestamp).getTime()) < 30000) {
      lastEvent.toolCount = (lastEvent.toolCount || 1) + 1
      return acc
    }
    return [...acc, event]
  }, [])
}
```

### Real-time Updates
```typescript
const useTimelineEvents = (sessionId: string) => {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  
  // Initial load
  useEffect(() => {
    fetchEvents(sessionId).then(processEvents).then(setEvents)
  }, [sessionId])
  
  // WebSocket for real-time updates
  useEffect(() => {
    const ws = new WebSocket('/api/events/ws')
    ws.onmessage = (event) => {
      const newEvent = JSON.parse(event.data)
      if (newEvent.session_id === sessionId) {
        setEvents(prev => [...prev, processEvent(newEvent)])
      }
    }
    return () => ws.close()
  }, [sessionId])
}
```

### Commit Integration
```typescript
const fetchCommits = async (sessionId: string): Promise<Commit[]> => {
  const response = await fetch(`/api/worktrees/commits?session_id=${sessionId}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch commits: ${response.statusText}`)
  }
  return response.json()
}
```

## Error Handling

- **API failures**: Show error banner with retry option
- **WebSocket disconnection**: Graceful fallback to polling
- **Missing data**: Handle partial event data gracefully
- **Network issues**: Cache events locally and sync when connection restored

## Performance Considerations

- **Event pagination**: Load events in time-based chunks for long sessions
- **Virtual scrolling**: For sessions with thousands of events
- **Icon caching**: Cache rendered icons to avoid re-computation
- **Debounced updates**: Batch rapid event updates to prevent UI thrashing

## Accessibility

- **Screen readers**: ARIA labels for all icons and interactive elements
- **Keyboard navigation**: Tab through timeline events, Enter to select
- **High contrast**: Clear visual indicators for different event types and states
- **Focus management**: Maintain focus when events are selected

## Implementation Notes

- Use React with TypeScript
- Follow existing patterns from ui/agent_pane and ui/details_pane
- **Multi-API Integration**: Requires data from both `/api/events` and `/api/worktrees/commits`
- Handle loading states for all async operations
- Real-time updates via WebSocket integration to `/api/events/ws`
- **Two-lane layout**: User lane contains prompts, notifications, stops, and commits; System lane contains tool use and todos
- **Event grouping**: Implement intelligent grouping for consecutive tool uses to reduce visual clutter
- **Time-based positioning**: Use CSS transforms for precise event positioning on timeline
- **Responsive design**: Adapt timeline layout for different screen sizes

## Testing Strategy

### High-Value Test Scenarios

- **Event display**: Multiple event types displayed with correct icons and timing
- **Two-lane layout**: User events (💬🟠🛑💾) in top lane, system events (🔧✅) in bottom lane
- **Tool grouping**: Consecutive tool uses properly collapsed with accurate counts
- **Selection behavior**: Event selection updates details pane correctly
- **Notification states**: Active (🟠) vs inactive (⚪) notifications display correctly
- **Commit integration**: Git commits appear in user lane with proper tooltips
- **Real-time updates**: New events appear on timeline via WebSocket
- **Auto-scroll**: Auto-scroll behavior works correctly and pauses appropriately
- **Error handling**: Graceful degradation when APIs fail
- **Performance**: Timeline remains responsive with large numbers of events
