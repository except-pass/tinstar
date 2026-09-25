import type { IntentKind } from '../contract/intent'

export const PORTFOLIO_SCHEMA = 'tinstar.v6.portfolio/1' as const

/** Editable board column. The name is a label, never an execution signal. */
export interface Column {
  id: string
  name: string
  description: string
  order: number
  revision: string
}

export interface Epic {
  id: string
  title: string
  columnId: string
  initiativeId: string | null
  planSlug: string | null
  completedAt: string | null
  order: number
  revision: string
}

/** Coordinates epics and projects. Membership is not a dependency. */
export interface Initiative {
  id: string
  name: string
  epicIds: string[]
  projectIds: string[]
  revision: string
}

/** One implementation task belongs to exactly one project. */
export interface TaskRecord {
  id: string
  project: string
  epicId: string | null
  planId: string | null
  initiativeId: string | null
  revision: string
}

export interface Dependency {
  id: string
  fromId: string
  toId: string
}

/** Ancestors copied only from the launch request, plus the task's one project. */
export interface LaunchAssociation {
  requestId: string
  taskId: string
  project: string
  planId: string | null
  epicId: string | null
  initiativeId: string | null
}

export type TransportDisposition = 'queued' | 'saved-unannounced' | 'not-receivable' | 'failed'

export type PendingDisposition = TransportDisposition | 'rejected' | 'stale' | 'applied'

export type Proposal =
  | { op: 'move'; epicId: string; toColumnId: string; order: number }
  | { op: 'set-completed'; epicId: string; completedAt: string | null }
  | { op: 'create-epic'; epic: Epic }
  | { op: 'rename-column'; columnId: string; name: string; description: string }
  | { op: 'reorder-column'; columnId: string; order: number }
  | { op: 'create-column'; column: Column }
  | { op: 'upsert-initiative'; initiative: Initiative }
  | { op: 'set-epic-initiative'; epicId: string; initiativeId: string | null }
  | { op: 'upsert-task'; task: TaskRecord }
  | { op: 'add-dependency'; dependency: Dependency }
  | { op: 'launch'; launch: LaunchAssociation }

export interface PendingIntent {
  requestId: string
  noteId: string | null
  kind: Extract<IntentKind, 'portfolio.mutate' | 'column.mutate' | 'launch.request'>
  revision: string | null
  disposition: PendingDisposition
  detail: string
  exitCode: number | null
  canReceive: boolean | 'unknown' | null
  noteOutcome: string | null
  proposal: Proposal
  /** True only after a matching applied receipt was reconciled. */
  applied: boolean
}

export interface PortfolioDoc {
  schema: typeof PORTFOLIO_SCHEMA
  /** True when this document was loaded from labeled fixture data. */
  fixture: boolean
  columns: Column[]
  epics: Epic[]
  initiatives: Initiative[]
  tasks: TaskRecord[]
  dependencies: Dependency[]
  launches: LaunchAssociation[]
  pending: PendingIntent[]
}

export interface MergedPlanTask {
  id: string
  label: string
  bucket: string
  start: number | null
  end: number | null
  source: 'tasks' | 'added'
  progress: number | null
  note: string | null
  removed: boolean
}

export interface MergedPlan {
  fixture: boolean
  tasks: MergedPlanTask[]
}

export interface PlanView {
  available: boolean
  fixture: boolean
  slug: string
  href: string | null
  tasks: MergedPlanTask[]
  detail: string
}
