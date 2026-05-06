import { mockInitiatives, mockEpics, mockTasks, mockWorktrees, mockRuns } from '../../domain/mock-data'
import type { BusEvent } from '../types'

interface TimedEvent {
  delayMs: number
  event: BusEvent
}

export function buildEventSequence(): TimedEvent[] {
  const events: TimedEvent[] = []
  const now = () => new Date().toISOString()

  // t=0: Taxonomy sync (everything at once)
  events.push({
    delayMs: 0,
    event: {
      type: 'taxonomy.sync',
      timestamp: now(),
      payload: {
        initiatives: mockInitiatives,
        epics: mockEpics,
        tasks: mockTasks,
        worktrees: mockWorktrees,
      },
    },
  })

  // Stagger 14 runs over ~10 seconds
  const totalDurationMs = 10_000
  const runCount = mockRuns.length
  const intervalMs = totalDurationMs / runCount // ~714ms per run

  for (let i = 0; i < runCount; i++) {
    const run = mockRuns[i]!

    const baseDelay = Math.round(intervalMs * (i + 0.5)) // start at ~357ms

    // run.created event
    events.push({
      delayMs: baseDelay,
      event: {
        type: 'run.created',
        timestamp: now(),
        payload: {
          id: run.id,
          status: run.status,
          sessionId: run.sessionId,
          initiative: run.initiative,
          epic: run.epic,
          task: run.task,
          repo: run.repo,
          worktree: run.worktree,
          taskId: run.taskId,
          worktreeId: run.worktreeId,
          createdAt: run.createdAt,
        },
      },
    })

    // Files trickle in shortly after run creation
    for (let f = 0; f < run.touchedFiles.length; f++) {
      events.push({
        delayMs: baseDelay + 50 + f * 30,
        event: {
          type: 'run.file_touched',
          timestamp: now(),
          payload: {
            runId: run.id,
            file: run.touchedFiles[f]!,
          },
        },
      })
    }

    // Recap entries come after files
    const filesDone = baseDelay + 50 + run.touchedFiles.length * 30
    const recapStart = filesDone + 20
    for (let r = 0; r < run.recapEntries.length; r++) {
      events.push({
        delayMs: recapStart + 15 + r * 20,
        event: {
          type: 'run.recap_added',
          timestamp: now(),
          payload: {
            runId: run.id,
            entry: run.recapEntries[r]!,
          },
        },
      })
    }
  }

  // Seed the ready queue with idle session IDs
  const idleSessions = mockRuns
    .filter(r => r.status === 'idle' && r.sessionId)
    .map(r => r.sessionId as string)
  if (idleSessions.length > 0) {
    events.push({
      delayMs: 0,
      event: {
        type: 'ready_queue.update',
        timestamp: now(),
        payload: { queue: idleSessions },
      },
    })
  }

  // Sort by delay
  events.sort((a, b) => a.delayMs - b.delayMs)

  return events
}
