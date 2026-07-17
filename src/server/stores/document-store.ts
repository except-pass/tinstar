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
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget, ImageWidget, TopicMetadata, PluginWidgetInstance, AttentionState, SessionStatus, Artifact, Tombstone, Notice } from '../../domain/types'
import type { CommitRecord } from '../commits'
import type { RunStatus, TouchedFile, RecapEntry } from '../../types'
import type { ConstellationGraph } from '../../domain/constellationGraph'
import { migrateSnapEdges } from '../../domain/constellationGraph'
import { type PinSet, removePinsForNode } from '../../domain/pinSet'
import { migrateAllBrowserNotes } from '../migrations/migrateAllBrowserNotes'

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
    a.createdAt === b.createdAt &&
    a.amendedAt === b.amendedAt
  )
}

function tombstoneEqual(a: Tombstone, b: Tombstone): boolean {
  return (
    a.convId === b.convId &&
    a.sessionName === b.sessionName &&
    a.coversSummary === b.coversSummary &&
    a.taskId === b.taskId &&
    a.task === b.task &&
    a.epic === b.epic &&
    a.initiative === b.initiative &&
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
    } catch {
      // No file or corrupt — start fresh
    }

    // Debounced save on every change
    this.changes.on('change', () => this.schedulePersist())

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
    const prev = this.runs.get(id)
    if (prev && runShallowEqual(prev, data)) return
    this.runs.set(id, data)
    this.changes.emit('change', { entity: 'run', id, data })
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
    run.recapEntries.push(entry)
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
      // commits are append-only and intentionally preserved
      this.changes.emit('change', { entity: 'all', id: '*', data: null })
    }
  }
}
