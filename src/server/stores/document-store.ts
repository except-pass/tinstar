// Mutator contract:
//   Every mutator that emits `change` must equality-short-circuit on no-op
//   writes. Status-watcher (3s), reconcile (30s), and the git-diff loop
//   (10s) all re-assert state every tick — without the short-circuit they
//   broadcast SSE deltas and reschedule persist writes for nothing.
//
//   When you add a mutator, follow the existing pattern:
//     - read prev state from the relevant Map
//     - compare; return if equal
//     - mutate + emit
//
// Caller contract for upsertRun:
//   Use { ...existing, foo: x } — never { ...makeFreshRun() }. The shallow
//   equality check uses reference identity for touchedFiles / recapEntries
//   arrays. Spread preserves the refs; a fresh-from-factory rebuild defeats
//   the check and reintroduces the SSE/persist storm.
//
// See docs/conventions.md → "Docstore mutators".

import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget, TopicMetadata, PluginWidgetInstance, AttentionState, SessionStatus, Artifact, Tombstone, Notice, SlateSurface, Point, Surface, SurfaceHealthStatus, SurfaceHome } from '../../domain/types'
import type { CommitRecord } from '../commits'
import type { RunStatus, TouchedFile, RecapEntry } from '../../types'
import type { ConstellationGraph } from '../../domain/constellationGraph'
import { migrateSnapEdges } from '../../domain/constellationGraph'
import { type PinSet, removePinsForNode } from '../../domain/pinSet'
import { migrateAllBrowserNotes } from '../migrations/migrateAllBrowserNotes'
import { SlateStore } from './slate'
import { inRunSlate, pointFromCanonical, runAliasOf, slateSurfaceFromCanonical } from './run-slate-projection'
import {
  SurfaceStore,
  type SurfaceBatch,
  type SurfaceDeleteOpts,
  type SurfaceInit,
  type SurfacePlanResult,
  type SurfaceRejection,
  type SurfaceTopologyOpts,
  type SurfaceTopologyPlan,
} from './surfaces'
import type {
  SurfaceSidecar,
  SurfaceCommitResult,
  SurfaceIdempotencyReceipt,
  JsonValue,
} from './surface-persistence'
import { isFresh } from './surface-persistence'

/** Matches `MAX_IDEMPOTENCY_ENTRIES` in the Surface sidecar, so the durable and
 *  the memory-only receipt paths forget at the same point rather than at two
 *  different ones. A CEILING, not the policy: both paths expire by AGE
 *  (`IDEMPOTENCY_RETENTION_MS`) and use the count only to keep a pathological
 *  client from making the table unbounded. */
const MAX_MEMO_RECEIPTS = 2048

/**
 * One entry on the `changes` stream.
 *
 * `persistExempt` is the U1 seam. Every emit on this stream is wired to
 * `schedulePersist()` (see `enablePersistence`), which is why "keep `Run.slate`
 * byte-equivalent through the existing bridge" and "schedule no core document
 * write for a canonical Surface mutation" could not both hold before this flag
 * existed. A persist-exempt change broadcasts to SSE exactly like any other and
 * leaves `docstore.json` untouched.
 *
 * It is deliberately NOT a general-purpose "quiet write" switch. The only emitter
 * allowed to set it is the DERIVED `Run.slate` projection driven by a canonical
 * Surface mutation, whose durable home is the Surface sidecar — a second file, so
 * nothing about that mutation belongs in `docstore.json`. Any other use would be
 * a silent data-loss bug: the entity would live in `docstore.json` and stop being
 * written to it.
 */
export interface DocumentChange {
  entity: string
  id: string
  data: unknown
  runId?: string
  persistExempt?: boolean
}

/** Translate a non-background run's status into a default attention signal.
 *  Returns null when the inbox shouldn't surface the run. This is the
 *  legacy pre-`blocked` mapping — non-background sessions keep it exactly
 *  (blocked-aware attention for them is a deliberate follow-up, not v1).
 *  Prefer deriveRunAttention, which routes here for non-background runs. */
function attentionForRunStatus(status: SessionStatus): AttentionState | null {
  const now = new Date().toISOString()
  switch (status) {
    case 'needs_attention':
      return { level: 'urgent', reason: 'Needs your attention', setAt: now }
    case 'idle':
      // Quiet + ready: the agent finished its turn and is waiting for you.
      // Surfaces in the inbox as a fresh "your turn" item each time it lands here.
      return { level: 'attention', reason: 'Ready for input', setAt: now }
    case 'stopped':
      return { level: 'info', reason: 'Run stopped', setAt: now }
    case 'creating':
    case 'running':
      return null
  }
}

/** Attention is a pure derivation of `(status, blocked, background)`,
 *  re-derived whenever any input changes (status watcher flips, blocked
 *  add/remove, background PATCH, boot rehydrate/reconcile).
 *
 *  Background mapping: a background agent idles by design, so plain idle
 *  surfaces nothing — but a permission block (idle + blocked) is urgent, and
 *  stopped breaks through as info so machinery death is never silent.
 *  Non-background runs keep today's mapping exactly; `blocked` is ignored. */
function deriveRunAttention(status: SessionStatus, blocked: boolean, background: boolean): AttentionState | null {
  if (!background) return attentionForRunStatus(status)
  const now = new Date().toISOString()
  switch (status) {
    case 'needs_attention':
      return { level: 'urgent', reason: 'Needs your attention', setAt: now }
    case 'idle':
      return blocked
        ? { level: 'urgent', reason: 'Waiting on permission', setAt: now }
        : null
    case 'stopped':
      return { level: 'info', reason: 'Run stopped', setAt: now }
    case 'creating':
    case 'running':
      return null
  }
}

/** Boot-rehydrate correction guard: should `updateRunStatus` fire to sync the
 *  run projection to the persisted session and re-derive attention? Widened
 *  from status-only so a `blocked` flip persisted before a restart re-derives
 *  (AE4) instead of waiting on the watcher's in-memory re-detection. */
function runNeedsStatusCorrection(
  run: Pick<Run, 'status' | 'blocked'>,
  sessionState: SessionStatus,
  sessionBlocked: boolean,
): boolean {
  return run.status !== sessionState || run.blocked !== sessionBlocked
}

export { attentionForRunStatus, deriveRunAttention, runNeedsStatusCorrection }

function attentionShallowEqual(a?: AttentionState, b?: AttentionState): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.level === b.level && a.reason === b.reason && a.setAt === b.setAt
}

function runShallowEqual(a: Run, b: Run): boolean {
  if (a === b) return true
  // RunData fields
  if (a.id !== b.id) return false
  if (a.name !== b.name) return false
  if (a.color !== b.color) return false
  if (a.status !== b.status) return false
  if (a.background !== b.background) return false
  if (a.blocked !== b.blocked) return false
  if (a.sessionId !== b.sessionId) return false
  if (a.scope?.project !== b.scope?.project) return false
  if (a.scope?.worktree !== b.scope?.worktree) return false
  if (a.taskId !== b.taskId) return false
  if (a.initiative !== b.initiative) return false
  if (a.epic !== b.epic) return false
  if (a.task !== b.task) return false
  if (a.repo !== b.repo) return false
  if (a.worktree !== b.worktree) return false
  if (a.touchedFiles !== b.touchedFiles) return false
  if (a.recapEntries !== b.recapEntries) return false
  if (a.rawLogs !== b.rawLogs) return false
  if (a.port !== b.port) return false
  if (a.backend !== b.backend) return false
  if (a.backendInfo !== b.backendInfo) return false
  if (a.agentIcon !== b.agentIcon) return false
  if (a.natsEnabled !== b.natsEnabled) return false
  if (a.natsSubject !== b.natsSubject) return false
  if (a.natsSubscriptions !== b.natsSubscriptions) return false
  if (a.natsControlOrphanedAt !== b.natsControlOrphanedAt) return false
  if (a.parentId !== b.parentId) return false
  if (a.breakoutRooms !== b.breakoutRooms) return false
  if (!attentionShallowEqual(a.attention, b.attention)) return false
  // `slate` is a structured array of surfaces (objects) or absent. Compare it by
  // value — a shallow reference compare would never short-circuit (the Slate
  // watcher rebuilds a fresh projection on every read, so the ref always differs,
  // producing a permanent SSE/persist storm), and OMITTING the compare drops the
  // SSE delta SILENTLY so the run card never updates. Mirrors `noticeEqual`.
  if (JSON.stringify(a.slate ?? null) !== JSON.stringify(b.slate ?? null)) return false
  if (a.view !== b.view) return false
  // viewData is an opaque (usually object) blob; reference equality is intentional
  // — each PATCH deserializes a fresh object, so a viewData write is always a real
  // change. Don't "fix" this to deep-equal: that would defeat the change detection.
  if (a.viewData !== b.viewData) return false
  // Run-only fields
  if (a.worktreeId !== b.worktreeId) return false
  if (a.createdAt !== b.createdAt) return false
  if (a.spaceId !== b.spaceId) return false
  return true
}

function touchedFilesEqual(a: TouchedFile[], b: TouchedFile[]): boolean {
  if (a.length !== b.length) return false
  const sortBy = (arr: TouchedFile[]) => [...arr].sort((x, y) => x.path.localeCompare(y.path))
  const aa = sortBy(a)
  const bb = sortBy(b)
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i]!
    const y = bb[i]!
    if (x.path !== y.path) return false
    if (x.additions !== y.additions) return false
    if (x.deletions !== y.deletions) return false
    if ((x.readOnly ?? false) !== (y.readOnly ?? false)) return false
    if ((x.pending ?? false) !== (y.pending ?? false)) return false
  }
  return true
}

