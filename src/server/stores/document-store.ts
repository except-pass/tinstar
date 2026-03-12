import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Initiative, Epic, Task, Worktree, Run } from '../../domain/types'
import type { RunStatus, TouchedFile, Procedure, RecapEntry } from '../../types'

export class DocumentStore {
  private initiatives = new Map<string, Initiative>()
  private epics = new Map<string, Epic>()
  private tasks = new Map<string, Task>()
  private worktrees = new Map<string, Worktree>()
  private runs = new Map<string, Run>()

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
      if (data.initiatives) for (const i of data.initiatives) this.initiatives.set(i.id, i)
      if (data.epics) for (const e of data.epics) this.epics.set(e.id, e)
      if (data.tasks) for (const t of data.tasks) this.tasks.set(t.id, t)
      if (data.worktrees) for (const w of data.worktrees) this.worktrees.set(w.id, w)
      if (data.runs) for (const r of data.runs) this.runs.set(r.id, r)
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
      writeFileSync(this.persistPath, JSON.stringify(this.snapshot(), null, 2))
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

  upsertProcedure(runId: string, procedure: Procedure): void {
    const run = this.runs.get(runId)
    if (!run) return
    const idx = run.procedures.findIndex(p => p.id === procedure.id)
    if (idx >= 0) {
      run.procedures[idx] = procedure
    } else {
      run.procedures.push(procedure)
    }
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

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
    run.touchedFiles.push(file)
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

  reconcileFiles(runId: string, files: TouchedFile[]): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.touchedFiles = files
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.status = status
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

  // --- Snapshot ---

  snapshot() {
    return {
      initiatives: this.getAllInitiatives(),
      epics: this.getAllEpics(),
      tasks: this.getAllTasks(),
      worktrees: this.getAllWorktrees(),
      runs: this.getAllRuns(),
    }
  }

  // --- Reset ---

  clear(): void {
    this.initiatives.clear()
    this.epics.clear()
    this.tasks.clear()
    this.worktrees.clear()
    this.runs.clear()
    this.changes.emit('change', { entity: 'all', id: '*', data: null })
  }
}
