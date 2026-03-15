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

export interface StoredProcedure {
  id: string
  skillName: string   // matches SkillDTO.name
}

export interface ResolvedProcedure extends StoredProcedure {
  entityId: string
  entityType: 'task' | 'epic' | 'initiative'
}

export interface PendingSkill {
  id: string                // client-generated UUID == draftId
  placeholderName: string   // typed description shown while agent works
  status: 'defining' | 'saving' | 'error'
  entityId: string
  entityType: 'task' | 'epic' | 'initiative'
  sessionId: string
}

export interface SkillDTO {
  name: string
  description?: string
  source: 'system' | 'repo' | 'plugin'
}

export interface RunData {
  id: string
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
  backend: 'docker' | 'tmux' | null
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
