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
      for (const init of initiatives) this.store.upsertInitiative(init.id, init)
      for (const epic of epics) this.store.upsertEpic(epic.id, epic)
      for (const task of tasks) this.store.upsertTask(task.id, task)
      for (const wt of worktrees) this.store.upsertWorktree(wt.id, wt)
    })

    this.bus.on('run.created', (e) => {
      const p = e.payload
      const run: Run = {
        id: p.id,
        status: p.status,
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
        procedures: [],
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

    this.bus.on('run.procedure_updated', (e) => {
      this.store.upsertProcedure(e.payload.runId, e.payload.procedure)
    })

    this.bus.on('run.recap_added', (e) => {
      this.store.addRecapEntry(e.payload.runId, e.payload.entry)
    })
  }
}
