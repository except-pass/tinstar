// Single source of truth for all shared domain types.
//
// Previously these types lived in two places: src/types.ts and this file,
// with src/types.ts owning the primitives and src/domain/types.ts owning
// the entity shapes. 37 files imported from src/types.ts directly,
// duplicating the domain root. This file is now the canonical home;
// src/types.ts is a thin re-export shim for backwards compatibility.

/** Single source of truth for session/run status — matches Qala's session states */
export type SessionStatus = 'creating' | 'running' | 'idle' | 'needs_attention' | 'stopped'

/** @deprecated Use SessionStatus instead */
export type RunStatus = SessionStatus
export type FileKind = 'code' | 'config' | 'test' | 'script' | 'doc'
export type RecapEntryType = 'agent' | 'user' | 'status'
export type DiffLineType = 'context' | 'addition' | 'deletion' | 'header'

export interface DiffLine {
  type: DiffLineType
  content: string
}

export interface DiffBlock {
  filename: string
  header: string
  lines: DiffLine[]
}

export interface RecapEntry {
  id: string
  type: RecapEntryType
  content: string
  diff?: DiffBlock
  timestamp?: string
}

export interface TouchedFile {
  id: string
  name: string
  path: string
  additions: number
  deletions: number
  kind: FileKind
  pending?: boolean
  /** File was read (e.g. by Read tool) but has no uncommitted changes */
  readOnly?: boolean
}

export interface RunData {
  id: string
  color?: string
  status: SessionStatus
  sessionId: string
  taskId: string
  initiative: string
  epic: string
  task: string
  repo: string
  worktree: string
  touchedFiles: TouchedFile[]
  recapEntries: RecapEntry[]
  rawLogs: string
  port: number | null
  backend: 'tmux' | null
  backendInfo?: string
  agentIcon?: string
  natsEnabled?: boolean
  natsSubject?: string
  natsSubscriptions?: string[]
  /**
   * ISO timestamp when the session's NATS control socket was detected
   * as orphaned. null means healthy or NATS disabled. Mirrors
   * Session.natsControlOrphanedAt — drives the Saloon broker-health dot.
   */
  natsControlOrphanedAt?: string | null
  parentId?: string  // ID of the run that spawned this one (for hands)
  breakoutRooms?: string[]  // NATS room subjects for parent-child communication
}


export interface CommitRecord {
  sha: string
  subject: string
  body?: string
  authorName: string
  authorEmail: string
  authorDate: string
  observedAt: string
  repo: string
  branch: string
  worktreeId?: string
  taskTags: string[]
  source: 'hook' | 'reconcile'
}

// --- Entity settings (closest-ancestor inheritance) ---

export interface EntitySettings {
  project?: string
  worktree?: 'none' | 'new' | 'existing'
  defaultWorktreePath?: string
  backend?: 'tmux'
  skipPermissions?: boolean
  cliTemplate?: string
  defaultRunColor?: string
}

export interface ResolvedSettings {
  resolved: EntitySettings
  sources: Partial<Record<keyof EntitySettings, { type: GroupingDimension; name: string }>>
  local: EntitySettings
}

// --- Spaces ---

export interface Space {
  id: string
  name: string
  createdAt: string
  labelConfig?: SpaceLabelConfig
}

export interface LevelLabel {
  icon: string
  label: string
  plural?: string
}

export interface SpaceLabelConfig {
  levels: LevelLabel[]  // length 1–3, top-to-bottom
}

// --- Taxonomy entities ---

export interface Initiative {
  id: string
  name: string
  color: string
  status: 'active' | 'paused' | 'archived'
  summary: string
  settings?: EntitySettings
  spaceId?: string
  externalUrl?: string | null
}

export interface Epic {
  id: string
  name: string
  initiativeId: string
  status: string
  summary: string
  settings?: EntitySettings
  spaceId?: string
  externalUrl?: string | null
}

export interface Task {
  id: string
  name: string
  epicId: string
  initiativeId: string
  status: string
  settings?: EntitySettings
  spaceId?: string
  percentDone?: number | null
  externalUrl?: string | null
}

export interface Worktree {
  id: string
  name: string
  branch: string
  repo: string
  worktreePath: string
  spaceId?: string
}

// Enhanced run with foreign keys
export interface Run extends RunData {
  taskId: string
  worktreeId: string
  createdAt: string
  spaceId?: string
}

export interface EditorWidget {
  id: string
  spaceId?: string
  sessionId: string
  filePath: string
  task: string
  epic: string
  initiative: string
  worktree: string
  repo: string
  color?: string
}

export interface BrowserWidget {
  id: string
  spaceId?: string
  sessionId: string
  url: string
  title?: string
  color?: string
  headers?: Record<string, string>
}

export interface ImageWidget {
  id: string
  spaceId?: string
  sessionId: string
  filePath: string
  task: string
  epic: string
  initiative: string
  worktree: string
  repo: string
  color?: string
  naturalWidth: number
  naturalHeight: number
}

export interface NatsTrafficWidget {
  id: string
  spaceId?: string
  sessionId: string  // Filter to show traffic for a specific session, or empty for all
  subscriptions: string[]  // NATS subjects to subscribe to (e.g., "tinstar.>")
  color?: string
}

export interface PluginWidgetInstance {
  id: string                                                    // host-generated: `pw-${shortId}`
  pluginId: string                                              // matches manifest.name
  widgetType: string                                            // matches manifest.contributes.widgets[].type
  spaceId: string
  position: { x: number; y: number }
  size: { width: number; height: number }
  data: unknown                                                 // plugin-controlled; capped at 64KB serialized
  createdAt: string                                             // ISO 8601
  updatedAt: string                                             // ISO 8601
}

export interface TopicMetadata {
  subject: string
  name?: string
  description?: string
  kind: 'broadcast' | 'dm' | 'breakout' | 'custom'
  createdAt: string
  createdBy?: string
}

// --- Grouping ---

export type GroupingDimension = 'initiative' | 'epic' | 'task' | 'worktree'

export const ALL_DIMENSIONS: GroupingDimension[] = ['initiative', 'epic', 'task', 'worktree']

// --- Tree structures ---

export interface TreeNode {
  id: string
  label: string
  type: string
  entityId: string
  children: TreeNode[]
  runCount: number
  activeCount: number
  color?: string
  orphan?: boolean
  backend?: 'tmux' | null
  agentIcon?: string
  percentDone?: number | null
  status?: string
  externalUrl?: string | null
}

export interface TreemapNode {
  id: string
  label: string
  type: GroupingDimension | 'run'
  entityId: string
  children: TreemapNode[]
  x: number
  y: number
  width: number
  height: number
  color?: string
  depth: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// --- Selection ---

export interface SelectionState {
  selectedIds: Set<string>
  selectedType: GroupingDimension | 'run' | 'file-editor' | 'browser-widget' | 'image-viewer' | 'nats-traffic' | null
  expandedIds: Set<string>
  hoveredId: string | null
}

// --- View models ---

export interface RunSummaryViewModel {
  id: string
  runId: string
  title: string
  status: RunStatus
  initiative: string
  epic: string
  task: string
  worktree: string
  fileCount: number
  lastActivity: string
  lastRecap: string | null
}

export interface GroupRollupViewModel {
  id: string
  label: string
  type: GroupingDimension
  runCount: number
  activeCount: number
  completedCount: number
  failedCount: number
}
