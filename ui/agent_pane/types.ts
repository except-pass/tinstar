export interface Session {
  id: string;
  name: string;
  project: string;
  status: "active" | "stopped" | "error";
  created_at: string;
  last_activity: string;
  agent_type: string;
  initial_prompt?: string;
}

export interface SessionResponse {
  success: boolean;
  message?: string;
  session?: Session;
  sessions?: Session[];
}

export interface Event {
  session_id: string;
  timestamp: string;
  hook_event_name: string;
  tool_name?: string;
  tinstar_term_name?: string;
}

export interface Project {
  name: string;
  path: string;
  created_at: string;
  unignore_paths: string[];
}

export interface ProjectResponse {
  success: boolean;
  message?: string;
  project?: Project;
  projects?: Project[];
}

export interface CreateSessionRequest {
  project: string;
  initial_prompt?: string;
  agent_type?: string;
}

export interface AgentPaneState {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  selectedAgentId: string | null;
}

export interface SessionStatus {
  id: string;
  needsAttention: boolean;
  statusText: string;
  statusColor: 'green' | 'yellow' | 'gray';
}

export interface ProjectGroup {
  projectName: string;
  sessions: Session[];
  colorIndex: number;
  backgroundColor: string;
}

export interface EventStatus {
  hasNotifyEvent: boolean;
  hasStopEvent: boolean;
  lastEventTime: Date;
}

export const PROJECT_COLORS = [
  '#C6A77B', // Desert Sand
  '#8B5A2B', // Saddle Brown  
  '#A04020', // Rust Red
  '#4B4B4B', // Gunmetal Gray
  '#D4AF37', // Prairie Gold
  '#556B2F', // Cactus Green
  '#9AB6C3', // Dusty Sky
  '#2E1B0F'  // Charred Wood
] as const;