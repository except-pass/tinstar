import type { EventBus } from '../event-bus'
import type { DocumentStore } from '../stores/document-store'
import type { Run } from '../../domain/types'

export class DocumentProcessor {
  constructor(
    private bus: EventBus,
    private store: DocumentStore,
  ) {
    this.bind()
  }

  private bind(): void {
    this.bus.on('taxonomy.sync', (e) => {
      const { initiatives, epics, tasks, worktrees } = e.payload
      const spaceId = this.store.activeSpaceId
      for (const init of initiatives) this.store.upsertInitiative(init.id, { ...init, spaceId })
      for (const epic of epics) this.store.upsertEpic(epic.id, { ...epic, spaceId })
      for (const task of tasks) this.store.upsertTask(task.id, { ...task, spaceId })
      for (const wt of worktrees) this.store.upsertWorktree(wt.id, { ...wt, spaceId })
    })

    this.bus.on('run.created', (e) => {
      const p = e.payload
      const run: Run = {
        id: p.id,
        status: p.status,
        background: false,
        blocked: false,
        sessionId: p.sessionId,
        initiative: p.initiative,
        epic: p.epic,
        task: p.task,
        repo: p.repo,
        worktree: p.worktree,
        taskId: p.taskId,
        worktreeId: p.worktreeId,
        createdAt: p.createdAt,
        touchedFiles: [],
        recapEntries: [],
        rawLogs: '',
        port: null,
        backend: null,
        spaceId: this.store.activeSpaceId,
      }
      this.store.upsertRun(run.id, run)
    })

    this.bus.on('run.updated', (e) => {
      this.store.updateRunStatus(e.payload.id, e.payload.status)
    })

    this.bus.on('run.completed', (e) => {
      this.store.updateRunStatus(e.payload.id, e.payload.status)
    })

    this.bus.on('run.file_touched', (e) => {
      this.store.addFileTouched(e.payload.runId, e.payload.file)
    })

    this.bus.on('run.recap_added', (e) => {
      this.store.addRecapEntry(e.payload.runId, e.payload.entry)
    })
  }
}
