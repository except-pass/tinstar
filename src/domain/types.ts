// Single source of truth for all shared domain types.
//
// Previously these types lived in two places: src/types.ts and this file,
// with src/types.ts owning the primitives and src/domain/types.ts owning
// the entity shapes. 37 files imported from src/types.ts directly,
// duplicating the domain root. This file is now the canonical home;
// src/types.ts is a thin re-export shim for backwards compatibility.

// Type-only (erases at build time, so the cycle with pinSet.ts never exists at
// runtime): notice follow-up threads reuse the notes/pins `Reply` shape verbatim
// rather than growing a parallel message type.
import type { Reply } from './pinSet'

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
  /** For an `agent` entry: number of tool_use blocks the agent emitted during
   *  that turn (summed across all assistant messages in the turn, including the
   *  tool-only intermediate ones that carry no text). Absent on user/status. */
  toolUses?: number
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
  /**
   * Optional human-chosen display name, shown wherever the UI would otherwise
   * show `id` (sidebar, run card header, inbox, fleet, Saloon, graveyard).
   * Free text — deliberately NOT passed through the id sanitizer.
   *
   * Display-only. `id` remains the sole identity: it is the tmux session name,
   * the worktree dir, the git branch, the run's NATS subject token, and the key
   * for widget layouts / pins / constellations. Nothing resolves a name back to
   * a run, so names need not be unique.
   *
   * Absent or empty ⇒ fall back to `id`. Use `name || id`, never `name ?? id`:
   * clearing a name from the UI yields '', which `??` would render as blank.
   */
  name?: string
  color?: string
  status: SessionStatus
  /**
   * Background session: fully alive and commandable but hidden from the
   * canvas, hierarchy sidebar, inbox, and session cycling by default.
   * Mirrors Session.background (session record is SSOT); consumers filter
   * on this projection.
   */
  background: boolean
  /**
   * Agent is stuck on a pending tool_use (permission prompt) with no child
   * processes running. Mirrors Session.blocked; an input to attention
   * derivation alongside `status` and `background`.
   */
  blocked: boolean
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
  /** When false, the client must NOT pan/zoom the viewport to this run when it
   *  first appears (passive spawn). Set from `focus:false` on POST /api/sessions
   *  so background/supervisor callers can create a session without yanking the
   *  user's camera. Absent/true ⇒ the canvas auto-focuses the new run as usual. */
  focusOnCreate?: boolean
  /** The run's Slate surfaces (see The Slate). A server-authoritative projection
   *  populated by the Slate watcher from `.tinstar/slate/*`. Adding this field is
   *  a 3-place change (this type, `runShallowEqual`, and `mergeRun` in
   *  useServerEvents) — two of which fail SILENTLY if missed; see those sites. */
  slate?: SlateSurface[]
}


/**
 * A retired session's durable record in the Graveyard. Written when a session
 * is deleted (see DELETE /api/sessions/:name) and survives removal of the
 * per-session dir and worktree, because it lives in the config-root docstore.
 * Keyed by `convId` — the Claude Code `conversation.id` — which is the
 * ground-truth handle used to necro (revive) the session later. Resolve the
 * transcript by this id, never by newest-mtime.
 */
