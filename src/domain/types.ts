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
  attention?: AttentionState
  /** Widget type that renders this run's canvas node. Absent ⇒ 'run-workspace'
   *  (the default session-view). Set to a registered session-view plugin widget
   *  type (e.g. 'roborev-cockpit') to render that plugin as the session's view. */
  view?: string
  /** Persistent state for a plugin session-view (its api.widget.useData blob).
   *  Unused by the default run-workspace view. */
  viewData?: unknown
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
  /** Optional initial canvas placement seed, mirroring BrowserWidget. Set by the
   *  editor create endpoint when the widget snaps to its session. Honored by the
   *  layout system only for a node with no layout yet (e.g. an API/agent-created
   *  editor); interactive opens that set their own layout ignore it. */
  position?: { x: number; y: number }
  size?: { width: number; height: number }
}

/** DOM context captured when a browser note is dropped (best-effort; absent ⇒ coords-only). */
export interface BrowserNoteTarget {
  tag: string                          // 'h2', 'img', 'button', …
  selector?: string                    // best-effort CSS selector
  text?: string                        // trimmed nearby text (≤120 chars)
  imageSrc?: string                    // un-proxied src when the target is an <img>
  imageAlt?: string
  within?: { x: number; y: number }    // normalized 0..1 position inside the element
}

/** A positioned annotation on a page shown in a browser widget. Submitted to the
 *  attached session via POST /api/sessions/:id/enter-prompt; sentAt marks delivery. */
export interface BrowserNote {
  id: string
  url: string                          // page URL the note was placed on
  comment: string
  x: number                            // anchor in page-document CSS px
  y: number
  nx: number                           // normalized 0..1 against document size
  ny: number
  target?: BrowserNoteTarget
  createdAt: number
  sentAt?: number                      // undefined = unsent
}

export interface BrowserWidget {
  id: string
  spaceId?: string
  sessionId?: string          // optional — browser widgets can be standalone (no session)
  url: string
  title?: string
  color?: string
  headers?: Record<string, string>
  /** Positioned page annotations (see BrowserNote). Persisted via PATCH like url/headers. */
  notes?: BrowserNote[]
  /** Optional initial canvas placement seed. Honored by the layout system only
   *  when the widget's node has no layout yet (first appearance / fresh hydration);
   *  once placed it flows into `config.ui.layouts` like every other widget, and
   *  subsequent user drags update that — this value is not re-read. Set by the
   *  host placement API (POST/PATCH /api/browser-widgets) so a plugin can open a
   *  browser widget at a chosen spot. */
  position?: { x: number; y: number }
  /** Optional initial size paired with `position`. Defaults to 800×600 when a
   *  position is given without a size. */
  size?: { width: number; height: number }
}

/** An ephemeral HTML artifact an agent asked Tinstar to serve. Stored content
 *  (not a file reference) so it survives the source file being deleted and is
 *  served verbatim from GET /api/artifacts/:id. Owned by `widgetId`: deleting
 *  that browser widget deletes the artifact. */
export interface Artifact {
  id: string
  html: string
  name?: string
  /** Bumped on every update; drives the widget URL cache-buster that triggers reload. */
  rev: number
  /** Owning browser widget — lifecycle anchor for cleanup. */
  widgetId?: string
  spaceId?: string
  createdAt: number
  updatedAt: number
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

/** Urgency of a widget's current attention request.
 *  Drives both color and sort order in the Inbox view. */
export type AttentionLevel = 'urgent' | 'attention' | 'info'

/** A widget's current "needs attention" signal. Replacing, not append:
 *  each widget has at most one of these at a time. `setAt` is server-stamped
 *  on the PATCH that actually changed the state (identical re-sets are no-ops). */
export interface AttentionState {
  level: AttentionLevel
  reason: string       // ~80 char budget for display; longer is truncated by the UI
  setAt: string        // ISO 8601
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
  attention?: AttentionState
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
