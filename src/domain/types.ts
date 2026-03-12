// Re-export base types
export type {
  SessionStatus,
  RunStatus,
  FileKind,
  ProcedureStatus,
  RecapEntryType,
  DiffLineType,
  DiffLine,
  DiffBlock,
  RecapEntry,
  TouchedFile,
  Procedure,
  RunData,
} from '../types'

import type { RunData, SessionStatus as RunStatus } from '../types'

// --- Entity settings (closest-ancestor inheritance) ---

export interface EntitySettings {
  project?: string
  worktree?: 'none' | 'new' | 'existing'
  backend?: 'docker' | 'tmux'
  skipPermissions?: boolean
  profile?: string
}

export interface ResolvedSettings {
  resolved: EntitySettings
  sources: Partial<Record<keyof EntitySettings, { type: GroupingDimension; name: string }>>
  local: EntitySettings
}

// --- Taxonomy entities ---

export interface Initiative {
  id: string
  name: string
  color: string
  status: 'active' | 'paused' | 'archived'
  summary: string
  settings?: EntitySettings
}

export interface Epic {
  id: string
  name: string
  initiativeId: string
  status: string
  summary: string
  settings?: EntitySettings
}

export interface Task {
  id: string
  name: string
  epicId: string
  initiativeId: string
  status: string
  summary: string
  settings?: EntitySettings
}

export interface Worktree {
  id: string
  name: string
  branch: string
  repo: string
  worktreePath: string
}

// Enhanced run with foreign keys
export interface Run extends RunData {
  taskId: string
  worktreeId: string
  createdAt: string
}

// --- Grouping ---

export type GroupingDimension = 'initiative' | 'epic' | 'task' | 'worktree'

export const ALL_DIMENSIONS: GroupingDimension[] = ['initiative', 'epic', 'task', 'worktree']

// --- Tree structures ---

export interface TreeNode {
  id: string
  label: string
  type: GroupingDimension | 'run'
  entityId: string
  children: TreeNode[]
  runCount: number
  activeCount: number
  color?: string
  orphan?: boolean
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
  selectedId: string | null
  selectedType: GroupingDimension | 'run' | null
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
  procedureCount: number
  activeProcedures: number
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