function recapSemanticKey(entry: RecapEntry): string {
  return JSON.stringify({
    type: entry.type,
    content: entry.content,
    timestamp: entry.timestamp ?? null,
    statusKind: entry.statusKind ?? null,
    durationMs: entry.durationMs ?? null,
    diff: entry.diff ?? null,
    toolUses: entry.toolUses ?? null,
  })
}

function hasLegacyRandomRecapId(entry: RecapEntry): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.id)
}

/**
 * Bound how many recap entries a run keeps in memory, on disk, and on the wire.
 *
 * The board SSE snapshot and every run delta ship the full `recapEntries` array,
 * and the PromptComposer remounts markdown for each entry on parent re-render.
 * An unbounded history makes typing and window switches feel sluggish long before
 * RAM is the problem. Keep the newest entries — older turns are still in the
 * agent transcript if someone needs them.
 */
export const MAX_RECAP_ENTRIES = 50

/** Keep the first occurrence of a recap event. Stable source IDs handle normal
 * replay; the semantic key repairs histories written by older parsers whose IDs
 * were random on every read. Exactness is intentional so repeated prompts from
 * distinct turns remain distinct whenever their timestamp or metadata differs.
 * After dedupe, retain only the newest {@link MAX_RECAP_ENTRIES}. */
function normalizeRecapEntries(entries: RecapEntry[]): RecapEntry[] {
  const ids = new Set<string>()
  const legacySemantics = new Set<string>()
  const normalized: RecapEntry[] = []
  for (const entry of entries) {
    const semanticKey = recapSemanticKey(entry)
    const legacyRandomId = hasLegacyRandomRecapId(entry)
    if (ids.has(entry.id) || (legacyRandomId && legacySemantics.has(semanticKey))) continue
    ids.add(entry.id)
    if (legacyRandomId) legacySemantics.add(semanticKey)
    normalized.push(entry)
  }
  return normalized.length > MAX_RECAP_ENTRIES
    ? normalized.slice(normalized.length - MAX_RECAP_ENTRIES)
    : normalized
}

function hasRecapEntry(entries: RecapEntry[], candidate: RecapEntry): boolean {
  if (entries.some(entry => entry.id === candidate.id)) return true
  if (!hasLegacyRandomRecapId(candidate)) return false
  const semanticKey = recapSemanticKey(candidate)
  return entries.some(entry => hasLegacyRandomRecapId(entry) && recapSemanticKey(entry) === semanticKey)
}

function noticeEqual(a: Notice, b: Notice): boolean {
  return (
    a.id === b.id &&
    a.runId === b.runId &&
    a.kind === b.kind &&
    a.headline === b.headline &&
    // `content` is a structured A2UI description (an object) or absent. A cheap
    // serialized compare keeps the equality short-circuit contract holding for
    // the new field: an identical re-post must not broadcast an SSE delta or
    // reschedule a persist (see the contract test in document-store.notices).
    JSON.stringify(a.content ?? null) === JSON.stringify(b.content ?? null) &&
    // `answer` is a structured object (choices/text/dissent/answeredAt) or absent.
    // Compare it by value so persisting the user's answer broadcasts an SSE delta
    // (the widget reflects "answered") while an identical re-upsert short-circuits.
    JSON.stringify(a.answer ?? null) === JSON.stringify(b.answer ?? null) &&
    // `dismissedAt` is the user's attention bit. Compare it (null-normalized, so
    // absent and undefined agree) or dismiss/undismiss writes short-circuit
    // SILENTLY — no SSE delta, and the board never dims the card.
    (a.dismissedAt ?? null) === (b.dismissedAt ?? null) &&
    // `followUps` is the append-only ask thread. Compare it by value or appending a
    // question (or the agent's reply) short-circuits SILENTLY — no SSE delta, and
    // the widget's ask panel never shows the new message. Neither `amendedAt` nor
    // any other field moves on a thread write, so this compare is the ONLY thing
    // that makes the write observable.
    JSON.stringify(a.followUps ?? null) === JSON.stringify(b.followUps ?? null) &&
    a.createdAt === b.createdAt &&
    a.amendedAt === b.amendedAt
  )
}

function tombstoneEqual(a: Tombstone, b: Tombstone): boolean {
  return (
    a.convId === b.convId &&
    a.provider === b.provider &&
    a.cliTemplate === b.cliTemplate &&
    a.sessionName === b.sessionName &&
    a.displayName === b.displayName &&
    a.coversSummary === b.coversSummary &&
    a.taskId === b.taskId &&
    a.task === b.task &&
    a.epic === b.epic &&
    a.initiative === b.initiative &&
    a.project === b.project &&
    a.workspacePath === b.workspacePath &&
    a.model === b.model &&
    a.created === b.created &&
    a.retiredAt === b.retiredAt &&
    (a.snapshotted ?? false) === (b.snapshotted ?? false) &&
    (a.background ?? false) === (b.background ?? false)
  )
}

export class DocumentStore {
  private initiatives = new Map<string, Initiative>()
  private epics = new Map<string, Epic>()
  private tasks = new Map<string, Task>()
  private worktrees = new Map<string, Worktree>()
  private runs = new Map<string, Run>()
  private spaces = new Map<string, Space>()
  private commits = new Map<string, CommitRecord>()
  private editorWidgets = new Map<string, EditorWidget>()
  private browserWidgets = new Map<string, BrowserWidget>()
  private artifacts = new Map<string, Artifact>()
  private imageWidgets = new Map<string, ImageWidget>()
  private topicMetadata = new Map<string, TopicMetadata>()
  private pluginWidgets = new Map<string, PluginWidgetInstance>()
  private constellationGraphs = new Map<string, ConstellationGraph>()
  private pinSets = new Map<string, PinSet>()
  /** Retired-session graveyard, keyed by convId. Global (not space-scoped) and
   *  intentionally excluded from clear()/clearSpace() — purge is the only removal. */
  private graveyard = new Map<string, Tombstone>()
  /** Roundup notices, keyed by notice id. Run-scoped: cleaned up in deleteRun's
   *  cascade so a notice never outlives the run that posted it (R20). */
  private notices = new Map<string, Notice>()

  activeSpaceId: string = ''

  readonly changes = new EventEmitter()

  /** The Slate point/thread store — store-backed points with merge-by-id projection
   *  (The Slate). Composed here so its mutators emit through this store's `changes`
   *  emitter (SSE + persist) and share the run-scoped prune cascade. */
  private slate = new SlateStore(evt => this.changes.emit('change', evt))

  /** The canonical Surface store (plan KTD1). Composed like `SlateStore` so the
   *  wiring lives in one place, but its changes ride a SEPARATE stream: a Surface
   *  batch is atomic and space-scoped, and flattening it into the per-entity
   *  `changes` shape would lose both properties. */
  private surfaces = new SurfaceStore(batch => this.onSurfaceBatch(batch))

  /** Ordered canonical Surface batches (KTD7), for SSE. One `batch` event per
   *  mutation — never one per record. */
  readonly surfaceChanges = new EventEmitter()

  /** The durable half. Null until {@link enableSurfacePersistence} — the SAME gate
   *  as `enablePersistence`, so a store with no core snapshot has no sidecar
   *  either and neither can outlive the other. */
  private surfaceSidecar: SurfaceSidecar | null = null

  /** Tail of the sidecar's fire-and-forget writes (the lifecycle cascade), so a
   *  caller — or a test — can await them. */
  private surfaceWriteTail: Promise<unknown> = Promise.resolve()

  private surfaceStatus: SurfaceHealthStatus = { health: 'healthy' }

  /** Idempotency receipts for the no-sidecar path. See {@link memoized}. */
  private surfaceMemoReceipts = new Map<string, SurfaceIdempotencyReceipt>()

