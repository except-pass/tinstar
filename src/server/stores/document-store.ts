import { EventEmitter } from 'node:events'
import type { Initiative, Epic, Task, Worktree, Run } from '../../domain/types'
import type { RunStatus, TouchedFile, Procedure, RecapEntry } from '../../types'

export class DocumentStore {
  private initiatives = new Map<string, Initiative>()
  private epics = new Map<string, Epic>()
  private tasks = new Map<string, Task>()
  private worktrees = new Map<string, Worktree>()
  private runs = new Map<string, Run>()

  readonly changes = new EventEmitter()

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
    this.runs.delete(id)
    this.changes.emit('change', { entity: 'run', id, data: null })
  }

  // --- Run mutations (partial updates that emit changes) ---

  addFileTouched(runId: string, file: TouchedFile): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.touchedFiles.push(file)
    this.changes.emit('change', { entity: 'run', id: runId, data: run })
  }

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
