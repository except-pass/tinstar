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

/**
 * The RESERVED point id that carries a run's Objective — the user's standing
 * statement of what this session is for (S2). Exactly one per run, enforced
 * structurally: the point store keys on `(runId, id)`, so a PUT always amends the
 * same point rather than creating a second objective.
 *
 * It is USER-owned. Two guards keep it that way, and both are unit-tested:
 *   · the file watcher DROPS a `.tinstar/slate/*.json` entry claiming this id, so
 *     an agent-authored file can neither hijack nor retract it, and
 *   · `projectRunToSlate` gates the `'objective'` kind on `source === 'user'`, so
 *     even a file point that somehow carried this id renders as an ordinary surface.
 *
 * Shared by server and client so the literal exists in exactly one place.
 */
export const OBJECTIVE_POINT_ID = 'objective'

/**
 * The `SlateSurface.order` the objective is projected with, pinning it ahead of
 * every other surface (S2).
 *
 * MUST BE FINITE. `-Infinity` would serialize to `null` over SSE
 * (`JSON.stringify(-Infinity) === 'null'`), and a consumer sorting `run.slate` treats
 * a missing `order` as *last* — the pin would land at the bottom, which is worse than
 * having no sentinel at all. Every other surface's order is either an epoch-ms
 * `createdAt` or a reorder slot derived from one (`assignOrderSlots` only ever reuses
 * or increments existing values), so any negative number sorts first; -1 is the
 * smallest one that still reads as "before everything" at a glance.
 *
 * DEFENSIVE, not load-bearing for the run card today: `SlatePanel` lifts the objective
 * out of the grid by `kind` and never passes it through its sort, so the pin's on-screen
 * position comes from being rendered above the scroll body. The value is here for every
 * OTHER consumer of `run.slate` — plugins, future renderers, anything that sorts the
 * array as given — and so the ordering never depends on which one is reading.
 *
 * The projection FORCES this value rather than storing it on the point, so a user
 * reorder (`PUT /slate/points/order`, which assigns slots from `createdAt`) can
 * never strand the objective in the middle of the column.
 */
export const OBJECTIVE_ORDER = -1

/** How long an objective may be (characters). Longer than a point headline (200):
 *  an objective is a sentence or three of prose, not a one-line title. */
export const OBJECTIVE_MAX = 600

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
  /** Surface kind, drives which renderer the Slate panel picks. Derived by
   *  projectRunToSlate: a `source:'user'` point with the reserved
   *  {@link OBJECTIVE_POINT_ID} → 'objective' (the pinned goal card, S2);
   *  anchor.kind==='surface' → 'diagram' (a standalone card + thread); no/other
   *  anchor → 'open-point' (grouped list). */
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
  /** File-owned WORKBENCH set id (S4). Open-points sharing a non-empty `group` are
   *  pulled out of the vertical list and rendered as one horizontal workbench band —
   *  one question per column, each answering independently through its own point's
   *  `/answer` route. Absent for an ordinary point (which renders as a row, as before). */
  group?: string
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
  /** The canonical Surface's freshness lifecycle (plan U6, R18), projected onto the
   *  legacy shape so the Run Workspace Slate can render current / possibly-stale /
   *  queued / refreshing / failed / overdue without waiting for the recursive
   *  Canvas. Absent for a surface with no canonical record behind it. */
  freshness?: SurfaceFreshness
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
  /** File-owned WORKBENCH set id (S4): points sharing a non-empty `group` render
   *  side-by-side as a multi-question workbench (one question per column) instead
   *  of as rows in the vertical open-points list. Optional and purely presentational
   *  — an omitted `group` is today's behavior exactly. Rides the file→store→bridge
   *  path like `refresh`: overwritten on projection, cleared when omitted. */
  group?: string
  /** STORE-OWNED sort order within the run's points (S6 U2). Absent until the user
   *  reorders, in which case the projection falls back to `createdAt` — so an
   *  un-reordered Slate keeps its creation order exactly as before. A file
   *  re-projection never carries this field, so `mergeFileOwned`'s `...prior`
   *  spread is what preserves it; see `projectRunToSlate`, which reads
   *  `p.order ?? p.createdAt`. */
  order?: number
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