  private persistPath: string | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  /** Enable file-backed persistence. Loads existing data and saves on changes. */
  enablePersistence(filePath: string): void {
    this.persistPath = filePath
    mkdirSync(dirname(filePath), { recursive: true })

    // Load existing snapshot from disk
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw)
      if (data.spaces) for (const s of data.spaces) this.spaces.set(s.id, s)
      if (data.activeSpaceId) this.activeSpaceId = data.activeSpaceId
      if (data.initiatives) for (const i of data.initiatives) this.initiatives.set(i.id, i)
      if (data.epics) for (const e of data.epics) this.epics.set(e.id, e)
      if (data.tasks) for (const t of data.tasks) this.tasks.set(t.id, t)
      if (data.worktrees) for (const w of data.worktrees) this.worktrees.set(w.id, w)
      if (data.runs) for (const r of data.runs) {
        // Skip zombie/corrupt entries: a run without id or sessionId can't be
        // rendered or deleted from the UI and indicates prior data corruption.
        if (!r || !r.id || !r.sessionId) {
          console.warn('[docstore] skipping corrupt run entry on load:', r)
          continue
        }
        r.recapEntries = normalizeRecapEntries(Array.isArray(r.recapEntries) ? r.recapEntries : [])
        this.runs.set(r.id, r)
      }
      if (data.commits) for (const c of data.commits) this.commits.set(c.sha, c)
      if (data.editorWidgets) for (const w of data.editorWidgets) this.editorWidgets.set(w.id, w)
      if (data.browserWidgets) for (const w of data.browserWidgets) this.browserWidgets.set(w.id, w)
      if (data.artifacts) for (const a of data.artifacts) this.artifacts.set(a.id, a)
      if (data.imageWidgets) for (const w of data.imageWidgets) this.imageWidgets.set(w.id, w)
      if (data.pluginWidgets) for (const w of data.pluginWidgets) this.pluginWidgets.set(w.id, w)
      if (data.constellationGraphs) for (const g of data.constellationGraphs) this.constellationGraphs.set(g.spaceId, migrateSnapEdges(g))
      // Pins have no legacy schema, so no migrate hook — load straight.
      if (data.pinSets) for (const set of data.pinSets) this.pinSets.set(set.spaceId, set)
      if (data.topicMetadata) for (const m of data.topicMetadata) this.topicMetadata.set(m.subject, m)
      if (data.graveyard) for (const t of data.graveyard) {
        // A tombstone without a convId can't be revived or purged — skip it.
        if (!t || !t.convId) {
          console.warn('[docstore] skipping corrupt tombstone entry on load:', t)
          continue
        }
        this.graveyard.set(t.convId, t)
      }
      if (data.notices) for (const n of data.notices) {
        // A notice without an id can't be amended, pulled, or rendered — skip it.
        if (!n || !n.id) {
          console.warn('[docstore] skipping corrupt notice entry on load:', n)
          continue
        }
        this.notices.set(n.id, n)
      }
      if (data.slatePoints) this.slate.loadPoints(data.slatePoints)
    } catch {
      // No file or corrupt — start fresh
    }

    // Debounced save on every change — EXCEPT a persist-exempt one. See
    // {@link DocumentChange.persistExempt}: the derived `Run.slate` projection of
    // a canonical Surface mutation is durable in the Surface sidecar, so writing
    // `docstore.json` for it would put the same state in two files that can then
    // disagree.
    this.changes.on('change', (change: DocumentChange) => {
      if (change?.persistExempt) return
      this.schedulePersist()
    })

    // One-time, idempotent: migrate legacy browser widget.notes → per-space pins.
    // Runs after all entities (browserWidgets AND pinSets) are hydrated AND after
    // the change→persist listener is attached, so each seed's change event actually
    // schedules a disk persist — otherwise the "one-time" migration re-runs every
    // boot until an unrelated mutation flushes. Only seeds spaces with NO PinSet.
    try {
      migrateAllBrowserNotes(this)
    } catch (err) {
      console.warn('[docstore] browser-notes → pins migration failed:', err)
    }
  }

  private schedulePersist(): void {
    if (!this.persistPath) return
    if (this.persistTimer) return // already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, 500)
  }

  private persistNow(): void {
    if (!this.persistPath) return
    try {
      writeFileSync(this.persistPath, JSON.stringify(this.snapshotAll(), null, 2))
    } catch {
      // Best-effort — don't crash the server
    }
  }

  /** Flush any pending writes immediately */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistNow()
  }

  // --- Spaces ---

  upsertSpace(id: string, data: Space): void {
    this.spaces.set(id, data)
    this.changes.emit('change', { entity: 'space', id, data })
  }

  getSpace(id: string): Space | undefined {
    return this.spaces.get(id)
  }

  getAllSpaces(): Space[] {
    return [...this.spaces.values()]
  }

  deleteSpace(id: string): void {
    this.spaces.delete(id)
    this.changes.emit('change', { entity: 'space', id, data: null })
  }

  // --- Initiatives ---

  upsertInitiative(id: string, data: Initiative): void {
    this.initiatives.set(id, data)
    this.changes.emit('change', { entity: 'initiative', id, data })
  }

  getInitiative(id: string): Initiative | undefined {
    return this.initiatives.get(id)
  }

  getAllInitiatives(): Initiative[] {
    return [...this.initiatives.values()]
  }

  deleteInitiative(id: string): void {
    this.initiatives.delete(id)
    this.changes.emit('change', { entity: 'initiative', id, data: null })
  }

  // --- Epics ---

  upsertEpic(id: string, data: Epic): void {
    this.epics.set(id, data)
    this.changes.emit('change', { entity: 'epic', id, data })
  }

  getEpic(id: string): Epic | undefined {
    return this.epics.get(id)
  }

  getAllEpics(): Epic[] {
    return [...this.epics.values()]
  }

  deleteEpic(id: string): void {
    this.epics.delete(id)
    this.changes.emit('change', { entity: 'epic', id, data: null })
  }

  // --- Tasks ---

  upsertTask(id: string, data: Task): void {
    this.tasks.set(id, data)
    this.changes.emit('change', { entity: 'task', id, data })
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  getAllTasks(): Task[] {
    return [...this.tasks.values()]
  }

  deleteTask(id: string): void {
    this.tasks.delete(id)
    this.changes.emit('change', { entity: 'task', id, data: null })
  }

  // --- Worktrees ---

  upsertWorktree(id: string, data: Worktree): void {
    this.worktrees.set(id, data)
    this.changes.emit('change', { entity: 'worktree', id, data })
  }

  getWorktree(id: string): Worktree | undefined {
    return this.worktrees.get(id)
  }

  getAllWorktrees(): Worktree[] {
    return [...this.worktrees.values()]
  }

  deleteWorktree(id: string): void {
    this.worktrees.delete(id)
    this.changes.emit('change', { entity: 'worktree', id, data: null })
  }

  // --- Runs ---

  upsertRun(id: string, data: Run): void {
    // Cap/dedupe here so every write path (load, PATCH, watchers) keeps the
    // same bound — not only addRecapEntry. Without this, a fat PATCH or an
    // older docstore reload could reintroduce unbounded history onto the wire.
    const next: Run = {
      ...data,
      recapEntries: normalizeRecapEntries(data.recapEntries),
    }
    const prev = this.runs.get(id)
    if (prev && runShallowEqual(prev, next)) return
    this.runs.set(id, next)
    this.changes.emit('change', { entity: 'run', id, data: next })
  }

  getRun(id: string): Run | undefined {
    return this.runs.get(id)
  }

  getAllRuns(): Run[] {
    return [...this.runs.values()]
  }

  deleteRun(id: string): void {
    // Try direct key match first, then fall back to sessionId lookup
    if (this.runs.has(id)) {
      this.runs.delete(id)
      this.changes.emit('change', { entity: 'run', id, data: null })
      // Node-id convention: a run's canvas node is `run-${id}` (see grouping.ts
      // and WorkspaceShell synthetic nodes); pins key off that prefixed id.
      this.pruneWidgetFromGraphs(`run-${id}`)
      this.removePinsForNodeAcrossSpaces(`run-${id}`)
      // Cascade: a notice must not outlive the run that posted it (R20).
      this.dropNoticesForRun(id)
      // Cascade: the run's Slate points/threads must not outlive it either.
      this.slate.pruneRun(id)
      return
    }
    // Simulator runs are keyed by run id (R-xxx) but deleted by session name (CLD-xxx)
    for (const [key, run] of this.runs) {
      if (run.sessionId === id) {
        this.runs.delete(key)
        this.changes.emit('change', { entity: 'run', id: key, data: null })
        this.pruneWidgetFromGraphs(`run-${key}`)
        this.removePinsForNodeAcrossSpaces(`run-${key}`)
        this.dropNoticesForRun(key)
        this.slate.pruneRun(key)
        return
      }
    }
  }

  /** Drop every notice posted by a run (keyed on Notice.runId === run.id). Emits
   *  a `change: null` per notice so the Roundup drops the row live. */
  private dropNoticesForRun(runId: string): void {
    for (const [nid, n] of this.notices) {
      if (n.runId === runId) this.deleteNotice(nid)
    }
  }

  // --- Run mutations (partial updates that emit changes) ---

  addRecapEntry(runId: string, entry: RecapEntry): void {
    const run = this.runs.get(runId)
    if (!run) return
    if (hasRecapEntry(run.recapEntries, entry)) return
    run.recapEntries.push(entry)
    if (run.recapEntries.length > MAX_RECAP_ENTRIES) {
      run.recapEntries = run.recapEntries.slice(run.recapEntries.length - MAX_RECAP_ENTRIES)
    }
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

  addFileTouched(runId: string, file: TouchedFile): void {
    const run = this.runs.get(runId)
    if (!run) return
    // Deduplicate by path
    if (run.touchedFiles.some(f => f.path === file.path)) return
    // Mark as readOnly if it has no changes (hook-reported read, not yet in git diff)
    if (file.additions === 0 && file.deletions === 0 && !file.pending) {
      file.readOnly = true
    }
    run.touchedFiles.push(file)
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

  reconcileFiles(runId: string, gitFiles: TouchedFile[]): void {
    const run = this.runs.get(runId)
    if (!run) return

    const gitPaths = new Set(gitFiles.map(f => f.path))

    // Detect commit: if modified files from previous list disappeared from git diff,
    // a commit happened — clear read-only files too
    const prevModified = run.touchedFiles.filter(f => !f.readOnly && (f.additions > 0 || f.deletions > 0))
    const committedAway = prevModified.some(f => !gitPaths.has(f.path))

    // Preserve read-only (hook-reported) files that aren't in git diff,
    // unless a commit just cleared modified files
    const readOnlyCarry = committedAway
      ? []
      : run.touchedFiles.filter(f => f.readOnly && !gitPaths.has(f.path))

    const next = [...gitFiles, ...readOnlyCarry]
    if (touchedFilesEqual(run.touchedFiles, next)) return

    run.touchedFiles = next
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

  /**
   * Mutates the stored run in place — callers holding a Run reference will
   * see `.status` change under them. The mutation is intentional (the same
   * object reference flows out via SSE deltas) but easy to miss from the
   * signature.
   */
  updateRunStatus(runId: string, status: RunStatus, blocked?: boolean): void {
    const run = this.runs.get(runId)
    if (!run) return
    // A stopped session cannot be waiting on a permission prompt — force
    // blocked off so the flag can't dangle on a dead run. When the caller
    // omits `blocked` (simulator/document-processor, legacy call sites), the
    // run's current value is kept.
    const nextBlocked = status === 'stopped' ? false : (blocked ?? run.blocked)
    if (run.status === status && run.blocked === nextBlocked) return
    run.status = status
    run.blocked = nextBlocked
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
    // Re-derive attention from (status, blocked, background). Skip the
    // setRunAttention call when both prior attention and mapped attention are
    // absent — otherwise setRunAttention would emit a redundant change event
    // (its dedupe guard only fires when both sides are non-null).
    const mapped = deriveRunAttention(status, nextBlocked, run.background)
    if (mapped !== null || run.attention !== undefined) {
      this.setRunAttention(runId, mapped)
    }
  }

  /** Re-derive a run's attention from its current `(status, blocked,
   *  background)` triple without changing any of them. For callers that
   *  mutate a derivation input outside updateRunStatus — e.g. the PATCH
   *  `background` flip (U4). */
  rederiveRunAttention(runId: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    const mapped = deriveRunAttention(run.status, run.blocked, run.background)
    if (mapped !== null || run.attention !== undefined) {
      this.setRunAttention(runId, mapped)
    }
  }


  // --- Commits ---

  upsertCommit(data: CommitRecord): boolean {
    if (this.commits.has(data.sha)) return false
    this.commits.set(data.sha, data)
    this.changes.emit('change', { entity: 'commit', id: data.sha, data })
    return true
  }

  getCommit(sha: string): CommitRecord | undefined {
    return this.commits.get(sha)
  }

  getAllCommits(): CommitRecord[] {
    return [...this.commits.values()]
  }

  assignTaskTag(sha: string, taskTag: string): CommitRecord | null {
    const commit = this.commits.get(sha)
    if (!commit) return null
    if (!commit.taskTags.includes(taskTag)) commit.taskTags = [...commit.taskTags, taskTag]
    this.changes.emit('change', { entity: 'commit', id: sha, data: commit })
    return commit
  }

  // --- EditorWidgets ---

  upsertEditorWidget(id: string, data: EditorWidget): void {
    this.editorWidgets.set(id, data)
    this.changes.emit('change', { entity: 'editorWidget', id, data })
  }

  deleteEditorWidget(id: string): void {
    this.editorWidgets.delete(id)
    this.changes.emit('change', { entity: 'editorWidget', id, data: null })
    // Widget ids are already type-prefixed (shortId('editor') → `editor-...`) and
    // the canvas node id is that same id (WorkspaceShell synthetic nodes use id: w.id),
    // so the bare id is the pin nodeId — no extra prefix.
    this.pruneWidgetFromGraphs(id)
    this.removePinsForNodeAcrossSpaces(id)
  }

  getAllEditorWidgets(): EditorWidget[] {
    return [...this.editorWidgets.values()]
  }

  // --- BrowserWidgets ---

  upsertBrowserWidget(id: string, data: BrowserWidget): void {
    this.browserWidgets.set(id, data)
    this.changes.emit('change', { entity: 'browserWidget', id, data })
  }

  deleteBrowserWidget(id: string): void {
    this.browserWidgets.delete(id)
    this.changes.emit('change', { entity: 'browserWidget', id, data: null })
    this.pruneWidgetFromGraphs(id)
    this.removePinsForNodeAcrossSpaces(id)
    // Cascade: an ephemeral artifact's lifecycle is tied to its browser widget.
    for (const [aid, a] of this.artifacts) {
      if (a.widgetId === id) this.deleteArtifact(aid)
    }
  }

  getAllBrowserWidgets(): BrowserWidget[] {
    return [...this.browserWidgets.values()]
  }

  // --- Artifacts (ephemeral HTML) ---

  upsertArtifact(id: string, data: Artifact): void {
    this.artifacts.set(id, data)
    // Metadata-only delta: artifacts can be multi-MB and the frontend has no
    // artifact reducer, so broadcasting the html over SSE on every update is
    // pure waste. Persistence reads the full record from snapshotAll(), not here.
    this.changes.emit('change', {
      entity: 'artifact',
      id,
      data: { id, spaceId: data.spaceId, widgetId: data.widgetId, rev: data.rev },
    })
  }

  getArtifact(id: string): Artifact | undefined {
    return this.artifacts.get(id)
  }

  getAllArtifacts(): Artifact[] {
    return [...this.artifacts.values()]
  }

  deleteArtifact(id: string): void {
    if (!this.artifacts.delete(id)) return
    this.changes.emit('change', { entity: 'artifact', id, data: null })
  }

  deleteAllArtifacts(): number {
    const count = this.artifacts.size
    this.artifacts.clear()
    if (count > 0) this.changes.emit('change', { entity: 'artifact', id: '*', data: null })
    return count
  }

  // --- PluginWidgets ---

  upsertPluginWidget(id: string, data: PluginWidgetInstance): void {
    this.pluginWidgets.set(id, data)
    this.changes.emit('change', { entity: 'pluginWidget', id, data })
  }

  setPluginWidgetAttention(id: string, state: AttentionState | null): void {
    const existing = this.pluginWidgets.get(id)
    if (!existing) return
    if (state && existing.attention
        && existing.attention.level === state.level
        && existing.attention.reason === state.reason) {
      return
    }
    const next = state === null
      ? { ...existing, attention: undefined }
      : { ...existing, attention: state, updatedAt: state.setAt }
    this.pluginWidgets.set(id, next)
    this.changes.emit('change', { entity: 'pluginWidget', id, data: next })
  }

  setRunAttention(runId: string, state: AttentionState | null): void {
    const existing = this.runs.get(runId)
    if (!existing) return
    if (state && existing.attention
        && existing.attention.level === state.level
        && existing.attention.reason === state.reason) {
      return
    }
    const next: typeof existing = state === null
      ? { ...existing, attention: undefined }
      : { ...existing, attention: state }
    this.runs.set(runId, next)
    this.changes.emit('change', { entity: 'run', id: runId, data: next })
  }

  /** Project a run's Slate surfaces (see The Slate). Called by the Slate watcher
   *  after it reads and validates `.tinstar/slate/*`. By-value short-circuit so a
   *  re-projection of unchanged content emits ZERO change events — the file-watch
   *  storm guard (a watcher re-projecting on every fs event must not hammer the
   *  docstore/SSE). Pass an empty array or undefined to clear the Slate. */
  setRunSlate(runId: string, surfaces: SlateSurface[] | undefined): void {
    const existing = this.runs.get(runId)
    if (!existing) return
    const nextSlate = surfaces && surfaces.length > 0 ? surfaces : undefined
    if (JSON.stringify(existing.slate ?? null) === JSON.stringify(nextSlate ?? null)) return
    const next: typeof existing = { ...existing, slate: nextSlate }
    this.runs.set(runId, next)
    this.changes.emit('change', { entity: 'run', id: runId, data: next })
  }

  deletePluginWidget(id: string): void {
    this.pluginWidgets.delete(id)
    this.changes.emit('change', { entity: 'pluginWidget', id, data: null })
    this.pruneWidgetFromGraphs(id)
    this.removePinsForNodeAcrossSpaces(id)
  }

  getAllPluginWidgets(): PluginWidgetInstance[] {
    return [...this.pluginWidgets.values()]
  }

  // --- ConstellationGraph (per-space membership graph) ---

  private pruneWidgetFromGraphs(widgetId: string): void {
    for (const [spaceId, g] of this.constellationGraphs) {
      const snapped = g.snapped.filter(e => e.nodes[0] !== widgetId && e.nodes[1] !== widgetId)
      let members = g.members.filter(m => m.widget !== widgetId)
      // Free any slot left with a single member (no 1-member constellations).
      const countBySlot = new Map<string, number>()
      for (const m of members) countBySlot.set(m.slot, (countBySlot.get(m.slot) ?? 0) + 1)
      members = members.filter(m => (countBySlot.get(m.slot) ?? 0) >= 2)
      if (snapped.length !== g.snapped.length || members.length !== g.members.length) {
        // Server-internal mutation: bump the revision so it isn't rejected as
        // stale and so clients see it supersede any in-flight optimistic overlay.
        this.upsertConstellationGraph(spaceId, { ...g, snapped, members, rev: (g.rev ?? 0) + 1 })
      }
    }
  }

  /** Returns whether the write was applied. A stale/equal revision is rejected
   *  (returns false) so callers can surface a conflict instead of a false success. */
  upsertConstellationGraph(spaceId: string, data: ConstellationGraph): boolean {
    // Revision gate (docstore mutator contract): reject writes whose revision is
    // not newer than the stored one. An older write arriving after a newer one
    // (e.g. an undo PUT racing the edit it reverts, reordered by the network) is
    // a stale intent — dropping it keeps the latest intent authoritative
    // regardless of arrival order, and also short-circuits redundant re-PUTs.
    const existing = this.constellationGraphs.get(spaceId)
    if (existing && (data.rev ?? 0) <= (existing.rev ?? 0)) return false
    this.constellationGraphs.set(spaceId, data)
    this.changes.emit('change', { entity: 'constellationGraph', id: spaceId, data })
    return true
  }

  getConstellationGraph(spaceId: string): ConstellationGraph | undefined {
    return this.constellationGraphs.get(spaceId)
  }

  getAllConstellationGraphs(): ConstellationGraph[] {
    return [...this.constellationGraphs.values()]
  }

  // --- Pins ---

  /** Returns whether the write was applied. A stale/equal revision is rejected
   *  (returns false), mirroring the constellation graph contract. */
  upsertPinSet(spaceId: string, data: PinSet): boolean {
    const existing = this.pinSets.get(spaceId)
    if (existing && (data.rev ?? 0) <= (existing.rev ?? 0)) return false
    this.pinSets.set(spaceId, data)
    this.changes.emit('change', { entity: 'pinSet', id: spaceId, data })
    return true
  }

  getPinSet(spaceId: string): PinSet | undefined {
    return this.pinSets.get(spaceId)
  }

  getAllPinSets(): PinSet[] {
    return [...this.pinSets.values()]
  }

  /** GC: drop a deleted node's pins from every space. Bumps rev so the write is
   *  not rejected by the gate and so clients supersede any optimistic overlay. */
  removePinsForNodeAcrossSpaces(nodeId: string): void {
    for (const [spaceId, set] of this.pinSets) {
      const next = removePinsForNode(set, nodeId)
      if (next.pins.length !== set.pins.length) {
        this.upsertPinSet(spaceId, { ...next, rev: (set.rev ?? 0) + 1 })
      }
    }
  }

  // --- Image Widgets ---

  upsertImageWidget(id: string, data: ImageWidget): void {
    this.imageWidgets.set(id, data)
    this.changes.emit('change', { entity: 'imageWidget', id, data })
  }

  deleteImageWidget(id: string): void {
    this.imageWidgets.delete(id)
    this.changes.emit('change', { entity: 'imageWidget', id, data: null })
    this.pruneWidgetFromGraphs(id)
    this.removePinsForNodeAcrossSpaces(id)
  }

  getAllImageWidgets(): ImageWidget[] {
    return [...this.imageWidgets.values()]
  }

  // --- TopicMetadata ---

  upsertTopicMetadata(subject: string, data: TopicMetadata): void {
    this.topicMetadata.set(subject, data)
    this.changes.emit('change', { entity: 'topicMetadata', id: subject, data })
  }

  deleteTopicMetadata(subject: string): void {
    this.topicMetadata.delete(subject)
    this.changes.emit('change', { entity: 'topicMetadata', id: subject, data: null })
  }

  getTopicMetadata(subject: string): TopicMetadata | undefined {
    return this.topicMetadata.get(subject)
  }

  getAllTopicMetadata(): TopicMetadata[] {
    return [...this.topicMetadata.values()]
  }

  // --- Graveyard (retired sessions) ---

  upsertTombstone(data: Tombstone): void {
    // A convId-less tombstone can't be revived or purged by key and is dropped
    // on the next reload — reject it here so it never enters the store (symmetric
    // with the load-path skip).
    if (!data.convId) return
    const prev = this.graveyard.get(data.convId)
    if (prev && tombstoneEqual(prev, data)) return
    this.graveyard.set(data.convId, data)
    this.changes.emit('change', { entity: 'tombstone', id: data.convId, data })
  }

  getTombstone(convId: string): Tombstone | undefined {
    return this.graveyard.get(convId)
  }

  getAllTombstones(): Tombstone[] {
    return [...this.graveyard.values()]
  }

  deleteTombstone(convId: string): boolean {
    if (!this.graveyard.has(convId)) return false
    this.graveyard.delete(convId)
    this.changes.emit('change', { entity: 'tombstone', id: convId, data: null })
    return true
  }

  // --- Notices (Roundup) ---

  upsertNotice(data: Notice): void {
    const prev = this.notices.get(data.id)
    // Equality short-circuit (docstore mutator contract): a re-post with no
    // real change must not broadcast an SSE delta or reschedule a persist.
    if (prev && noticeEqual(prev, data)) return
    this.notices.set(data.id, data)
    this.changes.emit('change', { entity: 'notice', id: data.id, data })
  }

  getNotice(id: string): Notice | undefined {
    return this.notices.get(id)
  }

  getAllNotices(): Notice[] {
    return [...this.notices.values()]
  }

  deleteNotice(id: string): boolean {
    if (!this.notices.has(id)) return false
    this.notices.delete(id)
    this.changes.emit('change', { entity: 'notice', id, data: null })
    return true
  }

  // --- Slate points (The Slate) ---
  //
  // The legacy `SlateStore` is composed here but is NO LONGER A WRITE PATH. U2 moved
  // authoring to canonical Surfaces: the watcher reconciles files into them and the
  // run-scoped routes mutate them through `RunSlateBridge`. What survives here is
  // load, snapshot, and the lifecycle cascade — the legacy points remain in
  // `docstore.json` as migration evidence (KTD5) and the boot migration adopts any
  // that have no canonical counterpart yet.
  //
  // The write mutators that used to live here (`applyRunSlateProjection`,
  // `addUserSlatePoint`, `addSlateReply`, resolve/reopen/dismiss, `reorderSlatePoints`,
  // `clearSlateForRun`, `markStalledSlatePoints`) are GONE rather than deprecated.
  // Keeping them would have left methods that write a store nothing renders — a
  // caller would get a success, see no change anywhere, and have nothing to find.

  /**
   * THE `Run.slate` DERIVATION — the single place the Run Workspace projection is
   * computed, whatever triggered it.
   *
   * ITS INPUT IS CANONICAL SURFACES, addressed through the run's compatibility
   * aliases (KTD3). That swap is what U2 is for: until it, the legacy `SlateStore`
   * was still the write path, so deriving from canonical records would have
   * rendered whatever the last boot's migration captured rather than what an agent
   * had just written. Now the file reconciler and the run-scoped routes both write
   * canonical records, and the legacy store is evidence rather than a source.
   *
   * Deleted Surfaces are excluded by `getSurfacesForRunAlias`, so a Surface in the
   * recovery store keeps the alias that lets a restore put it back without
   * appearing in the Slate meanwhile.
   */
  private deriveRunSlate(runId: string): SlateSurface[] {
    const out: SlateSurface[] = []
    for (const s of this.surfaces.getSurfacesForRunAlias(runId)) {
      const alias = runAliasOf(s, runId)
      if (!inRunSlate(s, alias)) continue
      out.push(slateSurfaceFromCanonical(s, alias.localId))
    }
    return out
  }

  /** The canonical Surface a run's legacy point id addresses (KTD3). The lookup
   *  every run-scoped route delegates through. */
  surfaceForRunAlias(runId: string, localId: string): Surface | undefined {
    for (const s of this.surfaces.getSurfacesForRunAlias(runId)) {
      const alias = runAliasOf(s, runId)
      if (alias?.localId === localId) return s
    }
    return undefined
  }

  getSlatePoint(runId: string, id: string): Point | undefined {
    const surface = this.surfaceForRunAlias(runId, id)
    if (!surface) return undefined
    const alias = runAliasOf(surface, runId)
    // Addressable but not PRESENTED: a hidden alias or the compatibility root is
    // still reachable by id (a route that already knows the id may still read it)
    // while staying out of the rendered list.
    return alias ? pointFromCanonical(surface, runId, alias.localId) : undefined
  }

  getSlatePointsForRun(runId: string): Point[] {
    const out: Point[] = []
    for (const s of this.surfaces.getSurfacesForRunAlias(runId)) {
      const alias = runAliasOf(s, runId)
      if (!inRunSlate(s, alias)) continue
      out.push(pointFromCanonical(s, runId, alias.localId))
    }
    return out
  }

  /** Hydrate legacy Slate points. The persistence load path's own call, exposed so
   *  evidence can be seeded without a snapshot file. NOT a mutator: it emits nothing
   *  and reaches no projection, exactly like `loadSurfaces`. */
  loadSlatePoints(points: Point[]): void {
    this.slate.loadPoints(points)
  }

  /** The LEGACY point set, straight off the legacy store. Migration evidence and
   *  the `docstore.json` snapshot only — deliberately NOT the projection above,
   *  which is what the Run Workspace renders. */
  getAllSlatePoints(): Point[] {
    return this.slate.getAllPoints()
  }

  // --- Canonical Surfaces (U1) ---
  //
  // The Surface store is composed here for the same reason `SlateStore` is: one
  // place wires a plain data structure to SSE and to the lifecycle cascade. What
  // is deliberately DIFFERENT is durability. Surfaces persist to their own
  // sidecar, never to `docstore.json`, so a Surface commit and a core document
  // write can never replace each other's snapshots.

  /**
   * Attach the durable Surface sidecar. Called on the SAME gate as
   * {@link enablePersistence} — a backend with no `docstore.json` has no sidecar
   * either. Without it the Surface store still works in memory (which is what
   * every unit test and the `TINSTAR_NO_SESSIONS` path want) but nothing survives
   * a restart.
   *
   * A FAULTED sidecar must not be passed here. `faulted-read-only` means both
   * snapshots are unreadable and are being preserved as evidence; the boot path
   * leaves persistence off and sets a degraded status instead.
   */
  enableSurfacePersistence(sidecar: SurfaceSidecar): void {
    this.surfaceSidecar = sidecar
  }

  /** Hydrate canonical records from a snapshot. Emits nothing — hydration is not
   *  a mutation and there is no client yet to tell. */
  loadSurfaces(records: Surface[], topologyRevs?: Record<string, number>): void {
    this.surfaces.load(records, topologyRevs)
    // `Run.slate` is DERIVED from these records, so hydrating them without
    // recomputing it leaves the stored projection describing the previous state —
    // and at boot that means empty. The SSE snapshot serves the stored field, so a
    // client connecting before the first mutation would be told the run has no Slate
    // at all. Scoped to the runs these records actually alias, so a hydrate of one
    // space does not walk every run in the install.
    const runIds = new Set<string>()
    for (const record of records) {
      for (const alias of record.aliases ?? []) {
        if (alias.bucket.kind === 'run') runIds.add(alias.bucket.runId)
      }
    }
    for (const runId of runIds) this.emitDerivedRunSlate(runId)
  }

  getSurface(id: string): Surface | undefined {
    return this.surfaces.getSurface(id)
  }

  getAllSurfaces(): Surface[] {
    return this.surfaces.getAllSurfaces()
  }

  getSurfacesForSpace(spaceId: string): Surface[] {
    return this.surfaces.getSurfacesForSpace(spaceId)
  }

  getSurfaceTopologyRev(spaceId: string): number {
    return this.surfaces.getTopologyRev(spaceId)
  }

  // Tree reads, delegated so the mutation service never needs a handle on the
  // store itself. That is the point of routing them through here: a caller
  // holding `SurfaceStore` directly could invoke a topology mutator, which
  // installs and emits in one step, and skip the durable commit entirely.

  getSurfaceChildren(id: string): Surface[] {
    return this.surfaces.getChildren(id)
  }

  getSurfaceDescendants(id: string): Surface[] {
    return this.surfaces.getDescendants(id)
  }

  getSurfaceAncestors(id: string): Surface[] {
    return this.surfaces.getAncestors(id)
  }

  getSurfaceRoots(spaceId: string): Surface[] {
    return this.surfaces.getRoots(spaceId)
  }

  /** Every live Surface carrying a compatibility alias for `runId` (plan KTD3) —
   *  the lookup `Run.slate` and the U2 source reconciler both address through. */
  getSurfacesForRunAlias(runId: string): Surface[] {
    return this.surfaces.getSurfacesForRunAlias(runId)
  }

  /** The roots of every deleted subtree in the space (plan KTD15). */
  getSurfaceRecoveryRoots(spaceId: string): Surface[] {
    return this.surfaces.getRecoveryRoots(spaceId)
  }

  /** The recovery-store root governing a Surface, when it is deleted. */
  surfaceRecoveryRootFor(id: string): Surface | undefined {
    return this.surfaces.recoveryRootFor(id)
  }

  /** Would a content candidate be installed, and if not, why? The mutation service
   *  asks BEFORE committing so a candidate the store would refuse never becomes
   *  durable — see {@link installDurableContent} for what that used to cost. */
  checkSurfaceUpsert(next: Surface): SurfaceRejection | undefined {
    return this.surfaces.checkUpsert(next)
  }

  // --- Planned topology mutation (plan KTD7) ---
  //
  // Planning and applying are separate calls, and the mutation service puts a
  // durable commit between them. Exposing a fused `group()` here would make the
  // KTD7 ordering unenforceable: by the time a failed write returned, the batch
  // would already be on the wire.

  planSurfaceCreate(init: SurfaceInit, opts?: SurfaceTopologyOpts): SurfacePlanResult {
    return this.surfaces.planCreate(init, opts)
  }

  planSurfaceReparent(ids: string[], home: SurfaceHome, opts?: SurfaceTopologyOpts): SurfacePlanResult {
    return this.surfaces.planReparent(ids, home, opts)
  }

  planSurfaceGroup(
    childIds: string[],
    parent: Omit<SurfaceInit, 'spaceId' | 'home' | 'id'> & { id?: string },
    opts?: SurfaceTopologyOpts,
  ): SurfacePlanResult {
    return this.surfaces.planGroup(childIds, parent, opts)
  }

  planSurfaceDelete(id: string, opts?: SurfaceDeleteOpts): SurfacePlanResult {
    return this.surfaces.planDelete(id, opts)
  }

  planSurfaceRestore(id: string, opts?: SurfaceTopologyOpts): SurfacePlanResult {
    return this.surfaces.planRestore(id, opts)
  }

  planSurfacePurge(id: string, opts?: SurfaceDeleteOpts): SurfacePlanResult {
    return this.surfaces.planPurge(id, opts)
  }

  /**
   * Make a planned topology change durable, then install it and emit its one
   * batch — the KTD7 order, enforced by the sidecar's `onDurable` rather than by
   * this method remembering to do things in sequence.
   *
   * With no sidecar attached the plan is applied in memory only, the same honest
   * degradation {@link commitSurfaceContent} makes: a store that was never given a
   * durable home cannot pretend to have one, and `TINSTAR_NO_SESSIONS` and the
   * unit suites depend on working without a filesystem.
   *
   * THE PLAN IS RE-VALIDATED IMMEDIATELY BEFORE IT IS WRITTEN, from inside the
   * sidecar's transaction queue, and the plan that gets installed is the one that
   * re-validation recomputed — see {@link SurfaceTopologyPlan.revalidate} for why
   * the re-check is exhaustive by construction and where the topology revision is
   * allocated.
   *
   * THE RESIDUAL WINDOW, STATED HONESTLY. This does not close the gap to zero; it
   * shrinks it from "the whole durable write, queued behind every other one" —
   * U1's measurement puts that at p95 259ms at ~10 MiB, multiplied by the queue
   * depth — down to the interval between the re-validation returning and
   * `onDurable` installing. Inside that interval no OTHER Surface transaction can
   * touch live state: they are all serialized behind this same queue, and both the
   * re-check and the install run inside it. What remains is the handful of
   * `await`s in the sidecar's atomic write (four hook points, no-ops in
   * production, each yielding one microtask turn) during which a NON-transactional
   * writer could still move live state — the lifecycle cascade
   * (`clearSpace`/`clear`) and the single-writer boot and migration paths, which
   * do not go through a plan at all. That is microseconds of exposure to three
   * callers, not milliseconds of exposure to every concurrent user and agent. It
   * is not closed, and closing it would mean either moving planning into the queue
   * (rejected: it serializes every mutation in a space behind a file write) or
   * putting the cascade behind the same queue (a larger change than U3, and the
   * cascade runs when the owning run or space no longer exists at all). The
   * author's decision is to shrink and document rather than to claim closure.
   */
  async commitSurfacePlan(
    plan: SurfaceTopologyPlan,
    opts: {
      idempotencyKey?: string
      /** See {@link SurfaceTransaction.fingerprint} — what this key is a retry of. */
      fingerprint?: string
      result?: (effective: SurfaceTopologyPlan) => JsonValue
    } = {},
  ): Promise<SurfaceCommitResult> {
    const sidecar = this.surfaceSidecar
    // What re-validation recomputed, and therefore what gets installed. The
    // original plan is only ever a proposal from here on — which is why the
    // caller's receipt is a FUNCTION of the plan rather than a value: a response
    // that named the revision the caller proposed instead of the one the commit
    // allocated would hand back a token the space is not at.
    let effective = plan
    const precommit = () => {
      const fresh = plan.revalidate()
      if (!fresh.applied) return { ok: false as const, reason: fresh.reason }
      effective = fresh.plan
      return {
        ok: true as const,
        puts: fresh.plan.records,
        topologyRevs: { [fresh.plan.spaceId]: fresh.plan.topologyRev },
        ...(opts.result ? { result: opts.result(fresh.plan) } : {}),
      }
    }
    if (!sidecar) {
      const rechecked = precommit()
      if (!rechecked.ok) {
        return { committed: false, reason: 'precommit-refused', detail: rechecked.reason }
      }
      return this.memoized(
        opts.idempotencyKey,
        opts.fingerprint,
        effective.records.map(r => r.id),
        rechecked.result,
        () => this.surfaces.applyPlan(effective),
      )
    }
    // Drops are filtered to what the sidecar actually holds, for the same reason
    // the cascade filters them: one `drop` naming an unpersisted record rejects
    // the WHOLE transaction, which would leave every other purged record durable
    // and resurrect the lot on the next boot.
    const durable = new Set(sidecar.durableRecords().map(r => r.id))
    const drops = plan.purged.filter(id => durable.has(id))
    return sidecar.commit({
      ...(plan.records.length > 0 ? { puts: plan.records } : {}),
      ...(drops.length > 0 ? { drops } : {}),
      expectedRevs: plan.expectedRevs,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
      precommit,
      onDurable: () => { this.surfaces.applyPlan(effective) },
    })
  }

  /** The canonical store's health, as the client sees it on every snapshot. */
  get surfaceHealth(): SurfaceHealthStatus {
    return this.surfaceStatus
  }

  /**
   * Record the boot load outcome. Only `faulted-read-only` changes what anything
   * renders (see {@link SurfaceHealthStatus}); `recovered` is reported for
   * completeness so an operator can tell a repaired boot from a clean one.
   */
  setSurfaceHealth(status: SurfaceHealthStatus): void {
    this.surfaceStatus = status
  }

  /**
   * One durable canonical Surface content mutation, in the KTD7 order: build and
   * validate a candidate, make it durable, install it in memory, emit exactly one
   * batch, and only then acknowledge the caller.
   *
   * The ordering is enforced by the sidecar rather than described here — the
   * in-memory install rides `onDurable`, which the sidecar calls strictly after
   * the bytes are fsynced, so a write failure returns with live state and every
   * connected client untouched.
   *
   * With no sidecar attached (persistence disabled) the write is applied in
   * memory only. That is the honest degradation for a store that was never given
   * a durable home, and it keeps `TINSTAR_NO_SESSIONS` and the unit suites from
   * needing a filesystem.
   */
  async commitSurfaceContent(
    next: Surface,
    opts: { idempotencyKey?: string; fingerprint?: string; result?: JsonValue } = {},
  ): Promise<SurfaceCommitResult> {
    const prior = this.surfaces.getSurface(next.id)
    if (!prior) return { committed: false, reason: 'unknown-record', detail: `no canonical Surface ${next.id}` }
    // The content path's re-validation, and the same discipline the topology path
    // gets: re-assert the predicates from inside the queue, using the store's own
    // routine rather than a second copy of it. `checkUpsert` IS what
    // `upsertSurface` decides with, so the two cannot answer differently — which
    // is what makes the `onDurable` install below unable to silently refuse.
    // Liveness is checked separately because a record's own revision does not move
    // when an ANCESTOR is deleted, so the durable compare-and-swap cannot see it.
    const precommit = () => {
      const reason = this.surfaces.checkUpsert(next)
        ?? (this.surfaces.recoveryRootFor(next.id) ? 'deleted' as const : undefined)
      return reason ? { ok: false as const, reason } : { ok: true as const }
    }
    if (!this.surfaceSidecar) {
      const rechecked = precommit()
      if (!rechecked.ok) {
        return { committed: false, reason: 'precommit-refused', detail: rechecked.reason }
      }
      return this.memoized(opts.idempotencyKey, opts.fingerprint, [next.id], opts.result, () => {
        const applied = this.surfaces.upsertSurface(next)
        return applied ? [next] : null
      }, `${next.id}: in-memory upsert refused`)
    }
    return this.surfaceSidecar.commit({
      puts: [next],
      expectedRevs: { [next.id]: prior.rev },
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
      ...(opts.result !== undefined ? { result: opts.result } : {}),
      precommit,
      onDurable: () => this.installDurableContent(next),
    })
  }

  /**
   * Install a content record the sidecar has already made durable.
   *
   * The refusal is NOT discarded, and that is the whole point of this method
   * existing. `upsertSurface` equality-short-circuits on a candidate that differs
   * only in `rev`/`amendedAt` — a correct storm guard — so dropping its `false`
   * left the durable revision one ahead of the live one. Every later write to that
   * record then failed its durable compare-and-swap, and the documented recovery
   * ("re-read and retry") re-read the STALE copy and retried forever. The Surface
   * still rendered; it was simply never writable again, until a restart reloaded
   * from the copy that had moved.
   *
   * So a refusal here is a corrupted invariant rather than a no-op. The record is
   * already on disk and disk is the authority, so memory and every connected client
   * are made to agree with it FIRST — leaving the divergence in place would be the
   * bug again — and only then does this raise, so the failure is loud instead of
   * silent. With the pre-commit re-validation above it should be unreachable; if it
   * is ever reached, something moved live state from outside the transaction queue
   * and the stack trace is the only way anyone will find out which.
   */
  private installDurableContent(next: Surface): void {
    if (this.surfaces.upsertSurface(next)) return
    const reason = this.surfaces.checkUpsert(next) ?? 'unknown'
    this.surfaces.reconcileDurable(next)
    throw new Error(
      `[surfaces] durable/in-memory divergence on ${next.id}: the sidecar committed rev ${next.rev} but the ` +
      `in-memory store refused it (${reason}). Memory has been reconciled to the durable record; this is a ` +
      'corrupted invariant, not a no-op.',
    )
  }

  /**
   * Idempotency for the NO-SIDECAR path.
   *
   * Without this, retry safety would silently depend on whether persistence
   * happened to be enabled: the sidecar keeps a receipt, so a retried commit
   * replays, but the in-memory path would have appended the same thread message
   * twice and reported success both times. "A duplicate idempotency key does not
   * duplicate a thread message" is a property of the API, not of a config flag,
   * so the memory-only store keeps its own receipts.
   *
   * They are NOT durable, and that is the honest degradation rather than a gap: a
   * store with no durable home cannot survive a restart at all, so a receipt that
   * outlived one would be describing records that did not.
   */
  private memoized(
    idempotencyKey: string | undefined,
    fingerprint: string | undefined,
    ids: string[],
    result: JsonValue | undefined,
    apply: () => Surface[] | null,
    refusal = 'in-memory mutation refused',
  ): SurfaceCommitResult {
    if (idempotencyKey) {
      const prior = this.lookupSurfaceReceipt(idempotencyKey)
      if (prior) {
        // Same rule as the durable path: a key identifies a retry of ONE request,
        // so a hit with a different fingerprint is refused rather than replayed.
        // Handing back the first call's receipt would report success for work the
        // second call never did — and on a `purge`, for an erase that never ran.
        if (prior.fingerprint !== fingerprint) {
          return { committed: false, reason: 'idempotency-key-reuse', detail: prior.fingerprint ?? 'an earlier request' }
        }
        const records = prior.ids.map(id => this.surfaces.getSurface(id)).filter((s): s is Surface => !!s)
        return {
          committed: true, replayed: true, wrote: false, records,
          ...(prior.result !== undefined ? { result: prior.result } : {}),
        }
      }
    }
    const records = apply()
    if (!records) return { committed: false, reason: 'stale-revision', detail: refusal }
    if (idempotencyKey) {
      this.surfaceMemoReceipts.set(idempotencyKey, {
        key: idempotencyKey,
        at: Date.now(),
        ids,
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        ...(result !== undefined ? { result } : {}),
      })
      // Insertion-ordered eviction, matching the sidecar's CEILING. Expiry is by
      // age (see {@link lookupSurfaceReceipt}); this only bounds the map.
      while (this.surfaceMemoReceipts.size > MAX_MEMO_RECEIPTS) {
        const oldest = this.surfaceMemoReceipts.keys().next().value
        if (oldest === undefined) break
        this.surfaceMemoReceipts.delete(oldest)
      }
    }
    return {
      committed: true, replayed: false, wrote: false, records,
      ...(result !== undefined ? { result } : {}),
    }
  }

  /**
   * The receipt on file for an idempotency key, from whichever half is holding
   * receipts — the sidecar when persistence is attached, the memo table when it is
   * not.
   *
   * The service consults this BEFORE it validates anything, which is what makes a
   * retry of a compare-and-swap operation replay instead of colliding with its own
   * first attempt: the caller's `expectedRev` describes the world before that
   * attempt, so a retry that reaches the revision check is refused for having
   * succeeded. Same for a retry whose target was purged in the meantime — the
   * receipt is on file, and answering `not-found` would be a lie about the
   * transaction the caller is asking about.
   */
  lookupSurfaceReceipt(key: string): SurfaceIdempotencyReceipt | undefined {
    if (this.surfaceSidecar) return this.surfaceSidecar.lookupIdempotency(key)
    const entry = this.surfaceMemoReceipts.get(key)
    if (!entry) return undefined
    return isFresh(entry, Date.now()) ? entry : undefined
  }

  /** Await any fire-and-forget sidecar writes (the lifecycle cascade). */
  async flushSurfacePersistence(): Promise<void> {
    await this.surfaceWriteTail
  }

  /**
   * Fan a canonical batch out to both channels.
   *
   *   · `surface.batch` over SSE — the canonical stream, ordered and atomic;
   *   · a PERSIST-EXEMPT `run` delta per aliased run — the compatibility stream,
   *     so a client still rendering the legacy Run Workspace learns that the run
   *     moved without the canonical mutation dragging a `docstore.json` write
   *     along behind it.
   *
   * The run delta is emitted even when the derived projection is byte-identical,
   * and that is not an oversight. In U1 the derivation still reads the legacy
   * bridge (see {@link deriveRunSlate}), so a canonical-only change produces an
   * identical projection every time — suppressing on equality would mean a
   * canonical mutation was never observable on the run channel at all.
   */
  private onSurfaceBatch(batch: SurfaceBatch): void {
    this.surfaceChanges.emit('batch', batch)
    const runIds = new Set<string>()
    for (const change of batch.changes) {
      for (const alias of change.data.aliases ?? []) {
        if (alias.bucket.kind === 'run') runIds.add(alias.bucket.runId)
      }
    }
    for (const runId of runIds) this.emitDerivedRunSlate(runId)
  }

  /** Publish a run's DERIVED Slate projection without scheduling a core document
   *  write. The projection is recomputed rather than read off the stored run, so
   *  `Run.slate` is derived at projection time exactly as the plan requires; the
   *  stored field is refreshed only when it actually moved, which keeps a later
   *  SSE reconnect snapshot agreeing with the delta clients already saw. */
  private emitDerivedRunSlate(runId: string): void {
    const existing = this.runs.get(runId)
    if (!existing) return
    const derived = this.deriveRunSlate(runId)
    const nextSlate = derived.length > 0 ? derived : undefined
    const changed = JSON.stringify(existing.slate ?? null) !== JSON.stringify(nextSlate ?? null)
    const next: Run = changed ? { ...existing, slate: nextSlate } : existing
    if (changed) this.runs.set(runId, next)
    this.changes.emit('change', { entity: 'run', id: runId, data: next, persistExempt: true })
  }

  /** Durably drop canonical records for the lifecycle cascade. Fire-and-forget
   *  because `clearSpace`/`clear` are synchronous mutators; the promise is kept on
   *  {@link surfaceWriteTail} so nothing is unobservable. A failed drop is logged
   *  rather than swallowed — the records survive in the sidecar and reappear on
   *  the next boot, which is visible but not silent. */
  /** Drop every canonical record matching `doomed`, in memory and on disk. Silent
   *  in-memory (the caller emits one `all` reset), durable on the sidecar. */
  private cascadeSurfaces(doomed: (s: Surface) => boolean): void {
    const ids = this.surfaces.getAllSurfaces().filter(doomed).map(s => s.id)
    if (ids.length === 0) return
    this.surfaces.deleteSilently(ids)
    this.dropSurfacesDurably(ids)
  }

  private dropSurfacesDurably(ids: string[]): void {
    const sidecar = this.surfaceSidecar
    if (!sidecar || ids.length === 0) return
    // Only ids the sidecar actually holds: a `drop` naming an unpersisted record
    // rejects the WHOLE transaction, which would leave every other doomed record
    // durable and resurrect them all on the next boot.
    const durable = new Set(sidecar.durableRecords().map(r => r.id))
    ids = ids.filter(id => durable.has(id))
    if (ids.length === 0) return
    this.surfaceWriteTail = this.surfaceWriteTail
      .then(() => sidecar.commit({ drops: ids }))
      .then(result => {
        if (!result.committed) {
          console.warn(`[surfaces] cascade drop of ${ids.length} record(s) failed: ${result.reason}`)
        }
      })
      .catch(err => { console.warn(`[surfaces] cascade drop threw: ${(err as Error).message}`) })
  }

  // --- Snapshot (filtered by active space) ---
  // Include entities that match the active space OR have no spaceId (homeless).
  // This ensures nothing silently vanishes from the UI.

  snapshot() {
    const sid = this.activeSpaceId
    const inSpace = (e: { spaceId?: string }) => !sid || !e.spaceId || e.spaceId === sid
    return {
      activeSpaceId: sid,
      spaces: this.getAllSpaces(),
      initiatives: this.getAllInitiatives().filter(inSpace),
      epics: this.getAllEpics().filter(inSpace),
      tasks: this.getAllTasks().filter(inSpace),
      worktrees: this.getAllWorktrees().filter(inSpace),
      runs: this.getAllRuns().filter(inSpace),
      editorWidgets: this.getAllEditorWidgets().filter(inSpace),
      browserWidgets: this.getAllBrowserWidgets().filter(inSpace),
      imageWidgets: this.getAllImageWidgets().filter(inSpace),
      pluginWidgets: this.getAllPluginWidgets().filter(inSpace),
      constellationGraphs: this.getAllConstellationGraphs().filter(inSpace),
      pinSets: this.getAllPinSets().filter(inSpace),
      topicMetadata: this.getAllTopicMetadata(),
      // Run-scoped with no spaceId of their own, so there's nothing to filter
      // on — include them all (space membership rides the notice's run).
      notices: this.getAllNotices(),
      // Canonical Surfaces (U1). Space-scoped by a required field, so the
      // homeless-entity allowance above does not apply. Empty on a faulted boot
      // by construction: the boot path never loads records into the store, so
      // canonical projection stays EMPTY rather than partial.
      surfaces: sid ? this.getSurfacesForSpace(sid) : this.getAllSurfaces(),
      surfaceHealth: this.surfaceStatus,
    }
  }

  /** Full unfiltered snapshot for disk persistence */
  private snapshotAll() {
    return {
      activeSpaceId: this.activeSpaceId,
      spaces: this.getAllSpaces(),
      initiatives: this.getAllInitiatives(),
      epics: this.getAllEpics(),
      tasks: this.getAllTasks(),
      worktrees: this.getAllWorktrees(),
      runs: this.getAllRuns(),
      commits: this.getAllCommits(),
      editorWidgets: this.getAllEditorWidgets(),
      browserWidgets: this.getAllBrowserWidgets(),
      artifacts: this.getAllArtifacts(),
      imageWidgets: this.getAllImageWidgets(),
      pluginWidgets: this.getAllPluginWidgets(),
      constellationGraphs: this.getAllConstellationGraphs(),
      pinSets: this.getAllPinSets(),
      topicMetadata: this.getAllTopicMetadata(),
      graveyard: this.getAllTombstones(),
      notices: this.getAllNotices(),
      slatePoints: this.slate.getAllPoints(),
    }
  }

  // --- Space-scoped clear ---

  /** Clear all entities in a specific space */
  clearSpace(spaceId: string): void {
    for (const [id, e] of this.initiatives) if (e.spaceId === spaceId) this.initiatives.delete(id)
    for (const [id, e] of this.epics) if (e.spaceId === spaceId) this.epics.delete(id)
    for (const [id, e] of this.tasks) if (e.spaceId === spaceId) this.tasks.delete(id)
    for (const [id, e] of this.worktrees) if (e.spaceId === spaceId) this.worktrees.delete(id)
    const clearedRunIds = new Set<string>()
    for (const [id, e] of this.runs) if (e.spaceId === spaceId) { this.runs.delete(id); clearedRunIds.add(id) }
    // Notices carry no spaceId — drop them by ownership of a run cleared above,
    // else a notice orphans and lingers in getAllNotices()/snapshots (R20).
    for (const [id, n] of this.notices) if (clearedRunIds.has(n.runId)) this.notices.delete(id)
    // Slate points are run-scoped with no spaceId — drop them by ownership of a
    // cleared run (silent; the `all` reset below tells clients to resync).
    this.slate.deleteRunsSilently(clearedRunIds)
    // Canonical Surfaces cascade on BOTH coordinates. By space is the obvious
    // half. By cleared run is the half that is easy to miss and expensive to get
    // wrong: a run's Surfaces carry a run compatibility alias but live in
    // whatever space they were migrated into — including the synthetic
    // space-less bucket — so a space-only sweep leaves them alive for a run that
    // no longer exists, reachable only through the workspace recovery bucket.
    this.cascadeSurfaces(s => s.spaceId === spaceId
      || (s.aliases ?? []).some(a => a.bucket.kind === 'run' && clearedRunIds.has(a.bucket.runId)))
    for (const [id, e] of this.editorWidgets) if (e.spaceId === spaceId) this.editorWidgets.delete(id)
    const clearedBrowserIds = new Set<string>()
    for (const [id, e] of this.browserWidgets) if (e.spaceId === spaceId) { this.browserWidgets.delete(id); clearedBrowserIds.add(id) }
    // Artifact.spaceId is optional, so a widget-owned artifact may have only widgetId.
    // Delete by spaceId OR by ownership of a browser widget cleared above, else the
    // persisted HTML orphans and stays servable from /api/artifacts/:id.
    for (const [id, e] of this.artifacts) {
      if (e.spaceId === spaceId || (e.widgetId !== undefined && clearedBrowserIds.has(e.widgetId))) this.artifacts.delete(id)
    }
    for (const [id, e] of this.imageWidgets) if (e.spaceId === spaceId) this.imageWidgets.delete(id)
    for (const [id, e] of this.pluginWidgets) if (e.spaceId === spaceId) this.pluginWidgets.delete(id)
    this.constellationGraphs.delete(spaceId)
    this.pinSets.delete(spaceId)
    this.changes.emit('change', { entity: 'all', id: '*', data: null })
  }

  // --- Reset (active space only) ---

  clear(): void {
    const sid = this.activeSpaceId
    if (sid) {
      this.clearSpace(sid)
    } else {
      this.initiatives.clear()
      this.epics.clear()
      this.tasks.clear()
      this.worktrees.clear()
      this.runs.clear()
      this.editorWidgets.clear()
      this.browserWidgets.clear()
      this.artifacts.clear()
      this.imageWidgets.clear()
      this.constellationGraphs.clear()
      this.pinSets.clear()
      this.notices.clear()
      this.slate.clearAll()
      // Same cascade as clearSpace, whole-store: `clearAll` is the no-active-space
      // branch, so everything canonical goes with it. This is the branch FAST_SIM
      // boot takes before seeding the simulator space.
      this.cascadeSurfaces(() => true)
      // commits are append-only and intentionally preserved
      this.changes.emit('change', { entity: 'all', id: '*', data: null })
    }
  }
}
