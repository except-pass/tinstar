# Agent Pane UI Component Specification

## Overview

The agent pane is a thin vertical pane that provides a compact overview of all active agents and their status. It shows a small representation of each open agent's activity and alerts the user when attention is needed.

## Data Sources

The agent pane consumes data from multiple APIs:

### Sessions API
**GET `/api/sessions`** - Returns active sessions:
```typescript
interface SessionResponse {
  sessions: Session[]
}

interface Session {
  id: string
  name: string
  project: string
  status: "active" | "stopped" | "error"
  created_at: string
  last_activity: string
  agent_type: string
  initial_prompt?: string
}
```

### Events API  
**GET `/api/events`** - Returns events for status determination:
```typescript
interface Event {
  session_id: string
  timestamp: string
  hook_event_name: string  // "notification", "stop", etc.
  tool_name?: string
  tinstar_term_name?: string
}
```

**WebSocket `/api/events/ws`** - Real-time event streaming for instant status updates.

### Projects API
**GET `/api/projects`** - Returns projects for color assignment:
```typescript
interface ProjectResponse {
  projects: Project[]
}

interface Project {
  name: string
  path: string
  created_at: string
  unignore_paths: string[]
}
```

## Visual Design

```
┌─ Agent Pane ───────────────┐
│ ▓▓ my-project ▓▓▓▓▓▓▓▓▓▓▓▓ │ ← Project group (Desert Sand background)
│ ⚡ deadwood-saloon         │ ← Active agent
│    🟢 Active               │
│ ⚠️ tombstone-ranch         │ ← Needs attention  
│    🟡 Needs attention      │
│                            │
│ ▓▓ other-project ▓▓▓▓▓▓▓▓▓ │ ← Project group (Saddle Brown background)
│ ⚫ silver-city             │ ← Idle state
│    ⚫ Idle                 │
│                            │
│ + New Agent                │ ← Create button
└────────────────────────────┘
```

## Component Structure

Agent pane layout:
- Project Group 1 (with project color background)
  - SmallAgent Widget for session 1
  - SmallAgent Widget for session 2
  - ...
- Project Group 2 (with project color background)  
  - SmallAgent Widget for session N
  - ...
- New Agent button

### Project Grouping

- **Sessions grouped by project**: All agents for the same project are grouped together
- **Project color backgrounds**: Each project group has a background color from ui/color_palette.md
- **Color assignment**: Projects cycle through the 8 colors (Desert Sand, Saddle Brown, Rust Red, Gunmetal Gray, Prairie Gold, Cactus Green, Dusty Sky, Charred Wood)
- **Consistent coloring**: Must match the project colors used in ui/project_pane

### SmallAgent Widget

Each widget displays:
- **Agent icon** - Status indicator (⚡ active, ⚠️ attention, ⚫ idle)
- **Session name** - Old west themed name from session.name
- **Project name** - From session.project
- **Status indicator** - Color-coded status with text based on events:
  - 🟢 Active (recent activity, not stopped or waiting)
  - 🟡 Needs attention (notification event - agent waiting for user input/approval)
  - ⚫ Idle (Stop event or no activity for 5+ minutes)

### New Agent Button

- Displays below all agent widgets
- Opens session creation dialog with project selection
- Uses same project picker pattern as project pane

## State Management

```typescript
interface AgentPaneState {
  sessions: Session[]
  loading: boolean
  error: string | null
  selectedAgentId: string | null
}

interface SessionStatus {
  id: string
  needsAttention: boolean
  statusText: string
  statusColor: 'green' | 'yellow' | 'red' | 'gray'
}

interface ProjectGroup {
  projectName: string
  sessions: Session[]
  colorIndex: number
  backgroundColor: string
}
```

## Interaction

- **Click agent widget**: Focus on that agent's session view


## API Integration

### Complete Data Flow
The agent pane requires data from three APIs for full functionality:

**1. Session List**
```typescript
const fetchSessions = async (): Promise<Session[]> => {
  const response = await fetch('/api/sessions')
  const data = await response.json()
  return data.sessions
}
```

**2. Project List for Color Assignment**
```typescript
const fetchProjects = async (): Promise<Project[]> => {
  const response = await fetch('/api/projects')
  const data = await response.json()
  return data.projects
}
```

**3. Events for Status Detection**
```typescript
const fetchSessionEvents = async (sessionId: string): Promise<Event[]> => {
  const response = await fetch(`/api/events?session_id=${sessionId}&limit=50`)
  if (!response.ok) {
    throw new Error(`Failed to fetch events: ${response.statusText}`)
  }
  return response.json()
}
```

