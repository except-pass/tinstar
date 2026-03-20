import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Initiative, Epic, Task, Worktree, Run, Space, EditorWidget, BrowserWidget } from '../../domain/types'
import type { CommitRecord } from '../commits'
import type { RunStatus, TouchedFile, RecapEntry } from '../../types'

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
      if (data.runs) for (const r of data.runs) this.runs.set(r.id, r)
      if (data.commits) for (const c of data.commits) this.commits.set(c.sha, c)
      if (data.editorWidgets) for (const w of data.editorWidgets) this.editorWidgets.set(w.id, w)
      if (data.browserWidgets) for (const w of data.browserWidgets) this.browserWidgets.set(w.id, w)
    } catch {
      // No file or corrupt — start fresh
    }

    // Debounced save on every change
    this.changes.on('change', () => this.schedulePersist())
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
      return
    }
    // Simulator runs are keyed by run id (R-xxx) but deleted by session name (CLD-xxx)
    for (const [key, run] of this.runs) {
      if (run.sessionId === id) {
        this.runs.delete(key)
        this.changes.emit('change', { entity: 'run', id: key, data: null })
        return
      }
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

    run.touchedFiles = [...gitFiles, ...readOnlyCarry]
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.status = status
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
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
  }

  getAllBrowserWidgets(): BrowserWidget[] {
    return [...this.browserWidgets.values()]
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
    }
  }

  // --- Space-scoped clear ---

  /** Clear all entities in a specific space */
  clearSpace(spaceId: string): void {
    for (const [id, e] of this.initiatives) if (e.spaceId === spaceId) this.initiatives.delete(id)
    for (const [id, e] of this.epics) if (e.spaceId === spaceId) this.epics.delete(id)
    for (const [id, e] of this.tasks) if (e.spaceId === spaceId) this.tasks.delete(id)
    for (const [id, e] of this.worktrees) if (e.spaceId === spaceId) this.worktrees.delete(id)
    for (const [id, e] of this.runs) if (e.spaceId === spaceId) this.runs.delete(id)
    for (const [id, e] of this.editorWidgets) if (e.spaceId === spaceId) this.editorWidgets.delete(id)
    for (const [id, e] of this.browserWidgets) if (e.spaceId === spaceId) this.browserWidgets.delete(id)
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
      // commits are append-only and intentionally preserved
      this.changes.emit('change', { entity: 'all', id: '*', data: null })
    }
  }
}
