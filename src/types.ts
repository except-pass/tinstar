export type RunStatus = 'active' | 'idle' | 'complete' | 'failed' | 'queued'
export type FileKind = 'code' | 'config' | 'test' | 'script' | 'doc'
export type ProcedureStatus = 'idle' | 'queued' | 'running' | 'complete' | 'failed'
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
}

export interface Procedure {
  id: string
  name: string
  command: string
  status: ProcedureStatus
}

export interface RunData {
  id: string
  status: RunStatus
  sessionId: string
  initiative: string
  epic: string
  task: string
  repo: string
  worktree: string
  touchedFiles: TouchedFile[]
  recapEntries: RecapEntry[]
  rawLogs: string
  procedures: Procedure[]
}