### Session Status Detection via Events
```typescript
interface EventStatus {
  hasNotifyEvent: boolean
  hasStopEvent: boolean
  lastEventTime: Date
}

const getSessionStatus = (session: Session, eventStatus: EventStatus): SessionStatus => {
  // Check for "needs attention" via notification events
  if (eventStatus.hasNotifyEvent) {
    return { 
      needsAttention: true, 
      statusText: 'Needs attention', 
      statusColor: 'yellow' 
    }
  }
  
  // Check for "idle" via Stop events or no recent activity
  if (eventStatus.hasStopEvent || 
      eventStatus.lastEventTime < new Date(Date.now() - 5 * 60 * 1000)) {
    return { 
      needsAttention: false, 
      statusText: 'Idle', 
      statusColor: 'gray' 
    }
  }
  
  return { 
    needsAttention: false, 
    statusText: 'Active', 
    statusColor: 'green' 
  }
}

// Fetch latest events for status determination
const getEventStatus = async (sessionId: string): Promise<EventStatus> => {
  const response = await fetch(`/api/events?session_id=${sessionId}&limit=50`)
  const events = await response.json()
  
  const hasNotifyEvent = events.some(e => e.hook_event_name === 'notification')
  const hasStopEvent = events.some(e => e.hook_event_name === 'Stop')
  const lastEventTime = events.length > 0 ? new Date(events[0].timestamp) : new Date(0)
  
  return { hasNotifyEvent, hasStopEvent, lastEventTime }
}
```

### Project Grouping with Consistent Colors
```typescript
const PROJECT_COLORS = [
  '#C6A77B', // Desert Sand
  '#8B5A2B', // Saddle Brown  
  '#A04020', // Rust Red
  '#4B4B4B', // Gunmetal Gray
  '#D4AF37', // Prairie Gold
  '#556B2F', // Cactus Green
  '#9AB6C3', // Dusty Sky
  '#2E1B0F'  // Charred Wood
]

const groupSessionsByProject = (
  sessions: Session[], 
  projects: Project[]
): ProjectGroup[] => {
  const projectMap = new Map<string, Session[]>()
  
  // Group sessions by project
  sessions.forEach(session => {
    if (!projectMap.has(session.project)) {
      projectMap.set(session.project, [])
    }
    projectMap.get(session.project)!.push(session)
  })
  
  // Create project groups with consistent color assignment
  // Colors assigned based on project creation order, same as project pane
  const sortedProjects = projects.sort((a, b) => a.created_at.localeCompare(b.created_at))
  const projectColorMap = new Map<string, number>()
  
  sortedProjects.forEach((project, index) => {
    projectColorMap.set(project.name, index % PROJECT_COLORS.length)
  })
  
  return Array.from(projectMap.entries()).map(([projectName, sessions]) => ({
    projectName,
    sessions,
    colorIndex: projectColorMap.get(projectName) || 0,
    backgroundColor: PROJECT_COLORS[projectColorMap.get(projectName) || 0]
  }))
}
```

### Create New Session
```typescript
interface CreateSessionRequest {
  project: string
  initial_prompt?: string
  agent_type?: string
}

const createSession = async (request: CreateSessionRequest): Promise<SessionResponse> => {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  })
  
  if (!response.ok) {
    const errorData = await response.json()
    throw new Error(errorData.detail || 'Failed to create session')
  }
  
  return response.json()
}
```

## Error Handling

- **API failures**: Show error banner with retry option
- **Network issues**: Graceful degradation with cached data
- **Session creation errors**: Display validation messages inline

## Auto-refresh

- Poll `/api/sessions` every 10 seconds to update session list
- Poll `/api/events` every 5 seconds to update agent status based on latest events
- Use WebSocket connection to `/api/events/ws` if available for real-time event updates
- Pause polling when user is actively interacting with pane

## Accessibility

- **Screen readers**: Proper ARIA labels for session status
- **Keyboard navigation**: Tab through agent widgets and actions
- **High contrast**: Clear visual indicators for different states

## Implementation Notes

- Use React with TypeScript
- Follow existing patterns from ui/project_pane and ui/filelist
- **Multi-API Integration**: Requires data from three APIs:
  - `/api/sessions` - for session list and basic info
  - `/api/events` - for event-driven status detection
  - `/api/projects` - for consistent project color assignment
- Handle loading states for all async operations across multiple API calls
- **Project color consistency**: Use same color assignment logic as ui/project_pane by sorting projects by creation date
- Group sessions by project name and apply project background colors to group containers
- Individual SmallAgent widgets remain neutral colored within the colored project groups
- **Event-driven status**: Agent status determined by checking latest events via `/api/events` rather than just session.last_activity
- **Real-time updates**: Integrate WebSocket connection to `/api/events/ws` for instant status changes when agents generate notification or stop events

## Data Requirements Summary

**✅ All Required Data Available**
1. **Session data** - `/api/sessions` provides all session details
2. **Project grouping** - Sessions have project field, `/api/projects` provides project list  
3. **Project colors** - Derived from project creation order for consistency with project pane
4. **Event-based status** - `/api/events` supports filtering by session_id and event type
5. **Real-time updates** - WebSocket `/api/events/ws` available for live event streaming
6. **Session creation** - `POST /api/sessions` for "New Agent" button functionality

**No data gaps identified** - The agent pane can be fully implemented with existing API endpoints.

## Testing Strategy

### High-Value Test Scenarios

- Display multiple agents with different statuses
- **Project grouping**: Multiple projects each with multiple agents, properly grouped and colored
- **Color consistency**: Same project gets same background color across UI components
- Status changes over time (active → needs attention → error)
- Agent widget interactions (click, hover, right-click)
- New agent creation flow
- Error handling for failed API calls
- Auto-refresh behavior and polling