// --- Canonical Surfaces (recursive collaborative surfaces, U1) ---
//
// `Surface` is the CANONICAL work-artifact record (plan KTD1): one recursive
// primitive that owns authored content, thread, provenance, owner, freshness, and
// its own revision. A "container" is not a second entity — it is a Surface that
// happens to have children, which is why the parent link lives on the CHILD
// (`home`) and child indexes are DERIVED rather than stored. A Surface that gains
// its first child is byte-identical to the one that had none.
//
// `Point` and `SlateSurface` above become compatibility shapes over this record
// rather than independent sources of truth. Nothing reads these types yet: U1
// introduces the model and its store; the migration, persistence, and projection
// wiring are later units.

/** Where a Surface lives. Exactly one home, always (plan KTD2/R2) — recursion is
 *  a tree, not a general graph. Canvas is a HOME, not a Surface (R29), so the two
 *  cases are structurally different rather than a nullable parent id.
 *
 *  Run Workspace membership is deliberately NOT a third case: it is a
 *  compatibility PRESENTATION carried by {@link SurfaceCompatAlias}, so promoting
 *  a run-scoped Surface onto the Canvas is an ordinary home change and never
 *  produces a second writable copy (KTD3/R28).
 *
 *  The third case, `recovery`, is what makes deletion reversible (plan KTD15).
 *  A deleted subtree is MOVED here inside the same atomic transaction that would
 *  otherwise have destroyed it, so it leaves its parent's child list without ever
 *  leaving the record set — which is why delete and its undo are ordinary
 *  revision-checked topology mutations rather than a separate mechanism. Only
 *  `delete` may put a Surface here and only `restore` may take one out; an
 *  ordinary reparent that named it would be a delete with no bookkeeping. */
export type SurfaceHome =
  | { kind: 'canvas'; spaceId: string }
  | { kind: 'surface'; surfaceId: string }
  | { kind: 'recovery'; spaceId: string }

/** Who or what acts on a Surface (plan KTD6). One trusted local human in this
 *  release, but the identity seam is real: a stable browser actor id namespaces
 *  view state and audit entries, while managed sessions, host refresh jobs, and
 *  local processes each get their own principal so routing and freshness
 *  ownership can distinguish them. This is product-level routing identity — it
 *  does NOT claim isolation against a hostile local process. */
export interface SurfacePrincipalRef {
  kind: 'human' | 'session' | 'job' | 'process'
  /** Stable within `kind`: a browser actor id, a managed session id, a job id, or
   *  a process identity. */
  id: string
  /** Display label captured at reference time, so a retired session still renders
   *  as a name rather than an opaque id. */
  label?: string
}

/** Explicit provenance (R12): the project/repo/worktree/run context a Surface was
 *  produced in. A source file's location may SEED these but never replace them —
 *  a Surface that moves, or a parent spanning two worktrees, needs context that
 *  outlives the path it happened to be authored at. */
export interface SurfaceProvenance {
  project?: string
  repo?: string
  worktreeId?: string
  runId?: string
  sessionId?: string
}

/** Which authority may replace authored content (plan KTD4). `source-binding`
 *  means the bound source wins and a direct content edit must go back through its
 *  adapter (or explicitly transfer authority); `canonical-direct` means the record
 *  is authoritative and later file changes are reported as divergence rather than
 *  applied. Persisted rather than inferred, because "who wins" must survive a
 *  restart — inferring it from the presence of a binding would silently reassign
 *  authority the first time a source disappeared. */
export type SurfaceContentAuthority = 'source-binding' | 'canonical-direct'

