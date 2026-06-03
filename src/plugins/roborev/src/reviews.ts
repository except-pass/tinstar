/** Row shape the accessory renders (mirrors the server `RoborevReview` subset). */
export interface Review {
  id: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  verdict: string | null
  closed: boolean
  commit_subject: string
  branch: string
  repo_path: string
  finished_at: string | null
}

export type ReviewAction = 'close' | 'reopen' | 'comment'

/** Open reviews first, then by id descending (newest first within a group). */
export function sortReviews(reviews: Review[]): Review[] {
  return [...reviews].sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1
    return b.id - a.id
  })
}

/** Minimal slice of host state the resolver needs. */
interface StateSlice {
  runs?: Record<string, { id: string; worktree?: string; repo?: string }>
}

/** Resolve the repo path the cockpit filters/acts on:
 *  explicit widget data > the cockpit session's worktree path > null. */
export function resolveRepoPath(
  state: StateSlice,
  sessionId: string,
  explicit: string | undefined,
): string | null {
  if (explicit) return explicit
  const run = state.runs?.[sessionId]
  return run?.worktree || run?.repo || null
}

/** Optimistic local update for an action before the server/stream confirms. */
export function applyOptimisticAction(reviews: Review[], jobId: number, action: ReviewAction): Review[] {
  if (action === 'comment') return reviews
  return reviews.map((r) =>
    r.id === jobId ? { ...r, closed: action === 'close' } : r,
  )
}
