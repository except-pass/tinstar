import type { Run } from '../domain/types'
import { buildObjectiveSurface, hasCanonicalObjective } from '../slate/objective'

export type WorktreeMode = 'none' | 'new' | 'existing'

export interface OptimisticSessionIntent {
  id: string
  prompt?: string
  color?: string
  project?: string
  worktree?: string
  taskId?: string
  epicId?: string
  initiativeId?: string
  worktreeMode?: WorktreeMode
  worktreePath?: string
  view?: string
}

/**
 * Build the client-side run shown while POST /api/sessions provisions the real
 * session. The server's eventual run delta uses the same id and replaces this
 * projection in-place, so canvas placement and selection remain stable.
 */
export function buildOptimisticSessionRun(
  intent: OptimisticSessionIntent,
  spaceId?: string,
  createdAt = new Date().toISOString(),
): Run {
  const usesNewWorktree = intent.worktreeMode === 'new'
  const prompt = intent.prompt?.trim()
  return {
    id: intent.id,
    color: intent.color,
    status: 'creating',
    background: false,
    blocked: false,
    sessionId: intent.id,
    scope: {
      ...(intent.project ? { project: intent.project } : {}),
      ...(intent.project && intent.worktree ? { worktree: intent.worktree } : {}),
    },
    taskId: intent.taskId ?? '',
    worktreeId: usesNewWorktree ? intent.id : '',
    createdAt,
    spaceId,
    initiative: intent.initiativeId ?? '',
    epic: intent.epicId ?? '',
    task: intent.taskId ?? '',
    repo: intent.project ?? '',
    worktree: intent.worktree ?? (usesNewWorktree ? intent.id : ''),
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: null,
    backend: null,
    backendInfo: 'Session provisioning…',
    view: intent.view,
    ...(prompt ? { slate: [buildObjectiveSurface(prompt, createdAt)] } : {}),
  }
}

/** Keep a rejected optimistic launch inspectable instead of deleting the card. */
export function markOptimisticSessionFailed(
  run: Run,
  message: string,
  failedAt = new Date().toISOString(),
): Run {
  const content = `Session creation failed: ${message}`
  return {
    ...run,
    status: 'needs_attention',
    blocked: true,
    backendInfo: content,
    recapEntries: [
      ...run.recapEntries,
      {
        id: `session-create-failed-${failedAt}`,
        type: 'status',
        content,
        timestamp: failedAt,
      },
    ],
    rawLogs: run.rawLogs ? `${run.rawLogs}\n${content}` : content,
  }
}

/**
 * Resolve a failed HTTP create against the latest SSE state. A response can be
 * lost after the server has already launched and published the real run; in
 * that case the transport failure must not paint the live session as failed.
 */
export function reconcileOptimisticSessionFailure(
  current: Run | undefined,
  intent: OptimisticSessionIntent,
  message: string,
  spaceId?: string,
  failedAt = new Date().toISOString(),
): Run | null {
  if (current?.backend) return null
  return markOptimisticSessionFailed(
    current ?? buildOptimisticSessionRun(intent, spaceId, failedAt),
    message,
    failedAt,
  )
}

/**
 * Keep client-only session projections across an SSE reconnect snapshot. A real
 * backend run always wins once it arrives; until then the optimistic run owns
 * the id so a stale/empty snapshot cannot make the new workspace disappear.
 */
export function mergeOptimisticSessionRuns(
  serverRuns: readonly Run[],
  optimisticRuns: readonly Run[],
): Run[] {
  const merged = new Map(optimisticRuns.map(run => [run.id, run]))
  for (const serverRun of serverRuns) {
    const optimistic = merged.get(serverRun.id)
    if (!optimistic) { merged.set(serverRun.id, serverRun); continue }
    const optimisticObjective = optimistic.slate?.find(surface => surface.kind === 'objective')
    if (optimisticObjective && !hasCanonicalObjective(serverRun)) {
      merged.set(serverRun.id, {
        ...serverRun,
        slate: [optimisticObjective, ...(serverRun.slate ?? [])],
      })
      continue
    }
    if (serverRun.backend) merged.set(serverRun.id, serverRun)
  }
  return [...merged.values()]
}