/**
 * Whether the adapter that owns a binding could still SEE its source at the last
 * reconciliation epoch (U2).
 *
 * ABSENT IS A THIRD STATE, and the reason this is not a boolean: it means no
 * reconciler has ever observed this binding. That is what the legacy migration's
 * `legacy-slate-point` binding looks like — a logical `run:…/point:…` address into
 * the legacy bridge with no file behind it to observe — and what any binding minted
 * outside an epoch looks like. Only a binding that was once `present` can become
 * `missing`, so "the source vanished" and "there was never a source to find" are
 * distinguishable states rather than one shared absence.
 */
export type SurfaceSourceState = 'present' | 'missing'

/** The external source a Surface's content is reconciled from (U2's adapters). */
export interface SurfaceSourceBinding {
  /** Which reconciler owns this source. `slate-file` is U2's file reconciler;
   *  `legacy-slate-point` is what migration stamps on a point it adopted from the
   *  legacy bridge, which has no path. Left as an open string so a later adapter is
   *  a registry entry rather than a schema migration. */
  adapter: string
  /** Adapter-scoped locator — for `slate-file`, `file:<name>#<entry id>` relative
   *  to {@link worktree}. */
  locator: string
  /** The worktree the locator resolves against. Persisted rather than looked up
   *  from the live session, so reconciliation survives the session retiring while
   *  the path is still there (U2's decoupling requirement). */
  worktree?: string
  /** HOST-owned monotonic observation generation (plan KTD10). The freshness
   *  barrier compares generations, never wall-clock time: content hashes, Git
   *  SHAs, and process ids are EVIDENCE and are never ordered as time. */
  generation: number
  /** Opaque adapter evidence for the observation that produced current content
   *  (content hash, Git SHA, mtime). Compared for equality only. Because it is only
   *  advanced by a VALID read, it doubles as the last-valid watermark: a torn read
   *  leaves it naming the last body that actually parsed. */
  watermark?: string
  /** See {@link SurfaceSourceState}. */
  state?: SurfaceSourceState
  /** Epoch ms of the FIRST epoch that found the source gone, cleared when it
   *  returns.
   *
   *  There is deliberately NO "last seen at" counterpart. The poll floor
   *  re-observes every binding every few seconds, so a last-seen stamp would differ
   *  on every tick and commit a revision per surface per tick forever — the exact
   *  storm the store's bookkeeping-only short-circuit exists to prevent. Every other
   *  field here changes only when the source does, which is what makes a steady
   *  state genuinely free. */
  missingSince?: number
  /** Source evidence that DIFFERS from what the current content reflects — set only
   *  while authority is `canonical-direct` (KTD4: "Canonical-direct content ignores
   *  later file changes except to report divergence"). Cleared when the source comes
   *  back into agreement, or when authority moves back to the binding. */
  divergedWatermark?: string
}

/**
 * The CLOSED trigger vocabulary (R14, plan U6).
 *
 * Closed on purpose. The plan's test scenario is that "trigger matching ignores
 * arbitrary NATS payload strings and unsupported executable watcher declarations"
 * — an open string would make every unparsed message a potential trigger, and an
 * `exec:`-shaped declaration would turn a file an agent wrote into a command the
 * host runs.
 */
export type SurfaceTriggerKind =
  /** A source the Surface DECLARES it derives from changed. Not the Surface's own
   *  binding: that path is `observeSource`, which makes it current rather than
   *  stale. */
  | 'source-content'
  /** The bound worktree's Git revision moved. */
  | 'git-revision'
  /** A tracked local process completed or failed. */
  | 'process-exit'
  /** A managed session started, ended, or was retired. */
  | 'session-lifecycle'
  /** A human asked for it — the ⟳ button, or an agent relaying a user request. */
  | 'human-intent'
  /** An explicit named signal an agent published. Matched against the Surface's
   *  own declared signal names, never against free text. */
  | 'semantic-signal'
  /** The time-safety sweep: `dueAt` passed. */
  | 'periodic'