export interface Tombstone {
  /** Claude Code conversation.id — the resume handle and the map key. */
  convId: string
  /**
   * The session's name at retire-time — an IDENTITY handle, not a label.
   * `reviveName()` re-materializes the session from this, so it must stay the
   * real session name. Never overwrite it with a display string; put the
   * human-facing label in `displayName` instead.
   */
  sessionName: string
  /**
   * The run's friendly name at retire-time, snapshotted so the graveyard stays
   * readable after the run itself is gone. Absent ⇒ fall back to `sessionName`
   * (tombstones written before friendly names existed have none).
   */
  displayName?: string
  /** Deterministic roll-up of what the session covered (searchable). */
  coversSummary: string
  /** Task hierarchy at retire-time, for display + search + revive project resolution. */
  taskId?: string
  task?: string
  epic?: string
  initiative?: string
  /**
   * Project the session belonged to, resolved from entity settings at
   * retire-time. Absent on graves buried before this field existed — the
   * settings that resolved them are gone, so there is no backfill. Treat
   * absent as "unknown project", never as a project named "".
   */
  project?: string
  /** Workspace path the session ran in; may no longer exist at revive-time. */
  workspacePath?: string
  /** Model the session last ran with, if known. */
  model?: string
  /** ISO timestamp the session was originally created. */
  created?: string
  /** ISO timestamp the session was retired (tombstoned). */
  retiredAt: string
  /** True when Tinstar snapshotted the transcript into its own store at
   *  retire-time, so revive survives Claude Code pruning the original. */
  snapshotted?: boolean
  /** True when the session was a background (machinery) session at
   *  retire-time. The graveyard UI ignores it in v1; carried so machinery
   *  tombstones stay distinguishable later without a migration. */
  background?: boolean
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
 *  attached session via POST /api/sessions/:name/enter-prompt; sentAt marks delivery. */
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

/** A standing brief an agent posts to the Roundup: what it needs from the user
 *  (`needs-you`) or a call it made on its own (`fyi`). Flat and run-scoped like
 *  ImageWidget. `runId` holds the posting run's `.id` (the session name), which
 *  is how the run-end cascade in deleteRun keys the drop — a notice never
 *  outlives its run (R20). `createdAt`/`amendedAt` are epoch millis; on a fresh
 *  post they are equal, and `amendedAt` advances on each in-place amend (R21). */
export interface Notice {
  id: string
  runId: string
  kind: 'needs-you' | 'fyi'
  headline: string
  /** The notice body as an A2UI v0_9 component description (R14). Optional — a
   *  headline-only notice carries none. Authored by agents, validated against
   *  the web_core v0_9 schema at the API boundary, and rendered read-only and
   *  host-themed by the Roundup widget's walker (R15), degrading when malformed
   *  (R16). Replaces slice 1's plain-markdown `background`. */
  content?: A2uiContent
  /** The user's answer, written on submit from the widget (R22/R23) and durable
   *  independent of whether the posting agent was reachable (KTD1/KTD3). Its
   *  presence marks the notice answered — the widget shows "answered" after a
   *  reload from this, and the agent decides the notice's fate (amend or pull).
   *  Absent until the user answers or dissents. */
  answer?: NoticeAnswer
  /** Epoch millis when the USER dismissed this notice — "I've seen it, it's off
   *  my plate". Deliberately a single optional timestamp and NOT a status enum:
   *  the Roundup is a board, not a kanban. A dismissed notice stays on the board
   *  (dimmed and collapsed, with an undo) so it keeps a short memory; clearing
   *  the field un-dismisses it. Dismissal is a VIEW-level act about the user's
   *  attention — it never prompts the posting agent (unlike `answer`), and the
   *  agent is still expected to pull a notice it knows is resolved. */
  dismissedAt?: number
  /** The follow-up thread: the user's questions about this notice and the agent's
   *  answers, oldest first. Append-only and SERVER-owned — written exclusively by
   *  POST /api/notices/:id/replies, never by the PATCH amend path, so an agent
   *  amending its notice can't clobber a question that landed mid-flight (the same
   *  guarantee `mergePreservingReplies` gives note threads).
   *
   *  Reuses the notes/pins `Reply` shape so both threads render and read alike.
   *  Absent until the first question — a notice nobody asked about carries none.
   *  The thread is a SECONDARY surface in the widget (a collapsible ask panel), not
   *  part of the notice body: the card must stay glanceable no matter how long the
   *  thread gets. Knowledge worth keeping belongs in `content` via an amend; the
   *  thread is the conversation that got it there. */
  followUps?: Reply[]
  createdAt: number
  amendedAt: number
}

/** The user's reply to a notice. For a `needs-you` notice this is the chosen
 *  option(s) plus optional free text; for an `fyi` dissent it is the objection
 *  text with `dissent: true` and (usually) no choices. `choices` holds the
 *  selected option ids, validated server-side against the notice's declared
 *  choice set before persisting (KTD4). `answeredAt` is epoch millis. */
export interface NoticeAnswer {
  /** Selected choice option ids (empty for a text-only answer or a dissent). */
  choices: string[]
  /** Free-text field / objection text. Absent when the user only picked options. */
  text?: string
  /** True when this is an FYI dissent rather than a needs-you answer (R13). */
  dissent?: boolean
  answeredAt: number
}

/** One node in an A2UI component description. Mirrors web_core's v0_9
 *  `AnyComponent`: a `component` type string, an optional `id` (so other nodes
 *  can reference it), and arbitrary type-specific props (passthrough). Kept as a
 *  host-owned structural type so `domain/` and the server carry no runtime
 *  dependency on web_core; the plugin's `a2ui/schema.ts` is where the actual
 *  web_core zod schema validates this shape. */
export interface A2uiComponent {
  component: string
  id?: string
  [key: string]: unknown
}

/** A notice's A2UI content: a flat list of components plus an explicit `root`
 *  reference naming which one to render first. Children are referenced by id
 *  from within `components` (A2UI's flat-list-with-id-references model). This is
 *  a host envelope around the A2UI `AnyComponent` protocol unit — the "component
 *  list + root reference a createSurface would carry" — not an on-the-wire A2UI
 *  message (the MessageProcessor/streaming path is a later slice). */
export interface A2uiContent {
  root: string
  components: A2uiComponent[]
}

/** One surface on a run's Slate (see The Slate in CONCEPTS.md): a small,
 *  scoped, agent/user/process-authored panel rendered in the run workspace card.
 *  This is the client-facing PROJECTION the run card renders — assembled by the
 *  Slate store from the file-watched A2UI `body` plus store-owned points/threads.
 *
 *  Field ownership is the load-bearing invariant (plan KTD1): the file authors
 *  `body`/`kind`/`order`; the store owns everything else (points, threads,
 *  lifecycle). A file re-projection must merge by `id`, never clobber store fields.
 *  U2 wires this projection through the 3-place RunData contract; U3 fills in the
 *  store-owned thread/point detail. */
export interface SlateSurface {
  id: string
  /** Who authored the surface body — agent, the user, or a local process. */
  author: 'agent' | 'user' | 'process'
  /** Surface kind, drives which renderer the Slate panel picks. Derived from the
   *  anchor by projectRunToSlate: anchor.kind==='surface' → 'diagram' (a standalone
   *  card + thread); no/other anchor → 'open-point' (grouped list). */
  kind: string
  /** Sort order within the Slate; ties broken by createdAt. */
  order?: number
  /** File-owned A2UI body. Absent for a surface assembled purely from store state
   *  (e.g. a bare open-point). */
  body?: A2uiContent
  /** File-owned refresh recipe (plan U3/R5): the prompt the agent re-runs to
   *  regenerate this surface. Absent when the surface carries no recipe (refresh
   *  still nudges). Carried from the file through the store onto `run.slate`. */
  refresh?: string
  /** Point render fields — present when this surface is a store-backed point
   *  (open-points list, threaded surface). DocumentStore projects the run's
   *  SlateStore points into RunData.slate so the client renders ONE channel
   *  (run.slate) rather than subscribing to a second point stream. The file owns
   *  `body`/`headline`/`anchor`; the store owns `status`/`thread`. */
  headline?: string
  status?: PointStatus
  thread?: Reply[]
  anchor?: PointAnchor
  /** Server-set staleness marker (plan R19): present when a `process`-authored
   *  surface has gone stale (its wrapper stopped updating). The renderer styles it
   *  as "stalled/unknown" instead of a live spinner. */
  stalledAt?: number
  createdAt: number
  amendedAt: number
}

/** Who authored a Slate point/surface body. Mirrors {@link SlateSurface.author}. */
export type PointAuthor = 'agent' | 'user' | 'process'

/** A point's lifecycle status. `open`/`discussing`/`waiting` are DERIVED from the
 *  thread (replies + last-author); `resolved`/`dismissed` are EXPLICIT (set only by
 *  an HTTP resolve/dismiss and survive a subsequent file re-projection). The Slate
 *  never auto-resolves a point — that was the CMT-1302 failure this feature prevents. */
export type PointStatus = 'open' | 'discussing' | 'waiting' | 'resolved' | 'dismissed'

/** What a point is attached to. `none` = a free-standing open-points entry;
 *  `decision` / `surface` anchor it to a decision record or a Slate surface by id. */
export interface PointAnchor {
  kind: 'none' | 'decision' | 'surface'
  ref?: string
}

/** A store-backed addressable point on a run's Slate: an open question, decision,
 *  or follow-up with its own thread and lifecycle. Points are docstore state; a
 *  file (`.tinstar/slate/*.json`) authors only the file-owned fields (`headline`,
 *  `content`, `anchor`) — the store owns `status`, `replies`, and the lifecycle
 *  timestamps. A file re-projection MERGES BY `id` and must never clobber a
 *  store-owned thread or status (plan KTD1). Reuses the notes/pins {@link Reply}
 *  shape so all threads render and read alike. */
export interface Point {
  id: string
  runId: string
  /** Set once when the point is first created; a re-projection never flips it. */
  author: PointAuthor
  /** Provenance (plan U7 reconciliation). A `'file'` point is authored by a
   *  `.tinstar/slate/*.json` projection and is RETRACTED when a later file
   *  re-projection omits it; a `'user'` point is added over HTTP and is EXEMPT
   *  from that retraction, so a file re-projection can't nuke a point the user
   *  just added. Absent is treated as `'file'` (the projection default). */
  source?: 'file' | 'user'
  anchor?: PointAnchor
  /** File-owned: the one-line title of the point. */
  headline: string
  /** File-owned: the point's A2UI body (absent for a bare headline point). */
  content?: A2uiContent
  /** File-owned refresh recipe (plan U3/R5): the prompt POST /slate/surfaces/:pid/refresh
   *  delivers verbatim to regenerate this surface. Optional; a recipe-less surface
   *  still gets a bare nudge. Merged like the other file-owned fields (KTD3). */
  refresh?: string
  /** Derived from the thread unless `resolvedAt`/`dismissedAt` is set (explicit). */
  status: PointStatus
  /** Store-owned thread, append-only (mirrors pins/notes). Preserved across a
   *  file re-projection by `id`. */
  replies?: Reply[]
  createdAt: number
  amendedAt: number
  /** Set only by an explicit resolve; survives a later file re-projection. */
  resolvedAt?: number
  /** Set only by an explicit dismiss; survives a later file re-projection. */
  dismissedAt?: number
  /** Server-set backstop marker (plan R19): a `process`-authored point whose
   *  `amendedAt` has gone stale (no file update for N minutes) is marked stalled so
   *  a `kill -9`'d `tinstar-run` wrapper can't leave a permanent fake-live spinner.
   *  Only the SERVER can detect this (a client can only style age). Cleared when a
   *  later file re-projection actually changes the point's body. */
  stalledAt?: number
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
