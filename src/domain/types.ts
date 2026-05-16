// Re-export base types
export type {
  SessionStatus,
  RunStatus,
  FileKind,
  RecapEntryType,
  DiffLineType,
  DiffLine,
  DiffBlock,
  RecapEntry,
  TouchedFile,
  RunData,
} from '../types'

import type { RunData, SessionStatus as RunStatus } from '../types'

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