/** How aggressively a Surface is kept current (R15). `automatic` refreshes without
 *  asking (bounded by the coordinator's cap); `mark-stale` only badges it and waits
 *  for a human; `manual` does neither — nothing but an explicit refresh moves it. */
export type SurfaceRefreshPolicy = 'automatic' | 'mark-stale' | 'manual'

/** An author's declarative freshness contract for one Surface (R13/R14). Lives on
 *  authored content because it is exactly what KTD4 lets a source replace: the
 *  recipe and its trigger declarations travel together or they disagree. */
export interface SurfaceRefreshDeclaration {
  policy: SurfaceRefreshPolicy
  /** Which trigger kinds this Surface listens to. Unknown names are dropped at
   *  parse time rather than stored, so a persisted record only ever holds
   *  vocabulary the host implements. */
  triggers: SurfaceTriggerKind[]
  /** Verification interval (ms) — what `dueAt` is derived from. Absent falls back
   *  to the host default. */
  intervalMs?: number
  /** Source identifiers this Surface derives FROM, for `source-content` matching.
   *  Adapter-scoped strings, compared for equality. */
  sources?: string[]
  /** Named signals this Surface listens for, for `semantic-signal` matching. */
  signals?: string[]
}

/** The execution phase of a Surface's freshness lifecycle (R18). Kept SEPARATE
 *  from {@link PointStatus}: a resolved discussion says nothing about whether the
 *  content still reflects its source. */
export type SurfaceFreshnessPhase = 'current' | 'possibly-stale' | 'queued' | 'refreshing' | 'failed'

/** Why the host believes a Surface may no longer reflect its sources (R15). */
export interface SurfaceStaleReason {
  kind: SurfaceTriggerKind
  /** What two observations must SHARE to count as the same one. Persisted so
   *  "repeated equivalent events create one queued job" survives a restart: an
   *  event whose key already sits here advances nothing and commits nothing. */
  key: string
  /** One sentence, safe to render. */
  detail: string
  /** Opaque adapter evidence for the observation — a content hash, a Git SHA, an
   *  exit code. Compared for EQUALITY only and never ordered as time (KTD10); the
   *  host generation below is the only ordering. */
  evidence?: string
  /** The host observation generation this reason was recorded at. */
  generation: number
  at: number
}

/** What the host knows about whether a Surface still reflects its source. */
export interface SurfaceFreshness {
  phase: SurfaceFreshnessPhase
  /** ORTHOGONAL to `phase`, not a sixth phase: entering `queued` or `refreshing`
   *  retains the overdue badge until a verification actually succeeds, so a
   *  retry loop cannot make an overdue Surface look attended-to. */
  overdue: boolean
  /** Epoch ms verification deadline. Absent when the Surface declares no policy. */
  dueAt?: number
  /** The source generation the CURRENT content reflects. A refresh that finishes
   *  against an older generation than the source now has is superseded rather
   *  than allowed to claim current (KTD10). */
  observedGeneration?: number
  /** Epoch ms of the last successful verification. */
  verifiedAt?: number
  /** Why this Surface left `current`. Retained through `queued` and `refreshing`
   *  so the reason a refresh is happening survives into the UI, and cleared only
   *  by a successful verification barrier. */
  staleReason?: SurfaceStaleReason
  /** The last dedupe key recorded PER TRIGGER KIND — the memory that makes
   *  "repeated equivalent events commit nothing" actually true.
   *
   *  `staleReason` alone cannot do it: it is ONE slot, so two live triggers
   *  overwrite each other's key and each then reads the other's as "new". With the
   *  host defaults (`git-revision` + `periodic`) that is the ordinary case, and it
   *  ping-ponged forever on an IDLE repo — a revision and a generation burned every
   *  few seconds, every refresh superseded by the churn its own supersession caused,
   *  so `verifiedAt` never advanced, so `overdue` never cleared, and every cycle
   *  launched a real background agent in the user's worktree.
   *
   *  Keyed by kind rather than kept as a ring of recent keys on purpose: the
   *  vocabulary is closed and small (bounded by construction, no eviction policy),
   *  and a key is only ever compared against the LAST one of its own kind — so
   *  returning to an earlier Git SHA is correctly seen as a move, which a
   *  remembers-everything set would have swallowed.
   *
   *  Deliberately NOT cleared by a successful barrier. Clearing it is what let the
   *  very next poll of an unchanged SHA re-stale a Surface that had just been
   *  verified against exactly that SHA. */
  lastReasonKeys?: Partial<Record<SurfaceTriggerKind, string>>
  /** Why the last refresh attempt did not produce a verified result. Present in
   *  `failed`, and deliberately RETAINED into a subsequent `queued`/`refreshing`
   *  so a retry does not erase the explanation before the retry has earned it. */
  failure?: { message: string; at: number }
  /** The refresh job currently responsible for this Surface, if any. Advisory —
   *  the job record is separate bookkeeping and the barrier never trusts it over
   *  the record's own revision and generation. */
  jobId?: string
}

