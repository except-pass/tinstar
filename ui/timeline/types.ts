export interface Event {
  session_id: string
  timestamp: string
  hook_event_name: string
  tool_name?: string
  tool_input?: any
  tool_response?: any
  message?: string
  tinstar_term_name?: string
}

export interface Commit {
  hash: string
  message: string
  author: string
  timestamp: string
  files_changed: number
}

export interface TimelineEvent {
  id: string
  type: 'prompt' | 'notification' | 'stop' | 'tool' | 'todo' | 'commit'
  timestamp: Date
  icon: '💬' | '🟠' | '⚪' | '🛑' | '🔧' | '✅' | '💾'
  count?: number
  selected: boolean
  active?: boolean
  data: Event | Commit
}

export interface TimelineState {
  events: TimelineEvent[]
  selectedEventId: string | null
  autoScroll: boolean
  timeRange: { start: Date; end: Date }
  loading: boolean
  error: string | null
}

export interface TimelineProps {
  sessionId: string
  sessionName?: string
  onEventSelect: (event: TimelineEvent) => void
  selectedEventId?: string
}