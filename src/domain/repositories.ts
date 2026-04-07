import type { Run, Initiative, Epic, Task, Worktree, RunStatus, GroupingDimension } from './types'
import { mockInitiatives, mockEpics, mockTasks, mockWorktrees, mockRuns } from './mock-data'

// --- RunRepository ---

export class RunRepository {
  private runs: Run[]

  constructor(runs: Run[] = mockRuns) {
    this.runs = runs
  }

  getAll(): Run[] {
    return this.runs
  }

  getById(id: string): Run | undefined {
    return this.runs.find(r => r.id === id)
  }

  getByTask(taskId: string): Run[] {
    return this.runs.filter(r => r.taskId === taskId)
  }

  getByWorktree(worktreeId: string): Run[] {
    return this.runs.filter(r => r.worktreeId === worktreeId)
  }

  getByStatus(status: RunStatus): Run[] {
    return this.runs.filter(r => r.status === status)
  }
}

// --- TaxonomyRepository ---

export class TaxonomyRepository {
  private initiatives: Initiative[]
  private epics: Epic[]
  private tasks: Task[]
  private worktrees: Worktree[]

  constructor(
    initiatives: Initiative[] = mockInitiatives,
    epics: Epic[] = mockEpics,
    tasks: Task[] = mockTasks,
    worktrees: Worktree[] = mockWorktrees,
  ) {
    this.initiatives = initiatives
    this.epics = epics
    this.tasks = tasks
    this.worktrees = worktrees
  }

  getInitiatives(): Initiative[] {
    return this.initiatives
  }

  getEpics(): Epic[] {
    return this.epics
  }

  getTasks(): Task[] {
    return this.tasks
  }

  getWorktrees(): Worktree[] {
    return this.worktrees
  }

  getInitiativeById(id: string): Initiative | undefined {
    return this.initiatives.find(i => i.id === id)
  }

  getEpicById(id: string): Epic | undefined {
    return this.epics.find(e => e.id === id)
  }

  getTaskById(id: string): Task | undefined {
    return this.tasks.find(t => t.id === id)
  }

  getWorktreeById(id: string): Worktree | undefined {
    return this.worktrees.find(w => w.id === id)
  }

  /** Get the initiative for a run by traversing task → epic → initiative, or direct lookup */
  getInitiativeForRun(run: Run): Initiative | undefined {
    const task = this.tasks.find(t => t.id === run.taskId)
    if (task) {
      if (task.initiativeId) {
        const direct = this.initiatives.find(i => i.id === task.initiativeId)
        if (direct) return direct
      }
      // Fall back to initiative via epic chain (task has epicId but no initiativeId)
      if (task.epicId) {
        const epic = this.epics.find(e => e.id === task.epicId)
        if (epic?.initiativeId) {
          return this.initiatives.find(i => i.id === epic.initiativeId)
        }
      }
    }
    // No task — check run's direct initiative field (for epic-level runs)
    if (run.initiative) {
      return this.initiatives.find(i => i.id === run.initiative || i.name === run.initiative)
    }
    return undefined
  }

  /** Get the epic for a run by traversing task → epic, or direct lookup */
  getEpicForRun(run: Run): Epic | undefined {
    const task = this.tasks.find(t => t.id === run.taskId)
    if (task) {
      return this.epics.find(e => e.id === task.epicId)
    }
    // No task — check run's direct epic field (for epic-level runs)
    if (run.epic) {
      return this.epics.find(e => e.id === run.epic || e.name === run.epic)
    }
    return undefined
  }

  /** Get the task for a run */
  getTaskForRun(run: Run): Task | undefined {
    return this.tasks.find(t => t.id === run.taskId)
  }

  /** Get the worktree for a run */
  getWorktreeForRun(run: Run): Worktree | undefined {
    return this.worktrees.find(w => w.id === run.worktreeId)
  }

  /** Get epics belonging to an initiative */
  getEpicsByInitiative(initiativeId: string): Epic[] {
    return this.epics.filter(e => e.initiativeId === initiativeId)
  }

  /** Get tasks belonging to an epic */
  getTasksByEpic(epicId: string): Task[] {
    return this.tasks.filter(t => t.epicId === epicId)
  }

  /** Resolve a dimension value for a run */
  resolveDimension(run: Run, dimension: GroupingDimension): { id: string; label: string; color?: string } | undefined {
    switch (dimension) {
      case 'initiative': {
        const initiative = this.getInitiativeForRun(run)
        return initiative ? { id: initiative.id, label: initiative.name, color: initiative.settings?.defaultRunColor ?? initiative.color } : undefined
      }
      case 'epic': {
        const epic = this.getEpicForRun(run)
        return epic ? { id: epic.id, label: epic.name, color: epic.settings?.defaultRunColor } : undefined
      }
      case 'task': {
        const task = this.getTaskForRun(run)
        return task ? { id: task.id, label: task.name, color: task.settings?.defaultRunColor } : undefined
      }
      case 'worktree': {
        const worktree = this.getWorktreeForRun(run)
        return worktree ? { id: worktree.id, label: worktree.name } : undefined
      }
    }
  }
}