/** A Surface's authored content — the part an authority may replace (KTD4). */
export interface SurfaceContent {
  /** One-line title. Always present: a Surface with no headline has nothing to
   *  render in a rail row, a breadcrumb, or a collapsed parent preview. */
  headline: string
  /** A2UI body from the bounded component catalog (R7). Absent for a Surface that
   *  is a bare headline plus thread. */
  body?: A2uiContent
  /** Author-declared refresh recipe (R13): the self-contained instruction that
   *  rebuilds this Surface. Absent means refresh degrades to a bare nudge. */
  recipe?: string
  /** Author-declared freshness contract (R13/R14, plan U6). Absent means the host
   *  applies its defaults — see `effectiveDeclaration` in
   *  `src/server/surfaces/surface-trigger-matcher.ts`. */
  refreshPolicy?: SurfaceRefreshDeclaration
}

/** View-independent discussion state (R5/R8). Shared, never per-user: a thread is
 *  what the collaboration is, so it may not live in a browser's view namespace.
 *  Mirrors the Slate `Point` thread deliberately, so the compatibility projection
 *  is a field rename rather than a lossy conversion. */
export interface SurfaceThread {
  /** Append-only, oldest first. */
  replies: Reply[]
  /** DERIVED from the thread unless `resolvedAt`/`dismissedAt` is set. Stored
   *  rather than recomputed at read time so every reader — canonical, legacy
   *  projection, rail rollup — agrees without re-deriving. */
  status: PointStatus
  /** Set only by an explicit resolve; survives a source re-projection. */
  resolvedAt?: number
  /** Set only by an explicit dismiss; survives a source re-projection. */
  dismissedAt?: number
}

/** A legacy presentation of a canonical Surface (plan KTD3). NOT a home: the
 *  alias controls where a Surface additionally SHOWS UP during migration and
 *  whether that presentation is visible, while `home` stays the single answer to
 *  where it lives. `workspace-recovery` is the fallback bucket for a Surface whose
 *  source run no longer exists, so disabling recursive mode can still expose every
 *  alias as a flat compatibility list. */
export interface SurfaceCompatAlias {
  bucket: { kind: 'run'; runId: string } | { kind: 'workspace-recovery' }
  /** The legacy id inside that bucket — what `Run.slate` projects as its `id`, so
   *  an existing client keeps addressing the point id it already knows. */
  localId: string
  /** False once the user closes the legacy presentation. Closing HIDES the alias;
   *  it never deletes the canonical Surface. */
  visible: boolean
}

/** Bookkeeping stamped on the ROOT of a deleted subtree (plan KTD15).
 *
 *  Only the root carries it, and only the root's `home` changes. Its descendants
 *  keep pointing at their own parents, so the subtree stays intact and "is this
 *  deleted" is answered by walking up to a `recovery` home. That is what makes
 *  nested deletion behave: deleting a child and then its parent produces two
 *  independent recovery roots, and restoring the parent restores exactly what it
 *  still held rather than resurrecting the child someone deleted separately. */
export interface SurfaceDeletion {
  /** Epoch ms of the delete. */
  at: number
  /** Who deleted it. Absent only for a delete performed with no actor context. */
  by?: SurfacePrincipalRef
  /** Where `restore` puts it back. Held on the record rather than derived,
   *  because the whole point is that it survives the parent being deleted too. */
  formerHome: SurfaceHome
  /** How the subtree was disposed. `reparent-children` means the immediate
   *  children were promoted to `formerHome` before the root moved, so a restore
   *  brings back a leaf rather than silently re-adopting them. */
  disposition: SurfaceDeleteDisposition
}

/** What happens to a non-empty parent's children when it is deleted (R6/AE6).
 *  There is no default: a caller deleting a parent with descendants must say
 *  which one it means, so a confirmation dialog can never remove more than the
 *  human agreed to. */
export type SurfaceDeleteDisposition = 'reparent-children' | 'delete-subtree'

/** The canonical work artifact (plan KTD1). One recursive primitive: leaves and
 *  parents share this record, these affordances, and this lifecycle.
 *
 *  Identity is GLOBAL and NON-REUSABLE — unlike a `Point`, whose id is unique only
 *  within its run. That is what lets a Surface move between homes without changing
 *  identity, and it is why the migration derives ids from a run INCARNATION rather
 *  than from the run name: deleting and recreating a run must not resurrect the
 *  earlier Surface's thread under a new run that merely shares its name. */
export interface Surface {
  id: string
  /** The space this Surface belongs to. IMMUTABLE once created, and the reason
   *  cross-space parentage is a REJECTABLE error rather than an impossible state:
   *  if space were derived by walking home links to Canvas, a cross-space move
   *  would silently teleport a whole subtree instead of failing. */
  spaceId: string
  home: SurfaceHome
  /** Sibling order within `home`. Host-owned topology (never source-authored).
   *  Absent falls back to `createdAt`, so an unordered set keeps creation order. */
  order?: number
  content: SurfaceContent
  contentAuthority: SurfaceContentAuthority
  /** Present when content is reconciled from an external source. A Surface may
   *  keep its binding while holding `canonical-direct` authority — that is exactly
   *  the divergence-reporting case in KTD4. */
  source?: SurfaceSourceBinding
  provenance?: SurfaceProvenance
  /** Who authored the current body — the compatibility counterpart of
   *  {@link Point.author}. */
  author: PointAuthor
  /** Who is responsible for keeping this Surface fresh (R13/R16). Absent means
   *  unowned, which is what makes coordinator inheritance detectable. */
  owner?: SurfacePrincipalRef
  thread: SurfaceThread
  freshness: SurfaceFreshness
  /** Legacy presentations. Plural because KTD3 maps a Surface to "one or more run
   *  or workspace fallback buckets" — a promoted Surface keeps its run alias while
   *  a run-less one gains the workspace recovery bucket. */
  aliases?: SurfaceCompatAlias[]
  /** Migration presentation metadata (KTD3), NOT a second container type: a
   *  per-run root Surface carries the standard model but is excluded from ordinary
   *  Canvas projection so migration does not dump a root card onto the canvas. */
  compatibilityOnly?: boolean
  /** Present exactly on the ROOT of a deleted subtree, whose `home` is
   *  `recovery` (KTD15). Absent everywhere else, including on the descendants
   *  that moved with it. */
  deleted?: SurfaceDeletion
  /** Per-record revision. Monotonic, host-assigned, and compared by every
   *  content write (KTD7) — never accepted from a mutable request field. */
  rev: number
  /** The SPACE topology revision in force when this record's `home` last changed.
   *  Stamped on the record so a flat record list is sufficient to reconstruct the
   *  per-space topology revision exactly on reload — one source of truth instead
   *  of a snapshot-level counter that can drift from the records it describes. */
  homeRev: number
  createdAt: number
  amendedAt: number
}

/** How the canonical Surface sidecar loaded at boot (plan KTD5). Mirrors
 *  `SurfaceStoreHealth` in `src/server/stores/surface-persistence.ts`; declared
 *  here because it crosses the wire in the SSE snapshot and the client renders
 *  the degraded case. */
export type SurfaceHealth = 'healthy' | 'recovered' | 'faulted-read-only'

/**
 * The canonical Surface store's health as the client sees it, carried on every
 * SSE snapshot.
 *
 * It exists for one case: `faulted-read-only`. When neither Surface snapshot is
 * readable the server keeps rendering the FROZEN legacy Slate (that is the user's
 * only copy) but it must never present that copy as current — the plan's success
 * criterion is that no surface presents stale data as current. So the client shows
 * a non-dismissable degraded marker naming when the legacy snapshot was frozen,
 * and the canonical projection stays EMPTY rather than partial.
 */
export interface SurfaceHealthStatus {
  health: SurfaceHealth
  /**
   * ISO stamp of the frozen legacy document snapshot — the last time
   * `docstore.json` was written before this faulted boot.
   *
   * NOT the canonical store's own migration timestamp, and deliberately so: when
   * both sidecar snapshots are unreadable there is nothing left to read that
   * timestamp OUT of, and inventing one would be exactly the "presented as
   * current" failure this marker exists to prevent. The legacy snapshot's mtime is
   * the newest honest answer available in the faulted state.
   */
  frozenAt?: string
  /** One sentence naming what was wrong with each snapshot file, safe to render. */
  detail?: string
}

// --- Agent/UI parity contract (recursive collaborative surfaces, U3) ---
//
// Everything below is what the mutation service RETURNS. It lives in
// `domain/types.ts` rather than beside the service because the plan's
// Agent-Native Action Parity table is a contract with two consumers that must
// not drift: "Return canonical revisions, effective capabilities, provenance,
// and freshness so agents and UI consume the same contract." A shape only the
// server could name would let the Canvas and the CLI describe the same Surface
// differently, which is exactly the divergence U3 exists to prevent.

/** What this actor may do to this Surface RIGHT NOW, evaluated against its
 *  current state rather than a static permission table.
 *
 *  Every flag is accompanied by a reason when it is false (see `blocked`), and
 *  that pairing is the point: an agent that is told `updateContent: false` with
 *  no reason has to guess, and guessing at a content-authority boundary is how a
 *  file-authored Surface gets clobbered. Note what is NOT here — there is no
 *  approval or proposal capability, because under the ratified Key Decision
 *  ("Recoverable action over gated action") agents act directly and safety comes
 *  from the recovery store. */
export interface SurfaceCapabilities {
  /** Which authority may currently replace `content`. */
  contentAuthority: SurfaceContentAuthority
  /** True when a direct content write can be committed — either the record is
   *  `canonical-direct`, or its source adapter is registered and can carry the
   *  edit back to the source (KTD4). */
  updateContent: boolean
  appendThread: boolean
  /** Topology. All three are true for any live Surface: agents may arrange and
   *  delete ANY Surface, not only their own (plan U3: "arrangement carries no
   *  ownership gate"). They go false for a deleted record, which must be restored
   *  before it can be moved. */
  group: boolean
  reparent: boolean
  delete: boolean
  /** Inverse: true only inside the recovery store. */
  restore: boolean
  purge: boolean
  /** True when a refresh request will be accepted at all. */
  refresh: boolean
  /** True when the Surface declares a self-contained recipe, so the host can
   *  rebuild it without a human. False means a refresh request is a NUDGE to
   *  whoever owns it (R13's "absent means refresh degrades to a bare nudge") —
   *  a distinct question from whether the request is accepted, and collapsing the
   *  two into one flag would make it lie in one direction or the other. */
  refreshRecipe: boolean
  /** Why each false flag is false. Keyed by capability name. */
  blocked?: Partial<Record<
    'updateContent' | 'appendThread' | 'group' | 'reparent' | 'delete' | 'restore' | 'purge' | 'refresh',
    string
  >>
}

/** A Surface as it appears in someone ELSE's context — an ancestor breadcrumb, a
 *  child rollup row. Deliberately not the whole record: a parent context that
 *  inlined every descendant's A2UI body would grow without bound at depth, which
 *  is the "recursive content hangs the client" risk in the plan's risk table.
 *
 *  `accessible: false` is the redaction case. The parity table bounds descendant
 *  context "by effective worktree access", so a child in a worktree the caller is
 *  not authorized for is REPORTED (its existence and position are structural, and
 *  hiding it would make counts lie) with its authored content withheld. */
export interface SurfaceSummary {
  id: string
  headline: string
  accessible: boolean
  childCount: number
  status: PointStatus
  freshness: SurfaceFreshness
  author: PointAuthor
  compatibilityOnly?: boolean
  worktreeId?: string
  /** Present only when `accessible` is false: which authority boundary withheld
   *  the content. */
  withheld?: string
}

/** How a contributor's identity resolves to something a human can actually open
 *  (R11/F5). Four outcomes, and the fourth is honest rather than empty. */
export type SurfaceContributorResolution =
  /** A live managed session — `TerminalPrimitive`/ttyd is offered. */
  | 'live-session'
  /** Retired, but a Graveyard transcript exists — read-only drill-down. */
  | 'graveyard'
  /** A local process or file source. Evidence only; there is no terminal and the
   *  UI must not offer a dead one. */
  | 'process-evidence'
  /** Named on the record but nothing backs it any more. */
  | 'unavailable'

export interface SurfaceContributor {
  principal: SurfacePrincipalRef
  /** Why this principal is attached: it owns the Surface, it authored the
   *  content, it is the run/session the Surface was produced in, or it is the
   *  external source the content is reconciled from. */
  role: 'owner' | 'session' | 'run' | 'source'
  resolution: SurfaceContributorResolution
  /** True only for `live-session`. Carried explicitly so a client renders the
   *  terminal affordance from one field instead of re-deriving the rule. */
  terminal: boolean
  /** What the host can show when there is no terminal: source locator, worktree,
   *  run, and the observation watermark the content reflects. */
  evidence?: {
    source?: string
    worktreeId?: string
    runId?: string
    sessionId?: string
    watermark?: string
  }
}

/** Everything an agent needs to act on one Surface without reading the store —
 *  the "Read tree and context" row of the parity table. */
export interface SurfaceContext {
  surface: Surface
  capabilities: SurfaceCapabilities
  spaceId: string
  /** The space topology revision this context was read at. A caller passes it
   *  back as `expectedTopologyRev` to make its next mutation compare-and-swap. */
  topologyRev: number
  /** Root-first, so rendering it as a breadcrumb needs no reversal. */
  ancestors: SurfaceSummary[]
  /** Immediate children only (KTD8): the workspace scope, not the whole subtree. */
  children: SurfaceSummary[]
  /** Total descendants at every depth — the number a delete confirmation needs
   *  and the one a preview badge shows. */
  descendantCount: number
  contributors: SurfaceContributor[]
  /** The tail of the thread, newest last, capped. The full thread is on the
   *  record; this is what a bounded prompt context carries. */
  recentThread: Reply[]
  /** Present only for a Surface inside the recovery store. */
  deleted?: SurfaceDeletion
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
